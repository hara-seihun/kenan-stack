// Signal: the person's linked Signal account, read from what kenan-signal-receiver stores (server/signal.ts) and written
// through signal-send, one message at a time, each with a receipt. Kenan answers on Alice's Signal only about Business.
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { open, readFile, writeFile, chown } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import { zoneOrHome } from '../../shared/zone.js';
import type { PersonConfig } from '../config.js';
import { lastRowid, readContacts, scanEntries, signalMentionText, signalMentionNote, withStore, type SignalAttachment, type SignalContact, type SignalConversation, type SignalEntry } from '../signal.js';
import { ownerProcess, type ProcessPlacement } from '../tools/owner.js';
import type { Extension } from '../types.js';
import { ownedDir } from './texts.js';
import type { InboxRow } from './inbox-rows.js';

export const SIGNAL_SEND = '/usr/local/bin/signal-send';
const WAIT_POLL_MS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\+[1-9]\d{6,14}$/;

/** Every Signal message from Kenan says it is Kenan: "[Kenan]" (the short form some people asked for, e.g. Robin on
 *  2026-10-30) or "[Kenan, …]" (e.g. "[Kenan, Alice's assistant, not Alice]"). signal-send enforces the same rule. */
export const SIGNAL_LABEL = /^\[Kenan(, [^\]\n]{1,110})?\]$/;

/** People the person lets Kenan message directly on her Signal (Alice: Robin and Frank, 2026-10-18), each with the
 *  label that person gets when it isn't the account's default. From the extension config:
 *  "signal": { "contacts": { "UUID": { "name": "Robin", "label": "[Kenan]" } } }. */
export interface SignalContactRule { uuid: string; name: string; label: string | null }
export function signalContacts(person: Pick<PersonConfig, 'id' | 'extensionConfigPath'>): SignalContactRule[] {
  if (!person.extensionConfigPath) return [];
  const section = (JSON.parse(readFileSync(person.extensionConfigPath, 'utf8')) as { signal?: { contacts?: unknown } }).signal;
  const contacts = section?.contacts;
  if (contacts === undefined) return [];
  const bad = (why: string) => new Error(`signal_contacts_invalid: ${person.id}'s signal.contacts in ${person.extensionConfigPath} ${why}; shape { "UUID": { "name": "Robin", "label": "[Kenan]" } } (label optional)`);
  if (typeof contacts !== 'object' || contacts === null || Array.isArray(contacts)) throw bad('is not an object');
  return Object.entries(contacts as Record<string, unknown>).map(([uuid, raw]) => {
    const c = raw as { name?: unknown; label?: unknown };
    if (!UUID.test(uuid)) throw bad(`has "${uuid}", which is not a Signal UUID`);
    if (typeof c?.name !== 'string' || !c.name.trim()) throw bad(`has no name for ${uuid}`);
    if (c.label !== undefined && (typeof c.label !== 'string' || !SIGNAL_LABEL.test(c.label))) throw bad(`gives ${c.name} a label that doesn't say "[Kenan]" or "[Kenan, …]"`);
    return { uuid: uuid.toLowerCase(), name: c.name, label: (c.label as string | undefined) ?? null };
  });
}

/** A message Kenan sent through this tool; the account never sees its own sends again, so this log is how history shows them. */
export type SendTarget = { kind: 'direct'; uuid: string; number: string | null; name: string | null } | { kind: 'group'; id: string; name: string | null };
export interface KenanSend { id: string; at: number; to: SendTarget; text: string; attachments: string[]; outcome: string; receipt: string; agentId: string }

export const ownStore = (person: Pick<PersonConfig, 'home' | 'id'>) => { if (person.id !== 'alice') throw new Error('signal_account_unavailable: Kenan’s Signal is only available to Alice’s agents'); return join(person.home, '.local/share/kenan/signal/receive.sqlite3'); };
/** Registration moves the native store here; an existing receive DB also means the account was provisioned. */
export function ownSignalConfigured(person: Pick<PersonConfig, 'home' | 'id'>): boolean {
  const store = ownStore(person);
  return [store, join(dirname(store), 'backends/signal/signal-cli')].some(path => {
    try { statSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  });
}
function requireOwnSignal(person: Pick<PersonConfig, 'home' | 'id'>): void {
  if (!ownSignalConfigured(person)) throw new Error('signal_account_unavailable: Kenan’s Signal has no native store or receive history');
}
const dataDir = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/signal');
const sentFile = (person: Pick<PersonConfig, 'home'>, own = false) => join(dataDir(person), own ? 'own-sent.jsonl' : 'sent.jsonl');

export async function readSends(person: Pick<PersonConfig, 'home'>, own = false): Promise<KenanSend[]> {
  const data = await readFile(sentFile(person, own), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line) as KenanSend);
}

// ---- Conversations and names ----

type Key = string;
const keyOf = (c: SignalConversation): Key => c.kind === 'group' ? `group:${c.id}` : `direct:${c.uuid ?? c.number ?? 'unknown'}`;
interface Conversation { key: Key; chat: SignalConversation; name: string; last: number }
interface Index { self: string | null; names: Map<string, string>; conversations: Map<Key, Conversation> }

/** Names by UUID and number (contacts first, then names senders gave), and every conversation with its newest activity. */
function indexOf(store: string, entries: SignalEntry[], sends: KenanSend[]): Index {
  const contacts = readContacts(store);
  const names = new Map<string, string>();
  for (const c of contacts.all) if (c.name) { if (c.uuid) names.set(c.uuid, c.name); if (c.number) names.set(c.number, c.name); }
  for (const e of entries) if (!e.own && e.from.name) for (const id of [e.from.uuid, e.from.number]) if (id && !names.has(id)) names.set(id, e.from.name);
  const conversations = new Map<Key, Conversation>();
  const groupNames = new Map<string, string>();
  for (const e of entries) if (e.chat.kind === 'group' && e.chat.name && !groupNames.has(e.chat.id)) groupNames.set(e.chat.id, e.chat.name);
  const add = (chat: SignalConversation, at: number) => {
    const key = keyOf(chat), seen = conversations.get(key);
    if (seen) { seen.last = Math.max(seen.last, at); return; }
    const name = chat.kind === 'group' ? `group "${groupNames.get(chat.id) ?? chat.name ?? chat.id}"` : (chat.uuid && names.get(chat.uuid)) || (chat.number && names.get(chat.number)) || chat.number || chat.uuid || 'unknown';
    conversations.set(key, { key, chat, name, last: at });
  };
  for (const e of entries) add(e.chat, e.sentAt);
  for (const s of sends) add(chatOf(s.to), s.at);
  for (const c of contacts.all) if (c.uuid && c.name && c.uuid !== contacts.self) add({ kind: 'direct', uuid: c.uuid, number: c.number }, 0);
  return { self: contacts.self ?? entries.find(e => e.own)?.from.uuid ?? null, names, conversations };
}

const chatOf = (t: SendTarget): SignalConversation => t.kind === 'group' ? { kind: 'group', id: t.id, name: t.name } : { kind: 'direct', uuid: t.uuid, number: t.number };
const ids = (c: Conversation) => c.chat.kind === 'group' ? [c.chat.id] : [c.chat.uuid, c.chat.number].filter((v): v is string => Boolean(v));
const bare = (c: Conversation) => c.chat.kind === 'group' ? c.name.slice(7, -1) : c.name;

/** One conversation by UUID, number, group id or name: an exact id or name wins over a partial name; several partial matches are an error naming them. */
export function resolveConversation(index: Index, query: string): Conversation {
  const q = query.trim().toLowerCase();
  const all = [...index.conversations.values()];
  const exact = all.filter(c => ids(c).some(id => id.toLowerCase() === q) || bare(c).toLowerCase() === q);
  const found = exact.length ? exact : all.filter(c => bare(c).toLowerCase().includes(q));
  if (found.length === 1) return found[0]!;
  const list = found.sort((a, b) => b.last - a.last).slice(0, 10).map(c => `${c.name} (${ids(c)[0] ?? 'no id'})`).join('; ');
  throw new Error(found.length ? `signal_chat_ambiguous: "${query}" matches ${found.length} conversations: ${list}. Use a UUID, number or group id.` : `signal_chat_not_found: no Signal conversation or contact matches "${query}"`);
}

// ---- Readable lines ----

type Shown = { id: string; at: number; line: string; chat: Conversation; from: string; text: string; message: boolean; incoming: boolean };
const clock = (zone: string) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); return (at: number) => f.format(at); };
const attachmentText = (a: SignalAttachment) => `${a.path ?? a.name ?? 'not saved'} (${a.contentType ?? 'file'}${a.size ? `, ${Math.round(a.size / 1024)} KB` : ''})`;

function show(e: SignalEntry, index: Index, owner: string, time: (at: number) => string): Shown {
  const nameOf = (id: string | null) => id === null ? 'someone' : id === index.self ? owner : index.names.get(id) ?? id;
  const from = e.own ? owner : e.from.name ?? nameOf(e.from.uuid ?? e.from.number);
  const chat = index.conversations.get(keyOf(e.chat))!;
  const text = e.kind === 'message'
    ? `${e.edits !== null ? `(edited their message of ${time(e.edits)}) ` : ''}${signalMentionNote(e.mentions, owner)}${signalMentionText(e.text, e.mentions, owner)}${e.quote ? ` [replying to ${nameOf(e.quote.author)}: "${(e.quote.text ?? '').slice(0, 200)}"]` : ''}${e.attachments.length ? ` [attachments: ${e.attachments.map(attachmentText).join('; ')}]` : ''}`
    : e.kind === 'reaction' ? `${e.removed ? 'removed the reaction' : 'reacted'} ${e.emoji} to ${nameOf(e.target.author)}'s message of ${time(e.target.sentAt)}`
    : `deleted their message of ${time(e.target.sentAt)}`;
  const sep = e.kind === 'message' ? ': ' : ' ';
  return { id: `signal:${e.id}`, at: e.sentAt, line: `${time(e.sentAt)} ${from}${sep}${text}`, chat, from, text, message: e.kind === 'message', incoming: !e.own && e.kind === 'message' };
}

function showSend(s: KenanSend, index: Index, time: (at: number) => string): Shown {
  const chat = index.conversations.get(keyOf(chatOf(s.to)))!;
  const text = `${s.text}${s.attachments.length ? ` [attachments: ${s.attachments.join('; ')}]` : ''}${s.outcome === 'succeeded' ? '' : ` [send ${s.outcome}]`}`;
  return { id: `signal-send:${s.id}`, at: s.at, line: `${time(s.at)} Kenan: ${text}`, chat, from: 'Kenan', text, message: true, incoming: false };
}

const rowOf = (s: Shown): InboxRow => ({ id: s.id, source: 'signal', at: s.at, from: s.from, where: s.chat.name, text: s.text, chatId: ids(s.chat)[0] ?? null });

// ---- Reading ----

async function everything(store: string): Promise<SignalEntry[]> {
  const read = await withStore(store, db => { const out: SignalEntry[] = []; scanEntries(db, store, { kind: 'newest' }, e => { out.push(e); return true; }); return out; });
  if (!read.ok) throw new Error(`signal_store_unreadable: ${read.error}`);
  return read.value;
}

async function context(person: PersonConfig, store: string, zone: string, own = false) {
  if (own) requireOwnSignal(person);
  const [entries, sends] = await Promise.all([everything(store), readSends(person, own)]);
  const index = indexOf(store, entries, sends);
  const time = clock(zone);
  const shown = [...entries.map(e => show(e, index, own ? 'Kenan' : person.name, time)), ...sends.map(s => showSend(s, index, time))].sort((a, b) => b.at - a.at);
  return { index, time, shown };
}

const matches = (query: string | undefined) => (s: Shown) => !query || `${s.from}\n${s.chat.name}\n${ids(s.chat).join('\n')}\n${s.text}`.toLowerCase().includes(query.toLowerCase());

/** Every Signal message (her own and Kenan's sends included) as inbox rows, in no particular order. */
export async function signalRows(person: PersonConfig, zone: string, own = false): Promise<InboxRow[]> {
  const { shown } = await context(person, own ? ownStore(person) : storeOf(person), zone, own);
  return shown.filter(s => s.message).map(s => own ? { ...rowOf(s), id: s.id.replace(/^signal/, 'signal-kenan'), account: 'kenan-own' as const } : rowOf(s));
}

/** Resolves with the first incoming message matching, stored at or after `since` (ms), or null once the timeout passes. */
export async function waitForSignal(person: PersonConfig, zone: string, query: string | undefined, chat: string | undefined, since: number, timeoutMs: number, signal?: AbortSignal, own = false): Promise<InboxRow | null> {
  if (own) requireOwnSignal(person);
  const store = own ? ownStore(person) : storeOf(person);
  const deadline = Date.now() + timeoutMs;
  const contacts = readContacts(store);
  const fresh = async (order: { kind: 'since'; observedAt: number } | { kind: 'after'; rowid: number }) => {
    const read = await withStore(store, db => { const out: SignalEntry[] = []; scanEntries(db, store, order, e => { out.push(e); return true; }); return { out, last: lastRowid(db) }; }, signal);
    if (!read.ok) throw new Error(`signal_store_unreadable: ${read.error}`);
    return read.value;
  };
  let batch = await fresh({ kind: 'since', observedAt: since });
  for (;;) {
    const index = indexOf(store, batch.out, []);
    for (const [uuid, c] of contacts.byUuid) if (c.name && !index.names.has(uuid)) index.names.set(uuid, c.name);
    const time = clock(zone);
    const hit = batch.out.map(e => show(e, index, own ? 'Kenan' : person.name, time)).find(s => s.incoming && matches(query)(s) && (!chat || matches(chat)({ ...s, text: '', from: '' })));
    if (hit) return own ? { ...rowOf(hit), id: hit.id.replace(/^signal/, 'signal-kenan'), account: 'kenan-own' } : rowOf(hit);
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
      const stop = () => { clearTimeout(t); reject(new Error('Wait cancelled')); };
      signal?.addEventListener('abort', stop, { once: true });
    });
    batch = await fresh({ kind: 'after', rowid: batch.last });
  }
}

// ---- Sending ----

const senders = new Map<string, Promise<unknown>>();
type SendArgs = { to: string; text: string; attachments: string[]; label: string | null; own?: boolean };

/** Sends one message with signal-send as the person, one at a time per person, and logs it with its receipt's outcome. */
export function sendSignal(person: PersonConfig, placement: ProcessPlacement, executable: string, recipient: SendTarget, args: SendArgs, agentId: string, now: () => number, signal?: AbortSignal): Promise<KenanSend> {
  const key = person.home;
  const run = (senders.get(key) ?? Promise.resolve()).then(async () => {
    const dir = await ownedDir(person, join(dataDir(person), 'sends'));
    const id = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const messageFile = join(dir, `${id}.txt`), receipt = join(dir, `${id}.receipt.json`);
    await writeFile(messageFile, args.text, { mode: 0o600, flag: 'wx' });
    await chown(messageFile, person.uid, person.gid);
    const argv = [...(args.own ? ['--account', 'kenan-own'] : []), ...(args.label ? ['--label', args.label] : []), recipient.kind === 'group' ? `group:${recipient.id}` : recipient.uuid, messageFile, receipt, ...args.attachments];
    const result = await ownerProcess(placement, person, executable, argv, undefined, signal, undefined, 150, undefined, agentId);
    const outcome = await readFile(receipt, 'utf8').then(r => String(JSON.parse(r).outcome ?? JSON.parse(r).state), () => `no-receipt (exit ${result.exitCode}: ${result.output.toString().slice(-300).trim()})`);
    const sent: KenanSend = { id, at: now(), to: recipient, text: args.text, attachments: args.attachments, outcome, receipt, agentId };
    await ownedDir(person, dataDir(person));
    const handle = await open(sentFile(person, args.own), 'a', 0o600);
    try { if ((await handle.stat()).uid !== person.uid) await handle.chown(person.uid, person.gid); await handle.appendFile(JSON.stringify(sent) + '\n'); }
    finally { await handle.close(); }
    return sent;
  });
  senders.set(key, run.catch(() => {}));
  return run;
}

// ---- Tool ----

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
const storeOf = (person: PersonConfig): string => person.signalStore ?? (() => { throw new Error(`signal_not_linked: ${person.name} has no linked Signal account (signalStore is null)`); })();

export const signalExtension: Extension = {
  id: 'signal', name: 'Signal',
  promptSnippet: `Signal: account "kenan-own" selects Kenan’s own account for history; the default is the person’s account. The signal tool reads one Signal conversation's history (her own messages from her phone included); the inbox tool lists and waits for Signal messages; send answers on Signal (signal:CONTACT or signal:group:ID), only about Business or to the people she lets Kenan message directly.`,
  tool: ({ person, deps }) => ({
    name: 'signal', files: 'none', records: 'none', label: 'Signal',
    description: `Read ${person.name}'s Signal history (her own account, which Kenan shares as a linked device): direct and group chats, her own messages sent from her phone included, receipts and typing left out. action "history": one conversation as readable lines, oldest first, with the time in her current time zone (time, sender, text, quoted replies, reactions, edits, deletions, attachments with their saved paths, which read can open); chat is a contact name, number, UUID, group name or group id (an exact match wins; several partial ones is signal_chat_ambiguous listing them); limit 1–100 (40 when omitted); before (sentAt ms of the oldest line you have) pages back. Find the messages to read with the inbox tool (recent, wait); its items name the chatId to pass here. Sending is the send tool's signal channel (signal:CONTACT, signal:group:ID), which carries ${person.name}'s rule that Kenan answers on her Signal only about Business or to the people she lets it message directly.`,
    parameters: Type.Object({
      action: Type.Literal('history'),
      account: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('kenan-own')])),
      chat: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      before: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (_id, raw: unknown) => {
      const args = raw as { action: 'history'; account?: 'person' | 'kenan-own'; chat?: string; limit?: number; before?: number };
      const zone = zoneOrHome(await deps.store.zoneOf(person.id));
      switch (args.action) {
        case 'history': {
          if (!args.chat) throw new Error('invalid_input: history needs chat');
          const { index, shown } = await context(person, args.account === 'kenan-own' ? ownStore(person) : storeOf(person), zone, args.account === 'kenan-own');
          const chat = resolveConversation(index, args.chat);
          const limit = args.limit ?? 40;
          const mine = shown.filter(s => s.chat.key === chat.key && (args.before === undefined || s.at < args.before));
          const page = mine.slice(0, limit).reverse();
          return result({ zone, chat: chat.name, chatId: ids(chat)[0] ?? null, lines: page.map(s => s.line), more: mine.length > limit, before: page[0]?.at ?? null });
        }
        default: throw new Error(`Unknown signal action ${String((args as { action: unknown }).action)}`);
      }
    },
  }),
};

const ownStoreIfHara = (person: PersonConfig) => person.id === 'alice' ? ownStore(person) : null;

/** A group, or a direct recipient with a UUID; a contact signal-cli has no UUID for can't be sent to. */
export async function recipientOf(person: PersonConfig, store: string, to: string): Promise<SendTarget> {
  const { index } = await context(person, store, zoneOrHome(null), store === ownStoreIfHara(person));
  const known = UUID.test(to) || NUMBER.test(to) ? [...index.conversations.values()].find(c => c.chat.kind === 'direct' && ids(c).includes(to)) : undefined;
  if (!known && UUID.test(to)) return { kind: 'direct', uuid: to, number: null, name: index.names.get(to) ?? null };
  const chat = known ?? resolveConversation(index, to);
  if (chat.chat.kind === 'group') return { kind: 'group', id: chat.chat.id, name: bare(chat) };
  if (!chat.chat.uuid) throw new Error(`signal_recipient_unknown: no Signal UUID known for ${chat.name}`);
  return { kind: 'direct', uuid: chat.chat.uuid, number: chat.chat.number, name: bare(chat) };
}
