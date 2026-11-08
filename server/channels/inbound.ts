// One inbound path for every channel. Each platform turns what arrives into ChannelItems and hands them to `receive`
// on the channel that hosts the person's Kenaznia. There, each item's channel mode decides: straight to Kenaznia
// (direct, or addressed to it), through the Haiku watcher (filtered), context only, or dropped (off).
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import type { Addressed } from '../agents/addressed.js';
import { routeBackground } from '../agents/origin.js';
import type { PersonConfig } from '../config.js';
import type { Deps } from '../types.js';
import type { Mode, Platform } from './address.js';
import { modeFor } from './settings.js';
import { relay } from './rooms.js';

/** One message as Kenaznia and the watcher see it, whatever platform it came from. */
export interface ChannelItem {
  /** `${source}:${the platform's own id}`, unique across platforms. */
  id: string;
  source: Platform;
  /** The channel to answer on with send (kenan:CHAT, signal:…, discord:…, mail:…, texts:…). */
  channel: string;
  /** The message to quote or thread under when answering (send replyTo), or null. */
  replyTo: string | null;
  at: number;
  /** The sender as shown. */
  from: string;
  /** The sender's person id here when the sender is a person of this host (a Kenan chat member), else null. */
  fromId: string | null;
  /** Where it was said: "ResearchCo #investors", "direct", "group Example group", "to person40@example.com", "chat “Pricing”". */
  where: string;
  /** Items with the same thread are each other's context. */
  thread: string;
  subject: string | null;
  text: string;
  /** How to open or read more of it (a tool call), or null when the item is all there is. */
  open: string | null;
  /** Context for later judgements, never passed on itself: the person's own messages, the bot's, history seeded on first sight. */
  contextOnly: boolean;
  /** Kenan chats: why the message is addressed to this person's Kenaznia, or null when it isn't. */
  addressed?: Addressed | null;
  /** Kenan chats: what people said there since this Kenaznia last wrote, as "Name: text" lines. */
  earlier?: string[];
  /** Kenan chats: the files the message and the earlier lines carry, as stored where the chat lives. `receive` gives the
   *  person their own copy when the chat lives on another channel, so every file here is readable at its path. */
  files?: ChannelFile[];
}
export interface ChannelFile { id: string; name: string; mime: string; path: string }
export const fileLines = (files: readonly ChannelFile[]) => files.map(f => `Attached file: ${f.name} (${f.mime}), path: ${f.path}`);

export type Routing = 'direct' | 'filtered' | 'context' | 'off';
/** What a channel mode does with an item. Addressed means: only what is addressed to Kenaznia reaches it, straight. */
export function routing(mode: Mode, item: Pick<ChannelItem, 'contextOnly' | 'addressed'>): Routing {
  if (item.contextOnly) return 'context';
  switch (mode) {
    case 'off': return 'off';
    case 'addressed': return item.addressed ? 'direct' : 'context';
    case 'filtered': return item.addressed ? 'direct' : 'filtered';
    case 'direct': return 'direct';
  }
}

export const platformLabel = (p: Platform): string => ({ kenan: 'Kenan chat', signal: 'Signal', discord: 'Discord', mail: 'Mail', texts: 'Texts' })[p];

/** How Kenaznia may answer an item. Alice's Signal rule: Kenan answers on Signal only about Business. */
export function answerLine(m: Pick<ChannelItem, 'source' | 'channel' | 'replyTo' | 'open'>, Business: boolean | null): string {
  const open = m.open ? `${m.open} ` : '';
  const send = `use send to "${m.channel}"${m.replyTo ? ` (replyTo "${m.replyTo}")` : ''}`;
  if (m.source !== 'signal' || m.channel.startsWith('signal-kenan:')) return `${open}To answer there, ${send}.`;
  if (Business === true) return `Business: yours to answer on Signal. ${open}To answer, ${send} with Business: true.`;
  if (Business === false) return `Not Business: read and handle it or tell Alice, but don't reply on Signal. ${open}`.trim();
  return `${open}On Signal you answer only about Business (send with Business: true); anything else, handle it another way or tell the person.`;
}

/** The input Kenaznia gets for an item that reaches it straight: a short visible line, and how to answer. */
export function directInput(person: Pick<PersonConfig, 'name'>, item: ChannelItem): { text: string; where: string } {
  const head = `${platformLabel(item.source)} · ${item.where} · ${item.from}${item.subject ? ` · “${item.subject}”` : ''}`;
  const why = item.addressed === 'reply' ? 'it replies to one of your messages' : item.addressed === 'mention' ? 'it mentions you' : item.addressed === 'everyone' ? 'it asks everyone' : 'that channel reaches you directly';
  const earlier = item.earlier?.length ? ` Said there since you last wrote, not addressed to you:\n${item.earlier.join('\n')}\n` : ' ';
  const where = `This message came from the channel ${item.channel} (${item.where}), and it reached you because ${why}. You are not in that conversation: what you write here is shown only to ${person.name}, in your own chat.${earlier}${answerLine(item, null)} If it needs nothing from you, answer exactly NO_REPLY.`;
  return { text: `${head}\n${item.text}`, where };
}

/** A platform's way of telling the sender at once that their message was seen (a Discord reaction): never an answer, never a promise. */
export type Acknowledger = (item: ChannelItem) => Promise<void>;
const acknowledgers = new Map<string, Acknowledger>();
export const ACK_BUDGET_MS = 2000;
export function registerAcknowledger(personId: string, platform: Platform, ack: Acknowledger | null): void { if (ack) acknowledgers.set(`${personId}:${platform}`, ack); else acknowledgers.delete(`${personId}:${platform}`); }
/** Acknowledges an item that reached a Kenaznia that is mid-turn, so its sender is not left wondering. A failure is logged and never delays delivery. */
export async function acknowledgeBusy(deps: Deps, person: Pick<PersonConfig, 'id'>, agentId: string, item: ChannelItem): Promise<boolean> {
  const ack = acknowledgers.get(`${person.id}:${item.source}`);
  if (!ack || item.contextOnly || deps.runtime.turnOf(agentId) === null) return false;
  try {
    await Promise.race([ack(item), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no acknowledgement within ${ACK_BUDGET_MS} ms`)), ACK_BUDGET_MS).unref())]);
    return true;
  } catch (e) { await deps.store.logError(`channels:${person.id}`, `acknowledging ${item.id} failed: ${e}`).catch(() => {}); return false; }
}

/** Puts the item in front of the person's Kenaznia now, in its own chat; false when their Kenaznia isn't on this channel. */
export async function deliverDirect(deps: Deps, person: PersonConfig, item: ChannelItem): Promise<boolean> {
  const managerId = deps.runtime.managerFor(person.id);
  const agent = managerId ? await deps.store.getAgent(managerId) : null;
  if (!agent) return false;
  void acknowledgeBusy(deps, person, agent.id, item);
  const route = await routeBackground(deps, agent, null);
  const { text, where } = directInput(person, item);
  await deps.runtime.deliver({ agentId: agent.id, kind: 'channel', fromId: item.fromId ?? agent.id, conversationId: route.conversationId, ...(route.chatBound ? { chatBound: true as const } : {}), where, text, ...(item.files?.length ? { fileIds: item.files.map(f => f.id) } : {}) });
  return true;
}

/** An item's files as this channel stores them: one held here stays as it is; one from the other channel's store becomes
 *  the person's own copy here (made once, found again by its path), so the app shows it and Kenaznia can attach it. */
async function adoptFiles(deps: Deps, person: PersonConfig, item: ChannelItem, linked: boolean): Promise<ChannelItem> {
  const files = await Promise.all(item.files!.map(async (f): Promise<ChannelFile> => {
    const local = await deps.store.getFile(f.id);
    if (local) return { id: local.id, name: local.name, mime: local.mime, path: local.path };
    const path = join(deps.config.dataDir, 'files', `${f.id}.${person.id}`);
    const held = await deps.store.fileAt(person.id, path);
    if (held) return { id: held.id, name: held.name, mime: held.mime, path };
    await mkdir(dirname(path), { recursive: true });
    if (linked) {
      const response = await relay(deps, person.id, 'GET', `/api/files/${encodeURIComponent(f.id)}`, {}, null);
      if (!response?.ok || !response.body) {
        await response?.body?.cancel();
        throw new Error(`Could not fetch linked file ${f.id}: ${response?.status ?? 'no linked channel'}`);
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    } else await copyFile(f.path, path);
    const { id } = await deps.store.createFile({ ownerId: person.id, name: f.name, mime: f.mime, size: (await stat(path)).size, path });
    return { id, name: f.name, mime: f.mime, path };
  }));
  return { ...item, files };
}

/** A person's running inbox (server/extensions/channels.ts): the watcher and every channel's mode. */
export interface Inbox { add(items: ChannelItem[]): void }
const inboxes = new Map<string, Inbox>();
export function registerInbox(personId: string, inbox: Inbox | null): void { if (inbox) inboxes.set(personId, inbox); else inboxes.delete(personId); }

/** Takes a platform's items for a person whose Kenaznia runs on this channel. With the channels extension running their
 *  inbox decides; otherwise their fixed behaviour does (addressed Kenan chat messages and texts to Kenan's line, direct). */
export async function receive(deps: Deps, person: PersonConfig, arrived: ChannelItem[], options: { linked?: boolean } = {}): Promise<void> {
  const items = await Promise.all(arrived.map(item => item.files?.length ? adoptFiles(deps, person, item, options.linked === true) : item));
  const inbox = inboxes.get(person.id);
  if (inbox) { inbox.add(items); return; }
  for (const item of items) {
    if (routing(modeFor({ kind: 'fixed' }, {}, item.channel), item) !== 'direct') continue;
    if (!await deliverDirect(deps, person, item)) await deps.store.logError(`channels:${person.id}`, `no Kenaznia on this channel for ${item.channel}: ${item.text.slice(0, 200)}`);
  }
}
