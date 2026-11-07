// Phone notifications for Kenaznia replies and shared chats: every other person in a shared chat hears of a new
// message on their phone, unless one of their screens is showing that chat right now. A person's notifications come
// from the channel hosting their Kenaznia: here through notify (Android stream and Web Push), on another channel through
// that channel's notify outbox. Any author works (a person, or an agent posting into a shared chat).
import { randomUUID } from 'node:crypto';
import { chown, rename, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { backgroundPieces, stripNoReply, type ConversationSummary, type Message } from '../shared/contract.js';
import { hostedManager } from './config.js';
import { notify, clearChatNotifications, drainNotificationWrites } from './notifications.js';
import { NOTIFY_OUTBOX_ROOT } from './notify-outbox.js';
import { messageRewriter } from './message-rewrite.js';
import type { Deps } from './types.js';

/** A screen reports what it shows at least this often while visible; a report older than this no longer counts. */
export const VIEWING_TTL_MS = 75_000;
const PREVIEW_CHARS = 300;

type Seen = { conversationId: string | null; at: number; sequence?: number };
/** person → screen (client id) → the chat that screen shows while visible. */
const viewing = new Map<string, Map<string, Seen>>();

/** A screen of the person shows this chat (visible), or nothing (null: hidden, another page, closed). */
export function setViewing(personId: string, screenId: string, conversationId: string | null, now: number, sequence?: number): boolean {
  const screens = viewing.get(personId) ?? new Map<string, Seen>();
  const previous = screens.get(screenId);
  if (sequence !== undefined && previous?.sequence !== undefined && sequence <= previous.sequence) return false;
  screens.set(screenId, { conversationId, at: now, sequence });
  for (const [id, seen] of screens) if (now - seen.at >= VIEWING_TTL_MS) screens.delete(id);
  if (screens.size) viewing.set(personId, screens); else viewing.delete(personId);
  return true;
}

export function isViewing(personId: string, conversationId: string, now: number): boolean {
  for (const seen of viewing.get(personId)?.values() ?? []) if (seen.conversationId === conversationId && now - seen.at < VIEWING_TTL_MS) return true;
  return false;
}

/** The notification's one-line body: the text (quoted reply lines dropped), or what was attached. */
export function messagePreview(message: Pick<Message, 'text' | 'parts'>): string {
  const text = message.text.split('\n').filter(l => !l.startsWith('>')).join(' ').replace(/\s+/g, ' ').trim();
  const images = message.parts.filter(p => p.type === 'image').length, files = message.parts.filter(p => p.type === 'file').length;
  const attached = [images ? (images === 1 ? '📷 Photo' : `📷 ${images} photos`) : '', files ? (files === 1 ? '📎 File' : `📎 ${files} files`) : ''].filter(Boolean).join(', ');
  const preview = text ? (attached ? `${attached} · ${text}` : text) : attached || 'New message';
  return preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS - 1)}…` : preview;
}

export type ChatNotifyOutcome =
  | { personId: string; kind: 'notified'; notificationId: number }
  | { personId: string; kind: 'queued_elsewhere'; file: string }
  | { personId: string; kind: 'viewing' }
  | { personId: string; kind: 'no_manager' };

async function queueElsewhere(outboxRoot: string, personId: string, uid: number, gid: number, title: string, body: string, conversationId: string): Promise<string> {
  const dir = join(outboxRoot, personId);
  const name = `${Date.now()}-chat-${randomUUID().slice(0, 8)}`;
  const temp = join(dir, `.${name}.tmp`), file = join(dir, `${name}.json`);
  await writeFile(temp, JSON.stringify({ title, body, level: 'normal', conversationId }), { mode: 0o600 });
  await chown(temp, uid, gid).catch(() => {});
  await rename(temp, file);
  return file;
}

/**
 * Queues the author’s own Kenaznia reply, then tells other people in a shared chat about its new message. outboxRoot: the host's notify outboxes
 * (NOTIFY_OUTBOX_ROOT), for people whose Kenaznia runs on another channel.
 */
const notifying = new Map<string, Set<Promise<unknown>>>();
export async function notifyChatMembers(deps: Deps, outboxRoot: string, conversation: ConversationSummary, message: Message): Promise<ChatNotifyOutcome[]> {
  const task = (async () => {
    const stored = await deps.store.getMessage(message.conversationId, message.id);
    if (stored?.deletedAt) return [];
    return notifyCurrentChatMembers(deps, outboxRoot, conversation, stored ?? message);
  })();
  const active = notifying.get(conversation.id) ?? new Set();
  notifying.set(conversation.id, active); active.add(task);
  try { return await task; } finally { active.delete(task); if (!active.size) notifying.delete(conversation.id); }
}
async function notifyCurrentChatMembers(deps: Deps, outboxRoot: string, conversation: ConversationSummary, message: Message): Promise<ChatNotifyOutcome[]> {
  queueKenazniaNotification(deps, message);
  const people = new Map((await deps.store.listPeople()).map(p => [p.id, p]));
  const humans = conversation.memberIds.filter(id => people.get(id)?.kind === 'human');
  if (humans.length < 2) return [];
  // Someone's Kenaznia is "Kenaznia" only to that someone; to everyone else it is "Alice's Kenaznia".
  const kenazniaOf = message.authorId.startsWith('manager:') ? people.get(message.authorId.slice('manager:'.length)) : undefined;
  const titleFor = (personId: string) => `${kenazniaOf && kenazniaOf.id !== personId ? `${kenazniaOf.name}'s Kenaznia` : people.get(message.authorId)?.name ?? message.authorId} · ${conversation.title}`.slice(0, 120);
  const body = messagePreview(message);
  const outcomes: ChatNotifyOutcome[] = [];
  // A person's own Kenaznia answering in the chat is not news to them; a Kenaznia held on the other channel has no agent row here.
  const writer = (await deps.store.getAgent(message.authorId))?.ownerId ?? (message.authorId.startsWith('manager:') ? message.authorId.slice('manager:'.length) : message.authorId);
  for (const personId of humans) {
    if (personId === writer) continue;
    if (isViewing(personId, conversation.id, deps.now())) { outcomes.push({ personId, kind: 'viewing' }); continue; }
    const person = deps.person(personId);
    const placement = person?.manager ?? null;
    if (person && placement && 'elsewhere' in placement) {
      // The chat shows in their own app (server/channels/rooms.ts), so the tap opens it there.
      const file = await queueElsewhere(outboxRoot, personId, person.uid, person.gid, titleFor(personId), body, conversation.id);
      outcomes.push({ personId, kind: 'queued_elsewhere', file });
      continue;
    }
    const manager = person && hostedManager(person) ? await deps.store.getAgent(`manager:${personId}`) : null;
    if (!manager) { outcomes.push({ personId, kind: 'no_manager' }); continue; }
    const sent = await notify(deps, personId, manager, conversation.id, { title: titleFor(personId), body, level: 'normal', imageFileId: null });
    outcomes.push({ personId, kind: 'notified', notificationId: sent.notification.id });
  }
  return outcomes;
}

/** Finished public words from a person's own Kenaznia. Background and tool rows never enter this queue. */
type ReplyBurst = { deps: Deps; agentId: string; personId: string; conversationId: string; bodies: string[]; collapseKey: string; timer: ReturnType<typeof setTimeout>; firstAt: number };
const replies = new Map<string, ReplyBurst>();
export function queueKenazniaNotification(deps: Deps, message: Message): void {
  if (!message.authorId.startsWith('manager:') || message.role !== 'assistant' || message.state !== 'done' || message.display !== 'shown') return;
  const body = stripNoReply(backgroundPieces(message.text).filter(piece => !piece.background).map(piece => piece.text).join('\n\n')).trim();
  if (!body) return;
  const personId = message.authorId.slice('manager:'.length);
  const key = `${personId}:${message.conversationId}`;
  if (isViewing(personId, message.conversationId, deps.now())) return;
  const previous = replies.get(key);
  if (previous) {
    clearTimeout(previous.timer);
    previous.bodies.push(body);
    previous.timer = setTimeout(() => void flushKenazniaNotification(key), Math.max(0, Math.min(2500, 6000 - (deps.now() - previous.firstAt))));
    return;
  }
  replies.set(key, { deps, agentId: message.authorId, personId, conversationId: message.conversationId, bodies: [body], collapseKey: `reply:${message.id}`, firstAt: deps.now(), timer: setTimeout(() => void flushKenazniaNotification(key), 2500) });
}
async function flushKenazniaNotification(key: string): Promise<void> {
  const burst = replies.get(key);
  if (!burst) return;
  replies.delete(key);
  const { deps, personId, conversationId } = burst;
  try {
    if (isViewing(personId, conversationId, deps.now())) return;
    const agent = await deps.store.getAgent(burst.agentId);
    if (!agent || !deps.person(personId) || !hostedManager(deps.person(personId)!)) return;
    const body = burst.bodies.join('\n\n');
    await notify(deps, personId, agent, conversationId, { title: 'Kenaznia', body: body.length > 2000 ? `${body.slice(0, 1999)}…` : body, level: 'normal', imageFileId: null, collapseKey: burst.collapseKey });
  } catch (error) { await deps.store.logError('kenaznia_notify', String(error)).catch(() => {}); }
}

/** Withdraw stored/device previews and pending notification text before it can be replayed. */
export async function scrubChatNotificationCopies(deps: Deps, message: Message, replacement: string): Promise<void> {
  await Promise.allSettled([...(notifying.get(message.conversationId) ?? [])]);
  const rewrite = messageRewriter(message, replacement);
  for (const [key, burst] of replies) {
    if (burst.conversationId === message.conversationId || burst.bodies.some(body => rewrite(body) !== body)) {
      clearTimeout(burst.timer); replies.delete(key);
    }
  }
  for (const person of deps.config.people) {
    const dir = join(NOTIFY_OUTBOX_ROOT, person.id);
    for (const name of await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!name.endsWith('.json') && !name.endsWith('.invalid')) continue;
      const path = join(dir, name);
      let raw: string;
      try { raw = await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      let value: { conversationId?: string };
      try { value = JSON.parse(raw); } catch { continue; }
      if (value.conversationId === message.conversationId || rewrite(raw) !== raw) await unlink(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    }

  }
  // A preview already being written or pushed must finish before the withdrawal goes out.
  await drainNotificationWrites();
  await deps.store.scrubMessageCopies(message, replacement);
  for (const person of deps.config.people) {
    const chats = new Set([message.conversationId, ...(await deps.store.dismissedNotifications(person.id)).map(n => n.conversationId)]);
    for (const chat of chats) await clearChatNotifications(deps, person.id, chat);
  }
}
