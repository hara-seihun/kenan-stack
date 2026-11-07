// A person's linked Signal account as kenan-signal-receiver keeps it: every envelope signal-cli receives, raw, in
// ROOT/receive.sqlite3 (events: id, observed_at, payload), attachments in ROOT/backends/signal/signal-cli/attachments,
// contacts in signal-cli's account database. Wakes, the message watcher and the signal tool all read it through here.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SignalContact { uuid: string | null; number: string | null; name: string | null }
/** Where a message was said: one person's direct chat with the account (the other party), or a group. */
export type SignalConversation = { kind: 'direct'; uuid: string | null; number: string | null } | { kind: 'group'; id: string; name: string | null };
export interface SignalAttachment { contentType: string | null; name: string | null; size: number | null; path: string | null }
export interface SignalMention { start: number; length: number; uuid: string | null; number: string | null; name: string; self: boolean }
export interface SignalQuote { author: string | null; text: string | null }
type Contacts = ReturnType<typeof readContacts>;

/** Signal offsets count UTF-16 code units, as JavaScript slice does. Styling-only ranges are not mentions. */
function mentionsOf(data: Record<string, unknown>, text: string, contacts?: Contacts): SignalMention[] {
  const ranges = [data.mentions, data.bodyRanges].flatMap(v => Array.isArray(v) ? v : []);
  const mentions = new Map<number, SignalMention>();
  for (const r of ranges) {
    if (!r || typeof r !== 'object') continue;
    const uuid = str(r.uuid) ?? str(r.mentionUuid) ?? str(r.mentionAci) ?? str(r.mention?.uuid);
    const number = str(r.number) ?? str(r.mention?.number);
    const start = num(r.start), length = num(r.length);
    if ((!uuid && !number) || start === null || length === null || !Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || start + length > text.length) continue;
    const contact = uuid ? contacts?.byUuid.get(uuid) : contacts?.all.find(c => c.number === number);
    const supplied = str(r.name);
    const name = contact?.name ?? (supplied && supplied !== uuid && supplied !== number ? supplied : null) ?? contact?.number ?? number ?? uuid!;
    mentions.set(start, { start, length, uuid, number: contact?.number ?? number, name, self: !!uuid && uuid === contacts?.self });
  }
  return [...mentions.values()].sort((a, b) => a.start - b.start).filter((m, i, all) => i === 0 || m.start >= all[i - 1]!.start + all[i - 1]!.length);
}

export function signalMentionText(text: string, mentions: readonly SignalMention[] = [], owner?: string): string {
  for (const m of [...mentions].reverse()) text = text.slice(0, m.start) + `@${m.self && owner ? owner : m.name}` + text.slice(m.start + m.length);
  return text;
}

/** Keep the addressee visible even when a long body is clipped for the watcher. A mention of a person is not a request to their assistant. */
export function signalMentionNote(mentions: readonly SignalMention[] = [], owner: string): string {
  return mentions.length ? `[Signal mentions: ${mentions.map(m => `@${m.self ? owner : m.name}${m.self ? ' (account owner)' : ''}`).join(', ')}] ` : '';
}
/** One thing said in a conversation. `own`: the account's owner sent it from another device (a sync message); `from` is
 * then the owner. `sentAt` is the sender's timestamp, which reactions, edits and deletions name as their target. */
export type SignalEntry = { id: string; rowid: number; observedAt: number; sentAt: number; own: boolean; from: SignalContact; chat: SignalConversation } & (
  | { kind: 'message'; text: string; mentions?: SignalMention[]; quote: SignalQuote | null; attachments: SignalAttachment[]; edits: number | null }
  | { kind: 'reaction'; emoji: string; removed: boolean; target: { author: string | null; sentAt: number } }
  | { kind: 'deletion'; target: { sentAt: number } });

const str = (v: unknown) => typeof v === 'string' && v ? v : null;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Envelopes that can carry something said; typing, receipts, calls and bare syncs never do, so they are never parsed. */
const MAY_SAY = /"(dataMessage|sentMessage|editMessage)"/;

/** The store's root directory: receive.sqlite3 sits in it. */
export const signalRoot = (store: string) => dirname(store);
const nativeDir = (store: string) => join(signalRoot(store), 'backends/signal/signal-cli');

export function signalEntry(id: string, rowid: number, observedAt: number, payload: string, root: string | null, contacts?: Contacts): SignalEntry | null {
  if (!MAY_SAY.test(payload)) return null;
  const envelope = (() => { try { return JSON.parse(payload).envelope; } catch { return null; } })();
  if (!envelope || typeof envelope !== 'object') return null;
  const sent = envelope.syncMessage?.sentMessage;
  const edit = envelope.editMessage;
  const data = sent ?? edit?.dataMessage ?? envelope.dataMessage;
  if (!data || typeof data !== 'object') return null;
  const own = Boolean(sent);
  const sender: SignalContact = { uuid: str(envelope.sourceUuid), number: str(envelope.sourceNumber), name: own ? null : str(envelope.sourceName) };
  const info = data.groupInfo;
  const chat: SignalConversation = info && str(info.groupId) ? { kind: 'group', id: info.groupId, name: str(info.groupName) }
    : own ? { kind: 'direct', uuid: str(sent.destinationUuid), number: str(sent.destinationNumber) }
    : { kind: 'direct', uuid: sender.uuid, number: sender.number };
  const sentAt = num(data.timestamp) ?? num(envelope.timestamp) ?? observedAt;
  const base = { id, rowid, observedAt, sentAt, own, from: sender, chat };
  const reaction = data.reaction;
  if (reaction && str(reaction.emoji) && num(reaction.targetSentTimestamp) !== null)
    return { ...base, kind: 'reaction', emoji: reaction.emoji, removed: reaction.isRemove === true, target: { author: str(reaction.targetAuthorUuid) ?? str(reaction.targetAuthor), sentAt: reaction.targetSentTimestamp } };
  if (data.remoteDelete && num(data.remoteDelete.timestamp) !== null) return { ...base, kind: 'deletion', target: { sentAt: data.remoteDelete.timestamp } };
  const text = str(data.message) ?? '';
  const attachments: SignalAttachment[] = Array.isArray(data.attachments) ? data.attachments.map((a: Record<string, unknown>) => {
    const file = str(a?.id);
    const path = root && file ? join(root, 'backends/signal/signal-cli/attachments', file) : null;
    return { contentType: str(a?.contentType), name: str(a?.filename), size: num(a?.size), path: path && existsSync(path) ? path : null };
  }) : [];
  if (!text && !attachments.length) return null;
  const q = data.quote;
  const quote = q ? { author: str(q.authorUuid) ?? str(q.author), text: typeof q.text === 'string' ? signalMentionText(q.text, mentionsOf(q, q.text, contacts)) : null } : null;
  return { ...base, kind: 'message', text, mentions: mentionsOf(data, text, contacts), quote, attachments, edits: edit ? num(edit.targetSentTimestamp) : null };
}

/** The receiver commits each event in its own short rollback-journal transaction, so a read can briefly meet its lock:
 * each attempt waits up to SIGNAL_BUSY_MS inside SQLite, and a still-locked read is retried after an async pause,
 * keeping the event loop free while the receiver commits. */
export const SIGNAL_BUSY_MS = 250;
export const SIGNAL_RETRY_PAUSE_MS = 400;
export const SIGNAL_ATTEMPTS = 6;
const locked = (e: unknown) => /database is locked|SQLITE_BUSY|database table is locked/i.test(String(e));

export function withStoreOnce<T>(store: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(store, { readOnly: true, timeout: SIGNAL_BUSY_MS });
  try { return read(db); } finally { db.close(); }
}

export async function withStore<T>(store: string, read: (db: DatabaseSync) => T, signal?: AbortSignal): Promise<Result<T>> {
  for (let attempt = 1; ; attempt++) {
    try { return { ok: true, value: withStoreOnce(store, read) }; }
    catch (e) {
      if (!locked(e) || attempt >= SIGNAL_ATTEMPTS || signal?.aborted) return { ok: false, error: `${e}${locked(e) ? ` (${attempt} attempts)` : ''}` };
      await new Promise(resolve => setTimeout(resolve, SIGNAL_RETRY_PAUSE_MS));
    }
  }
}

type Row = { id: string; rowid: number; observed_at: number; payload: string };
/** Visits entries newest first (or oldest first after a rowid) until `take` returns false. */
export function scanEntries(db: DatabaseSync, store: string, order: { kind: 'newest' } | { kind: 'after'; rowid: number } | { kind: 'since'; observedAt: number }, take: (e: SignalEntry) => boolean): void {
  const root = signalRoot(store);
  const contacts = readContacts(store);
  const rows = order.kind === 'newest' ? db.prepare('SELECT rowid, id, observed_at, payload FROM events ORDER BY rowid DESC').iterate()
    : order.kind === 'after' ? db.prepare('SELECT rowid, id, observed_at, payload FROM events WHERE rowid > ? ORDER BY rowid').iterate(order.rowid)
    : db.prepare('SELECT rowid, id, observed_at, payload FROM events WHERE observed_at >= ? ORDER BY observed_at').iterate(order.observedAt);
  for (const row of rows as Iterable<Row>) {
    const entry = signalEntry(row.id, Number(row.rowid), Number(row.observed_at), row.payload, root, contacts);
    if (entry && !take(entry)) return;
  }
}

export const lastRowid = (db: DatabaseSync) => Number((db.prepare('SELECT max(rowid) AS m FROM events').get() as { m: number | null }).m ?? 0);

/** Contacts signal-cli knows (nickname, then the name saved in the owner's contacts, then their profile name), by UUID and
 * number; the owner's own account UUID. A store without signal-cli's account files gives none. */
export function readContacts(store: string): { self: string | null; byUuid: Map<string, SignalContact>; all: SignalContact[] } {
  const empty = { self: null, byUuid: new Map<string, SignalContact>(), all: [] };
  const accountsFile = join(nativeDir(store), 'data/accounts.json');
  if (!existsSync(accountsFile)) return empty;
  const account = (JSON.parse(readFileSync(accountsFile, 'utf8')).accounts ?? [])[0] as { path?: string; uuid?: string } | undefined;
  if (!account?.path) return empty;
  const file = join(nativeDir(store), 'data', `${account.path}.d`, 'account.db');
  if (!existsSync(file)) return { ...empty, self: account.uuid ?? null };
  const db = new DatabaseSync(file, { readOnly: true, timeout: SIGNAL_BUSY_MS });
  try {
    const rows = db.prepare('SELECT aci, number, nick_name, given_name, family_name, profile_given_name, profile_family_name FROM recipient').all() as Record<string, string | null>[];
    const join2 = (a: string | null, b: string | null) => [a, b].filter(Boolean).join(' ') || null;
    const all = rows.map(r => ({ uuid: r.aci ?? null, number: r.number ?? null, name: r.nick_name || join2(r.given_name ?? null, r.family_name ?? null) || join2(r.profile_given_name ?? null, r.profile_family_name ?? null) }));
    return { self: account.uuid ?? null, byUuid: new Map(all.filter(c => c.uuid).map(c => [c.uuid!, c])), all };
  } finally { db.close(); }
}

// ---- The projection wakes and the message watcher use ----

/** One Signal message in the person's linked account. `own` is one they sent from another device (a sync message): context for
 * readers, never a trigger. `uuid`/`name` are the other party for a direct message they sent, else the sender. */
export interface SignalMessage { id: string; observedAt: number; own: boolean; uuid: string | null; name: string | null; from: string; group: { id: string | null; name: string | null } | null; body: string; rawBody?: string; mentions?: SignalMention[]; quote: string | null; attachments: string[] }

export function toSignalMessage(e: SignalEntry): SignalMessage | null {
  if (e.kind !== 'message' || e.edits !== null) return null;
  const group = e.chat.kind === 'group' ? { id: e.chat.id, name: e.chat.name } : null;
  const uuid = e.own ? (e.chat.kind === 'direct' ? e.chat.uuid : null) : e.from.uuid;
  const from = e.own ? '' : [e.from.name, e.from.number, e.from.uuid].filter(Boolean).join(' ');
  return { id: e.id, observedAt: e.observedAt, own: e.own, uuid, name: e.from.name, from, group, body: signalMentionText(e.text, e.mentions), ...(e.mentions?.length ? { rawBody: e.text, mentions: e.mentions } : {}), quote: e.quote?.text ?? null, attachments: e.attachments.map(a => a.name ?? a.contentType ?? 'attachment') };
}

/** The message an envelope carries, if any: an incoming data message, or one the account sent from another device. */
export function signalMessage(id: string, observedAt: number, payload: string): SignalMessage[] {
  const entry = signalEntry(id, 0, observedAt, payload, null);
  const message = entry && toSignalMessage(entry);
  return message ? [message] : [];
}

/** Messages observed since `since`, oldest first. */
const messagesSince = (store: string, since: number) => (db: DatabaseSync) => {
  const out: SignalMessage[] = [];
  scanEntries(db, store, { kind: 'since', observedAt: since }, e => { const m = toSignalMessage(e); if (m) out.push(m); return true; });
  return out;
};
export const readSignalOnce = (store: string, since: number): SignalMessage[] => withStoreOnce(store, messagesSince(store, since));
export const readSignal = (store: string, since: number, signal?: AbortSignal): Promise<Result<SignalMessage[]>> => withStore(store, messagesSince(store, since), signal);

/** Messages since a moving `since`, read incrementally: the wake check asks every tick (and on every host event) for
 * everything since its oldest Signal wake, which can be days of envelopes; re-reading them each time held the event loop
 * for 4% of its time (2026-10-30, a 12-day-old wake on 29,000 envelopes). The first read loads from `since`, later reads
 * only rows past the last one seen; a `since` earlier than what is held reloads. */
export class SignalFeed {
  private held: { floor: number; rowid: number; ids: Set<string>; messages: SignalMessage[] } | null = null;
  constructor(private readonly store: string) {}
  async read(since: number, signal?: AbortSignal): Promise<Result<SignalMessage[]>> {
    const held = this.held && since >= this.held.floor ? this.held : null;
    const after = held?.rowid ?? 0;
    const read = await withStore(this.store, db => {
      const top = lastRowid(db), out: SignalMessage[] = [];
      scanEntries(db, this.store, { kind: 'after', rowid: after }, e => { const m = toSignalMessage(e); if (m && m.observedAt >= since) out.push(m); return true; });
      return { top, out };
    }, signal);
    if (!read.ok) return read;
    const next = held ?? { floor: since, rowid: 0, ids: new Set<string>(), messages: [] };
    for (const m of read.value.out) if (!next.ids.has(m.id)) { next.ids.add(m.id); next.messages.push(m); }
    next.rowid = Math.max(next.rowid, read.value.top);
    if (since > next.floor) {
      next.messages = next.messages.filter(m => m.observedAt >= since || !next.ids.delete(m.id));
      next.floor = since;
    }
    this.held = next;
    return { ok: true, value: next.messages.filter(m => m.observedAt >= since).sort((a, b) => a.observedAt - b.observedAt) };
  }
}
