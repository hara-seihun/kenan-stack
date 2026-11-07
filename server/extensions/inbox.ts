// Inbox: the one tool that reads a person's incoming messages on every channel they have. Signal, texts and Discord
// rows come from the stores those extensions keep; mail and Kenan chat rows come from the channels watcher's log. Where
// the watcher judged a message, its triage (relevant, Business, summary) comes with the row. The tool replaces the
// per-source recent and wait actions and the channels recent action.
import { Type } from 'typebox';
import { existsSync } from 'node:fs';
import type { PersonConfig } from '../config.js';
import { PLATFORMS, type Platform } from '../channels/address.js';
import { platformsOf } from '../channels/setup.js';
import { pageSize } from '../tools/pagination.js';
import { zoneOrHome } from '../../shared/zone.js';
import type { Deps, Extension } from '../types.js';
import { readDecisions, type Decision } from './channels.js';
import { discordRows, waitForDiscord } from './discord.js';
import { isoIn, rowMatches, type InboxRow } from './inbox-rows.js';
import { signalRows, waitForSignal, ownStore } from './signal.js';
import { textRows, textsDescription, waitForText } from './texts.js';

/** A person with any of these extensions reads the inbox. */
const SOURCE_EXTENSIONS = ['signal', 'texts', 'discord', 'channels'];
/** Sources a wait can watch. Mail has its own wait on the mail tool, and Kenan chats reach Kenaznia as notes. */
const WAITABLE: readonly Platform[] = ['signal', 'texts', 'discord'];
const MAX_WAIT_SECONDS = 600;
/** Listing preview; full:true returns all stored text. Watcher rows may themselves be excerpts. */
const CLIP_CHARS = 2000;

/** The sources a person has: their platforms, and mail and Kenan chats only with the channels watcher, which logs them. */
export function sourcesOf(person: PersonConfig): Platform[] {
  const logged = person.extensions.includes('channels');
  return platformsOf(person).filter(p => logged || (p !== 'kenan' && p !== 'mail'));
}

/** Mail and Kenan chat rows come from the watcher's log; the other sources' rows come from their own stores. */
async function rowsOf(person: PersonConfig, source: Platform, zone: string, decisions: Decision[]): Promise<InboxRow[]> {
  switch (source) {
    case 'signal': { const rows = await signalRows(person, zone); return person.id === 'alice' && existsSync(ownStore(person)) ? [...rows, ...await signalRows(person, zone, true)] : rows; }
    case 'texts': return textRows(person);
    case 'discord': return discordRows(person);
    default: return decisions.filter(d => d.source === source).map(d => ({
      id: d.id, source, at: d.at, from: d.from, where: d.where, text: d.excerpt,
      chatId: d.channel?.includes(':') ? d.channel.slice(d.channel.indexOf(':') + 1) : null,
    }));
  }
}

const clip = (text: string) => text.length > CLIP_CHARS ? `${text.slice(0, CLIP_CHARS)}…` : text;

function itemOf(row: InboxRow, triage: Decision | undefined, zone: string, full?: boolean) {
  return {
    source: row.source, ...(row.account ? { account: row.account } : {}), at: isoIn(row.at, zone), from: row.from, where: row.where, text: full ? row.text : clip(row.text),
    ...(!full && row.text.length > CLIP_CHARS ? { clipped: true } : {}),
    ...(row.chatId !== null || full ? { chatId: row.chatId } : {}),
    ...(triage ? { relevant: triage.relevant, ...(triage.Business || full ? { Business: triage.Business } : {}), ...(triage.summary || full ? { summary: triage.summary } : {}) } : {}),
  };
}

type Args = {
  action: 'recent' | 'wait'; source?: Platform; account?: 'person' | 'kenan-own'; query?: string; chat?: string; relevant?: boolean; full?: boolean; limit?: number; timeoutSeconds?: number; sinceSeconds?: number;
};

/** Newest first, merged across the sources asked for; `relevant` keeps only messages the watcher judged that way. */
async function recent(person: PersonConfig, zone: string, args: Args) {
  const offered = sourcesOf(person);
  if (args.source && !offered.includes(args.source)) throw new Error(`source_not_available: ${person.name} has no ${args.source} messages (sources: ${offered.join(', ')})`);
  const decisions = await readDecisions(person);
  const triage = new Map(decisions.map(d => [d.id, d]));
  const rows = (await Promise.all((args.source ? [args.source] : offered).map(s => rowsOf(person, s, zone, decisions)))).flat();
  const items = rows.filter(rowMatches(args.query))
    .filter(r => !args.account || (args.account === 'kenan-own' ? r.account === 'kenan-own' : !r.account))
    .filter(r => args.relevant === undefined || triage.get(r.id)?.relevant === args.relevant)
    .sort((a, b) => b.at - a.at);
  const limit = pageSize(Math.min(args.limit ?? 20, 50));
  return { zone, items: items.slice(0, limit).map(r => itemOf(r, triage.get(r.id), zone, args.full)), more: items.length > limit };
}

/** Resolves with the first of these waits to find a message, or null once all of them time out. The rest are stopped. */
function firstOf(waits: ((signal: AbortSignal) => Promise<InboxRow | null>)[], signal?: AbortSignal): Promise<InboxRow | null> {
  const stop = new AbortController();
  const abort = () => stop.abort();
  signal?.addEventListener('abort', abort, { once: true });
  return new Promise<InboxRow | null>((resolve, reject) => {
    let open = waits.length;
    for (const wait of waits) wait(stop.signal).then(hit => {
      if (hit) { resolve(hit); stop.abort(); } else if (--open === 0) resolve(null);
    }, error => { if (!stop.signal.aborted) { stop.abort(); reject(error); } });
  }).finally(() => { signal?.removeEventListener('abort', abort); stop.abort(); });
}

/** The first new incoming message matching, from the source asked for or from any waitable source. */
async function wait(person: PersonConfig, deps: Deps, zone: string, args: Args, signal?: AbortSignal) {
  if (args.timeoutSeconds === undefined) throw new Error('invalid_input: timeoutSeconds is required for wait');
  if (args.source && !WAITABLE.includes(args.source)) throw new Error(`inbox_wait_unsupported: ${args.source} can't be waited on here (wait works for ${WAITABLE.join(', ')}; mail has its own wait action on the mail tool, and Kenan chats reach you as notes)`);
  const offered = sourcesOf(person).filter(s => WAITABLE.includes(s));
  if (args.source && !offered.includes(args.source)) throw new Error(`source_not_available: ${person.name} has no ${args.source} messages to wait for`);
  const sources = args.source ? [args.source] : offered;
  if (!sources.length) throw new Error(`source_not_available: ${person.name} has no source to wait on (${WAITABLE.join(', ')})`);
  const since = deps.now() - (args.sinceSeconds ?? 0) * 1000, timeoutMs = args.timeoutSeconds * 1000;
  const waits = sources.map(source => (stop: AbortSignal) => {
    switch (source) {
      case 'signal': return waitForSignal(person, zone, args.query, args.chat, since, timeoutMs, stop, args.account === 'kenan-own');
      case 'texts': return waitForText(person, args.query, args.chat, since, timeoutMs, stop);
      default: return waitForDiscord(person, args.query, args.chat, since, timeoutMs, stop);
    }
  });
  if (!args.account && sources.includes('signal') && person.id === 'alice' && existsSync(ownStore(person))) waits.push(stop => waitForSignal(person, zone, args.query, args.chat, since, timeoutMs, stop, true));
  const hit = await firstOf(waits, signal);
  return hit ? { item: itemOf(hit, undefined, zone, args.full ?? true) } : { timedOut: true, waitedSeconds: args.timeoutSeconds };
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });

export const inboxExtension: Extension = {
  id: 'inbox', name: 'Inbox',
  enabled: person => SOURCE_EXTENSIONS.some(e => person.extensions.includes(e)),
  promptSnippet: 'Inbox: the inbox tool lists and waits for incoming messages on the person\'s channels (Signal, texts, Discord, and mail and Kenan chats as the watcher saw them). After triggering a sign-in or confirmation code, call inbox with action "wait" and source "texts", so the code reaches you without asking the person. Sending is the send tool\'s.',
  tool: ({ person, deps }) => {
    const offered = sourcesOf(person);
    const texts = offered.includes('texts') ? ` ${textsDescription(person, deps.config.channel)}` : '';
    return {
      name: 'inbox', files: 'none', records: 'none', label: 'Inbox',
      description: `Read ${person.name}'s incoming messages across her channels (sources: ${offered.join(', ')}; kenan is Kenan's shared chats). account "kenan-own" selects Kenan’s Signal; "person" selects hers, and omitted includes both. action "recent": newest first, from every source or the one named; source; query (case-insensitive substring of the sender, chat or channel, chat id or text); relevant (true: only what the watcher passed to Kenaznia; false: only what it dropped; messages it never judged are left out); limit 1–50 (20 when omitted). Each item has source, at (ISO time in her current time zone), from, where (chat or channel), text (up to 2000 characters; clipped:true marks a shortened preview), and chatId: the Signal chat id for the signal tool's history, the Discord channel id for the discord tool's history, the number to text back for texts; omitted when there is none. Items the watcher judged also have relevant, Business (only when true) and summary (only when nonempty). full:true returns all stored text and includes null/false/empty metadata. Mail and Kenan rows are stored watcher excerpts; use source history/read for original messages. action "wait": full stored text of the first new incoming message matching source (omitted: any of ${WAITABLE.join(', ')}), query and chat (a chat id, name or number) within timeoutSeconds (1–${MAX_WAIT_SECONDS}), or {timedOut: true}; sinceSeconds also accepts messages that arrived up to that many seconds before the call (use it when the code may already have come in). For a reply that may take longer, use wake on: "signal" or "text". Read a whole Signal conversation with the signal tool's history action, and a Discord channel with the discord tool's history action.${texts}`,
      parameters: Type.Object({
        action: Type.Union([Type.Literal('recent'), Type.Literal('wait')]),
        source: Type.Optional(Type.Union(PLATFORMS.map(p => Type.Literal(p)))),
        account: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('kenan-own')])),
        query: Type.Optional(Type.String({ minLength: 1 })),
        chat: Type.Optional(Type.String({ minLength: 1 })),
        relevant: Type.Optional(Type.Boolean()),
        full: Type.Optional(Type.Boolean({ description: 'Return all stored text instead of a 2000-character preview, and include empty metadata; mail/Kenan rows remain watcher excerpts.' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_SECONDS })),
        sinceSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })),
      }),
      execute: async (_id, raw: unknown, signal) => {
        const args = raw as Args;
        const zone = zoneOrHome(await deps.store.zoneOf(person.id));
        switch (args.action) {
          case 'recent': return result(await recent(person, zone, args));
          case 'wait': return result(await wait(person, deps, zone, args, signal));
          default: throw new Error(`Unknown inbox action ${String((args as { action: unknown }).action)}`);
        }
      },
    };
  },
};
