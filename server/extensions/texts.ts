// Texts from the person's phone. The Android app forwards incoming SMS and its default messaging app's notifications
// (RCS, chat) to POST /api/ext/texts; they are kept only in the person's home, one JSON line each. The inbox tool reads
// them (textRows, waitForText), and this file keeps the feed, the routes and what the send tool needs to know.
import { watch } from 'node:fs';
import { chown, mkdir, open, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PersonConfig } from '../config.js';
import { fail } from '../db/errors.js';
import { personOf } from '../http/app.js';
import type { Extension } from '../types.js';
import { mediaSettings } from './phone.js';
import { outboundSetup, sendText, type Fetch, type OutboundSetup } from './texts-outbound.js';
import { personKeptLines, personLine, spaced, startLines, stopLines, type LineSetup } from './texts-line.js';
import { telnyxHooks } from './texts-telnyx.js';
import { rowMatches, type InboxRow } from './inbox-rows.js';

/** A text her own phone forwarded. */
export interface PhoneText { id: string; source: 'sms' | 'notification'; line?: string; app: string; sender: string; body: string; at: number; storedAt: number }
/** A text on Kenan's own line (`line`, E.164), received from or sent to another number; media are the MMS attachment URLs. */
export type LineText = { id: string; source: 'line'; line: string; body: string; at: number; storedAt: number } & (
  | { direction: 'received'; from: string; media: string[] }
  | { direction: 'sent'; to: string; sentBy: LineSender });
/** Who sent a text from the line: an agent through the send tool, or another client signed in to the line's account. */
export type LineSender = { kind: 'agent'; agentId: string } | { kind: 'client'; resource: string };
/** A text an agent sent through the A2P provider in media.telephone.outboundTexts (from the provider's numbers, not Kenan's line). */
export interface A2pText { id: string; source: 'a2p'; provider: 'textbelt'; direction: 'sent'; to: string; body: string; at: number; storedAt: number; sentBy: { kind: 'agent'; agentId: string } }
export type Text = PhoneText | LineText | A2pText;
const fromPhone = (t: { source: Text['source'] }): t is PhoneText => t.source === 'sms' || t.source === 'notification';
export type Unstored<T> = T extends unknown ? Omit<T, 'storedAt'> : never;
type Incoming = Unstored<Text>;
type Parsed = { ok: true; value: Unstored<PhoneText>[] } | { ok: false; error: string };

/** The same message reaching us twice (as an SMS and as its Messages notification, or again from the inbox sync) is kept once. */
const DUPLICATE_WINDOW_MS = 10 * 60_000;

export const textsDir = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan');
export const textsFile = (person: Pick<PersonConfig, 'home'>) => join(textsDir(person), 'texts.jsonl');

export function parseTexts(raw: unknown): Parsed {
  const list = (raw as { texts?: unknown } | null)?.texts;
  if (!Array.isArray(list) || list.length > 500) return { ok: false, error: 'texts: array of at most 500' };
  const value: Unstored<PhoneText>[] = [];
  for (const item of list) {
    const t = item as Record<string, unknown> | null;
    if (!t || typeof t !== 'object') return { ok: false, error: 'each text must be an object' };
    const { id, source, app, sender, body, at } = t;
    if (typeof id !== 'string' || !id || id.length > 200) return { ok: false, error: 'id: 1–200 characters' };
    if (source !== 'sms' && source !== 'notification') return { ok: false, error: 'source: "sms" or "notification"' };
    if (typeof app !== 'string' || !app || app.length > 200) return { ok: false, error: 'app: 1–200 characters' };
    if (typeof sender !== 'string' || !sender || sender.length > 200) return { ok: false, error: 'sender: 1–200 characters' };
    if (typeof body !== 'string' || !body || body.length > 10_000) return { ok: false, error: 'body: 1–10000 characters' };
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return { ok: false, error: 'at: epoch milliseconds' };
    value.push({ id, source, app, sender, body, at });
  }
  return { ok: true, value };
}

export async function readTexts(person: Pick<PersonConfig, 'home'>): Promise<Text[]> {
  const data = await readFile(textsFile(person), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line) as Text);
}

/** Creates dir (0700) and every missing parent as the person's own, so only they and the channel can read it. */
export async function ownedDir(person: Pick<PersonConfig, 'uid' | 'gid'>, dir: string) {
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created) for (let d = dir; d.length >= created.length; d = join(d, '..')) await chown(d, person.uid, person.gid);
  return dir;
}

const writers = new Map<string, Promise<unknown>>();
/** Appends the texts not already kept; one writer per file at a time. Returns the newly kept ones. */
export function storeTexts(person: PersonConfig, incoming: Incoming[], now: number): Promise<Text[]> {
  const file = textsFile(person);
  const run = (writers.get(file) ?? Promise.resolve()).then(async () => {
    const kept = await readTexts(person);
    const ids = new Set(kept.map(t => t.id));
    const fresh: Text[] = [];
    for (const t of incoming) {
      if (ids.has(t.id)) continue;
      if (fromPhone(t) && [...kept, ...fresh].some(k => fromPhone(k) && k.body === t.body && Math.abs(k.at - t.at) < DUPLICATE_WINDOW_MS)) continue;
      ids.add(t.id); fresh.push({ ...t, storedAt: now } as Text);
    }
    if (!fresh.length) return fresh;
    await ownedDir(person, textsDir(person));
    const handle = await open(file, 'a', 0o600);
    try {
      const { uid } = await handle.stat();
      if (uid !== person.uid) await handle.chown(person.uid, person.gid);
      await handle.appendFile(fresh.map(t => JSON.stringify(t) + '\n').join(''));
    } finally { await handle.close(); }
    return fresh;
  });
  writers.set(file, run.catch(() => {}));
  return run;
}

/** A text as an inbox row. */
export function textRow(t: Text): InboxRow {
  const id = `texts:${t.id}`;
  if (fromPhone(t)) return { id, source: 'texts', at: t.at, from: t.sender, where: t.line ? `mobile line ${spaced(t.line)}` : `phone, ${t.app}`, text: t.body, chatId: null };
  if (t.source === 'a2p') return { id, source: 'texts', at: t.at, from: 'Kenan', where: `sent through ${t.provider}`, text: t.body, chatId: t.to };
  if (t.direction === 'received') return { id, source: 'texts', at: t.at, from: t.from, where: `Kenan's line ${spaced(t.line)}`, text: `${t.body}${t.media.length ? ` (attachments: ${t.media.join(' ')})` : ''}`, chatId: t.from };
  return { id, source: 'texts', at: t.at, from: 'Kenan', where: `Kenan's line ${spaced(t.line)}`, text: t.body, chatId: t.to };
}
export const textRows = async (person: PersonConfig): Promise<InboxRow[]> => (await readTexts(person)).map(t => textRow(fromPhone(t) && !t.line && person.phones[0] ? { ...t, line: person.phones[0] } : t));

/** Texts that came in (on her phone or Kenan's line) and match: what wait and text wakes look for. */
export const arrivedMatching = (query: string | undefined) => (t: Text) => (fromPhone(t) || t.direction === 'received') && rowMatches(query)(textRow(t));
export const describeText = (t: Text) => fromPhone(t) ? `text from ${t.sender} (${t.app})`
  : t.source === 'a2p' ? `text sent through ${t.provider} to ${t.to}`
  : t.direction === 'received' ? `text to Kenan's line ${t.line} from ${t.from}` : `text sent from Kenan's line ${t.line} to ${t.to}`;

/** Resolves with the first hit `find` returns, checked again each time `file` changes (a line appended to the feed),
 *  or null once the timeout passes. */
export async function waitForNew<T>(person: PersonConfig, file: string, find: () => Promise<T | null>, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  const dir = await ownedDir(person, textsDir(person));
  return new Promise<T | null>((resolve, reject) => {
    let settled = false, checking = Promise.resolve();
    const finish = (value: T | null, error?: unknown) => {
      if (settled) return; settled = true;
      watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve(value);
    };
    const check = () => { checking = checking.then(find).then(t => { if (t) finish(t); }, e => finish(null, e)); };
    const aborted = () => finish(null, new Error('Wait cancelled'));
    const watcher = watch(dir, (_event, name) => { if (name === basename(file)) check(); });
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener('abort', aborted);
    check();
  });
}

/** Resolves with the newest text that came in at or after `since` and matches, or null once the timeout passes. */
export function waitForText(person: PersonConfig, query: string | undefined, chat: string | undefined, since: number, timeoutMs: number, signal?: AbortSignal): Promise<InboxRow | null> {
  return waitForNew(person, textsFile(person), async () => {
    const hits = (await readTexts(person)).filter(t => t.storedAt >= since && arrivedMatching(query)(t)).map(textRow).filter(rowMatches(undefined, chat));
    return hits.at(-1) ?? null;
  }, timeoutMs, signal);
}

const RECIPIENT = /^(\+[1-9]\d{6,14}|\d{3,8})$/;

export function outboundOf(person: PersonConfig): OutboundSetup | { kind: 'invalid'; error: string } {
  try { const setup = outboundSetup(mediaSettings(person)); return setup.ok ? setup.value : { kind: 'invalid', error: setup.error }; }
  catch (e) { return { kind: 'invalid', error: `extension config unreadable: ${e}` }; }
}

/** What the send tool's texts channel does for this person. */
export function sendDescription(setup: ReturnType<typeof outboundOf>): string {
  switch (setup.kind) {
    case 'none': return 'texts: fails, there is no outbound texting for this person.';
    case 'invalid': return `texts: fails, outbound texting is misconfigured (${setup.error}).`;
    case 'configured': switch (setup.route.kind) {
      case 'telnyx': return `texts:+E164 texts someone from ${spaced(setup.route.fromNumber)} through Telnyx under the configured messaging policy. One person at a time, on the owner's behalf, never bulk. Returns {status:"accepted", provider:"telnyx", id}; acceptance is not delivery. On sms_provider_unreachable, check Telnyx message records before resending.`;
      case 'forbidden': return `texts: Kenan's line can't send texts, so it always fails with sms_outbound_not_permitted (${setup.route.reason}).`;
      case 'textbelt': return `texts:+E164 texts someone through Textbelt, a registered business-texting service. It goes out from Textbelt's shared numbers, not Kenan's line; replies to those never reach us, so every text gets the line "${setup.route.footer}" added at the end (don't repeat it), and replies arrive as texts to Kenan's line ${spaced(setup.route.replyLine)}. One person at a time, on the owner's behalf, never bulk; returns {status:"sent", id, quotaRemaining}, or a typed error (sms_provider_refused, sms_provider_unreachable: the text may or may not have gone out, check before resending).`;
    }
  }
}

/** Texts someone on the person's outbound route (the send tool's texts route, server/channels/send.ts). */
export async function sendTextAs(person: PersonConfig, agentId: string, to: string | undefined, body: string | undefined, fetcher: Fetch, now: () => number) {
  if (to === undefined || !RECIPIENT.test(to)) throw new Error('invalid_number: to must be E.164 like "+12025550106", or a short code\'s digits');
  if (body === undefined || !body.trim()) throw new Error('invalid_input: body is required for send');
  const setup = outboundOf(person);
  if (setup.kind === 'invalid') throw new Error(`outbound_texts_misconfigured: ${setup.error}`);
  if (setup.kind === 'none') throw new Error(`no_outbound_texts: ${person.name} has no outbound texting`);
  const sent = await sendText(setup.route, to, body, fetcher);
  if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
  const common = { id: `${sent.value.provider}:${sent.value.id}`, direction: 'sent' as const, to, body: sent.value.body, at: now(), sentBy: { kind: 'agent' as const, agentId } };
  await storeTexts(person, [sent.value.provider === 'telnyx' ? { ...common, source: 'line', line: sent.value.from } : { ...common, source: 'a2p', provider: sent.value.provider }], now());
  return sent.value;
}

function lineOf(person: PersonConfig, channel: string): LineSetup | { kind: 'invalid'; error: string } {
  try { const setup = personLine(person, channel); return setup.ok ? setup.value : { kind: 'invalid', error: setup.error }; }
  catch (e) { return { kind: 'invalid', error: `extension config unreadable: ${e}` }; }
}

function lineDescription(setup: ReturnType<typeof lineOf>): string {
  switch (setup.kind) {
    case 'none': return '';
    case 'invalid': return ` Kenan's own line is misconfigured (${setup.error}).`;
    case 'here': case 'elsewhere': return ` Texts to Kenan's own line ${spaced(setup.config.line)} are in the same feed.`;
  }
}

function keptDescription(person: PersonConfig, channel: string): string {
  const kept = (() => { try { return personKeptLines(person, channel); } catch (e) { return { ok: false as const, error: `extension config unreadable: ${e}` }; } })();
  if (!kept.ok) return ` ${person.name}'s kept numbers are misconfigured (${kept.error}).`;
  return kept.value.lines.map(l => ` Texts to ${l.name} ${spaced(l.config.line)} are in the same feed too; it can't send either.`).join('');
}

/** Phone SMS/RCS forwarding, plus Kenan's line and the kept numbers. */
export const textsDescription = (person: PersonConfig, channel: string): string => ` Incoming SMS and messaging-app notifications (including RCS) forwarded by the Kenan Android app${person.phones[0] ? ` from mobile line ${spaced(person.phones[0])}` : " from the person's phone"} are in the texts feed. Forwarding does not require accessibility or a screen session; Android SMS and notification permissions are requested once inside the app. phone_settings status reports texts diagnostics.${lineDescription(lineOf(person, channel))}${keptDescription(person, channel)}`;

export const textsExtension: Extension = {
  id: 'texts', name: 'Texts',
  hooks: (app, deps) => telnyxHooks(app, deps),
  start: startLines,
  stop: stopLines,
  routes(app, deps) {
    app.use('*', async (c, next) => { if (!deps.person(personOf(c))?.extensions.includes('texts')) fail('forbidden', 'Texts are not enabled'); await next(); });
    app.post('/', async c => {
      const parsed = parseTexts(await c.req.json().catch(() => null));
      if (!parsed.ok) return fail('invalid_input', parsed.error);
      const person = deps.person(personOf(c))!;
      // The configured mobile line is authoritative; parseTexts ignores any posted number.
      const incoming = parsed.value.map(t => person.phones[0] ? { ...t, line: person.phones[0] } : t);
      const stored = await storeTexts(person, incoming, deps.now());
      return c.json({ ok: true, value: { stored: stored.length } });
    });
  },
};
