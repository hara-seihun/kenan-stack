// Kenan's own phone line for texts: JMP.chat delivers its SMS/MMS over XMPP through the cheogram gateway, to an account on
// our Prosody. The channel that answers the line holds the one client for that account: it stores every text into the
// person's texts feed and tells their Kenaznia; a text from another person's own phone (people[].phones) is theirs instead, and
// goes through the line-texts host inbox to the channel hosting their Kenaznia, which stores it in their feed and tells it. It never sends: JMP's person-to-person route forbids automated outbound SMS
// (sending goes through texts-outbound.ts). On every connect it reads the account's
// archive (MAM) from just before the newest line text it has, so a text that arrived while it was down, or went to another
// client of the account, is still stored; ids from the server's archive keep each text once.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { client, xml, type Client } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { routeBackground } from '../agents/origin.js';
import { phoneOwner, type PersonConfig } from '../config.js';
import { queueInboxFile, startHostInboxes, type InboxOutcome } from '../host-inbox.js';
import type { Deps } from '../types.js';
import { mediaSettings } from './phone.js';
import { readTexts, storeTexts, type LineText, type Unstored } from './texts.js';
import { receive, type ChannelItem } from '../channels/inbound.js';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T>(value: T) => ({ ok: true as const, value });
const err = <E>(error: E) => ({ ok: false as const, error });

/** media.telephone.texts: `{"kind":"none"}`, or the line's XMPP account at the gateway. or Telnyx webhook settings. Required whenever telephone is configured. */
export interface XmppLine { kind: 'xmpp'; line: string; jid: string; passwordPath: string; service: string; gateway: string }
/** Whether a person has a texts line, and whether this channel is the one that holds its connection (the one answering the line). */
export interface TelnyxLine { kind: 'telnyx'; line: string; publicKeyPath: string; messagingProfileId: string }
export type TextLine = XmppLine | TelnyxLine;
export type LineSetup = { kind: 'none' } | { kind: 'here'; config: TextLine } | { kind: 'elsewhere'; channel: string; config: TextLine };

const E164 = /^\+[1-9]\d{6,14}$/;
const SHAPE = 'media.telephone.texts must be {"kind":"none"} or Telnyx {kind,line,publicKeyPath,messagingProfileId}, or {"kind":"xmpp","line":"+1…","jid":"user@host","passwordPath":"/…","service":"xmpp://host:port","gateway":"cheogram.com"}';

function parseXmpp(t: Record<string, unknown>, at: string): Result<XmppLine, string> {
  const { kind, line, jid, passwordPath, service, gateway } = t;
  if (typeof line !== 'string' || !E164.test(line)) return err(`${at}.line must be the line in E.164, e.g. "+12025550102"`);
  if (typeof jid !== 'string' || !/^[^@/\s]+@[^@/\s]+$/.test(jid)) return err(`${at}.jid must be a bare JID, user@host`);
  if (typeof passwordPath !== 'string' || !passwordPath.startsWith('/')) return err(`${at}.passwordPath must be an absolute path`);
  if (typeof service !== 'string' || !/^xmpps?:\/\/[^\s/]+$/.test(service)) return err(`${at}.service must be xmpp://host:port or xmpps://host:port`);
  if (typeof gateway !== 'string' || !/^[a-z0-9.-]+$/i.test(gateway)) return err(`${at}.gateway must be the gateway domain, e.g. "cheogram.com"`);
  return ok({ kind: kind as 'xmpp', line, jid, passwordPath, service, gateway });
}

function answeringChannel(telephone: Record<string, unknown>): string | null {
  const inbound = telephone.inbound as { kind?: unknown; channel?: unknown } | undefined;
  return inbound?.kind === 'answered' && typeof inbound.channel === 'string' ? inbound.channel : null;
}

export function lineSetup(media: unknown, channel: string): Result<LineSetup, string> {
  const telephone = (media as { telephone?: Record<string, unknown> } | null)?.telephone;
  if (!telephone || telephone.kind !== 'configured') return ok({ kind: 'none' });
  const t = telephone.texts as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') return err(SHAPE);
  if (t.kind === 'none' && Object.keys(t).length === 1) return ok({ kind: 'none' });
  if (t.kind === 'telnyx') {
    if (Object.keys(t).sort().join(',') !== 'kind,line,messagingProfileId,publicKeyPath' || typeof t.line !== 'string' || !E164.test(t.line)
      || typeof t.publicKeyPath !== 'string' || !t.publicKeyPath.startsWith('/') || typeof t.messagingProfileId !== 'string' || !t.messagingProfileId.trim()) return err('Telnyx texts require kind, line (E.164), publicKeyPath (absolute path), messagingProfileId');
    const answering = answeringChannel(telephone);
    if (!answering) return err('Telnyx texts require media.telephone.inbound to name the answering channel');
    const config: TelnyxLine = { kind: 'telnyx', line: t.line, publicKeyPath: t.publicKeyPath, messagingProfileId: t.messagingProfileId };
    return ok(answering === channel ? { kind: 'here', config } : { kind: 'elsewhere', channel: answering, config });
  }
  if (t.kind !== 'xmpp' || Object.keys(t).length !== 6) return err(SHAPE);
  const config = parseXmpp(t, 'media.telephone.texts');
  if (!config.ok) return config;
  const answering = answeringChannel(telephone);
  if (!answering) return err('media.telephone.texts is an XMPP line but media.telephone.inbound names no channel answering the line, so no channel would hold it');
  return ok(answering === channel ? { kind: 'here', config: config.value } : { kind: 'elsewhere', channel: answering, config: config.value });
}

/** A number the person keeps on an XMPP gateway account of their own (an old number ported in), received only. `name` says what
 *  the number is in arrival notes, e.g. "Alice's old Canadian number". */
export interface KeptLine { config: XmppLine; name: string }
const KEPT_SHAPE = 'media.telephone.keptLines must be a list of {"line":"+1…","name":"…","jid":"user@host","passwordPath":"/…","service":"xmpp://host:port","gateway":"cheogram.com"}';

/** media.telephone.keptLines: absent when the person keeps no other numbers. Held by the channel answering the person's line,
 *  so `here` says whether that is `channel`. */
export function keptLines(media: unknown, channel: string): Result<{ here: boolean; lines: KeptLine[] }, string> {
  const telephone = (media as { telephone?: Record<string, unknown> } | null)?.telephone;
  if (!telephone || telephone.kind !== 'configured' || telephone.keptLines === undefined) return ok({ here: false, lines: [] });
  const list = telephone.keptLines;
  if (!Array.isArray(list)) return err(KEPT_SHAPE);
  const answering = answeringChannel(telephone);
  if (list.length && !answering) return err('media.telephone.keptLines is set but media.telephone.inbound names no channel answering the line, so no channel would hold them');
  const lines: KeptLine[] = [];
  for (const [i, entry] of list.entries()) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || Object.keys(e).length !== 6 || typeof e.name !== 'string' || !e.name.trim()) return err(KEPT_SHAPE);
    const config = parseXmpp({ ...e, kind: 'xmpp' }, `media.telephone.keptLines[${i}]`);
    if (!config.ok) return config;
    lines.push({ config: config.value, name: e.name });
  }
  return ok({ here: answering === channel, lines });
}

export const personLine = (person: PersonConfig, channel: string) => lineSetup(mediaSettings(person), channel);
export const personKeptLines = (person: PersonConfig, channel: string) => keptLines(mediaSettings(person), channel);
export const KENAN_LINE = "Kenan's line";

/** What one message stanza on the line's account means. `archive`: its id in the account's archive and when it was archived. */
export type LineStanza =
  | { kind: 'received'; text: Unstored<Extract<LineText, { direction: 'received' }>> }
  | { kind: 'sent'; text: Unstored<Extract<LineText, { direction: 'sent' }>> }
  | { kind: 'error'; messageId: string | null; peer: string; condition: string; detail: string | null }
  | { kind: 'system'; from: string; body: string }
  | { kind: 'ignored' };
export interface Archived { id: string; at: number }

const STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const bare = (jid: string) => jid.split('/')[0]!.toLowerCase();
const resourceOf = (jid: string) => { const i = jid.indexOf('/'); return i < 0 ? '' : jid.slice(i + 1); };
/** The number a gateway JID stands for: E.164 for phone numbers, digits for short codes; null for the gateway itself and anything else. */
function numberOf(jid: string, gateway: string): string | null {
  const [local, domain] = bare(jid).split('@');
  return domain === gateway.toLowerCase() && local && /^\+?\d{2,15}$/.test(local) ? local : null;
}

export function classify(message: Element, config: XmppLine, archived: Archived | null, now: number): LineStanza {
  const from = message.attrs.from as string | undefined ?? '', to = message.attrs.to as string | undefined ?? '';
  const id = message.attrs.id as string | undefined ?? null;
  if (message.attrs.type === 'error') {
    const error = message.getChild('error');
    const condition = error?.children.find((c): c is Element => typeof c !== 'string' && c.attrs.xmlns === STANZAS && c.name !== 'text')?.name ?? 'undefined-condition';
    return { kind: 'error', messageId: id, peer: from, condition, detail: error?.getChildText('text', STANZAS) ?? null };
  }
  const body = message.getChildText('body') ?? '';
  const media = message.getChildren('x', 'jabber:x:oob').map(x => x.getChildText('url')).filter((u): u is string => !!u);
  if (!body && !media.length) return { kind: 'ignored' };
  const account = config.jid.toLowerCase();
  const at = archived?.at ?? stamp(message) ?? now;
  if (bare(from) === account) {
    const number = numberOf(to, config.gateway);
    if (!number || !id) return { kind: 'ignored' };
    return { kind: 'sent', text: { id: sentId(id), source: 'line', line: config.line, direction: 'sent', to: number, body, at, sentBy: { kind: 'client', resource: resourceOf(from) } } };
  }
  const number = numberOf(from, config.gateway);
  if (!number) return { kind: 'system', from, body };
  const stanzaId = archived?.id ?? message.getChildren('stanza-id', 'urn:xmpp:sid:0').find(s => (s.attrs.by as string | undefined)?.toLowerCase() === account)?.attrs.id as string | undefined;
  const key = stanzaId ? `xmpp:${stanzaId}` : `xmpp-message:${number}:${id ?? at}`;
  return { kind: 'received', text: { id: key, source: 'line', line: config.line, direction: 'received', from: number, body, media, at } };
}
export const sentId = (messageId: string) => `xmpp-out:${messageId}`;
function stamp(message: Element): number | null {
  const value = message.getChild('delay', 'urn:xmpp:delay')?.attrs.stamp as string | undefined;
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}
/** A message carrying an archive (MAM) result: the archived message and its archive id and time; null for any other message. */
export function unwrapArchived(message: Element): { message: Element; archived: Archived } | null {
  const result = message.getChild('result', 'urn:xmpp:mam:2');
  const forwarded = result?.getChild('forwarded', 'urn:xmpp:forward:0');
  const inner = forwarded?.getChild('message');
  const id = result?.attrs.id as string | undefined;
  const at = forwarded ? stamp(forwarded) : null;
  return inner && id && at !== null ? { message: inner, archived: { id, at } } : null;
}

/** `+12025550102` → `+12025550102`; other numbers as they are. */
export const spaced = (n: string) => n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 $1 $2 $3');
type Received = Unstored<Extract<LineText, { direction: 'received' }>>;
const attachments = (text: Received) => text.media.length ? `\nAttachments: ${text.media.join(' ')}` : '';
/** A text to a Kenan line as a channel item. `routed`: the person texted another person's line (`lineOwner`) from their own phone. */
export function lineItem(text: Received, name: string, routed: { person: Pick<PersonConfig, 'name'>; lineOwner: string } | null): ChannelItem {
  return {
    id: `texts:${text.id}`, source: 'texts', channel: `texts:${text.from}`, replyTo: null, fromId: null, at: text.at,
    from: routed ? `${routed.person.name} (own phone ${spaced(text.from)})` : spaced(text.from),
    where: routed ? `to ${routed.lineOwner}'s Kenan line ${spaced(text.line)}` : `to ${name} ${spaced(text.line)}`,
    thread: `texts:${text.from}`, subject: null, contextOnly: false, text: `${text.body}${attachments(text)}`,
    open: `${routed ? `It is kept in ${routed.person.name}'s texts feed. ` : ''}Reply using send's texts channel only when its configured policy allows it; otherwise answer by call, email or in the app.`,
  };
}

/** Texts to a line from another person's own phone wait here, per recipient, for the channel hosting their Kenaznia. */
export const LINE_TEXT_INBOX_ROOT = '/var/lib/kenan/line-texts';
export interface RoutedText { lineOwner: string; text: Received }
const E164_OR_CODE = /^\+?\d{2,15}$/;
export function parseRoutedText(raw: unknown): Result<RoutedText, string> {
  const r = raw as { lineOwner?: unknown; text?: Record<string, unknown> } | null;
  if (!r || typeof r !== 'object' || Object.keys(r).length !== 2 || typeof r.lineOwner !== 'string' || !r.lineOwner.trim()) return err('file must be {lineOwner, text}');
  const t = r.text;
  if (!t || typeof t !== 'object' || t.source !== 'line' || t.direction !== 'received') return err('text: a received line text');
  if (typeof t.id !== 'string' || !t.id || typeof t.line !== 'string' || !E164.test(t.line) || typeof t.from !== 'string' || !E164_OR_CODE.test(t.from)) return err('text: id, line and from');
  if (typeof t.body !== 'string' || !Array.isArray(t.media) || t.media.some(m => typeof m !== 'string') || typeof t.at !== 'number' || !Number.isSafeInteger(t.at)) return err('text: body, media and at');
  return ok({ lineOwner: r.lineOwner, text: { id: t.id, source: 'line', line: t.line, direction: 'received', from: t.from, body: t.body, media: t.media as string[], at: t.at } });
}
export async function queueRoutedText(root: string, person: Pick<PersonConfig, 'id' | 'uid' | 'gid'>, routed: RoutedText): Promise<void> {
  await queueInboxFile(root, person, routed);
}
/** A received text is the line owner's, kept in their feed, unless it came from another person's own phone: then it is queued
 *  for the channel hosting that person's Kenaznia. */
export async function receiveLineText(deps: Pick<Deps, 'config' | 'now'>, lineOwner: PersonConfig, text: Received, inboxRoot: string): Promise<{ kind: 'routed'; to: string } | { kind: 'kept'; fresh: boolean }> {
  const owner = phoneOwner(deps.config.people, text.from);
  if (owner && owner.id !== lineOwner.id) {
    await queueRoutedText(inboxRoot, owner, { lineOwner: lineOwner.name, text });
    return { kind: 'routed', to: owner.id };
  }
  return { kind: 'kept', fresh: (await storeTexts(lineOwner, [text], deps.now())).length > 0 };
}
/** Stores each routed text in its recipient's feed once and tells their Kenaznia; for every person whose Kenaznia runs here. */
export function startRoutedTexts(deps: Deps, root: string): Promise<() => void> {
  return startHostInboxes(deps, root, 'line_text_inbox', async (person, raw): Promise<InboxOutcome> => {
    const parsed = parseRoutedText(raw);
    if (!parsed.ok) return { kind: 'rejected', error: parsed.error };
    const fresh = await storeTexts(person, [parsed.value.text], deps.now());
    if (fresh.length) await receive(deps, person, [lineItem(parsed.value.text, KENAN_LINE, { person, lineOwner: parsed.value.lineOwner })]);
    return { kind: 'taken' };
  });
}

/** Puts `text` in the person's Kenaznia's conversation and current turn; false when their Kenaznia isn't on this channel. */
export async function tellManager(deps: Deps, person: PersonConfig, fromId: string, text: string): Promise<boolean> {
  const managerId = deps.runtime.managerFor(person.id);
  const agent = managerId ? await deps.store.getAgent(managerId) : null;
  if (!agent) return false;
  const route = await routeBackground(deps, agent, null);
  const notice = await deps.store.appendMessage({ conversationId: route.conversationId, authorId: agent.id, role: 'notice', notice: 'system', text });
  deps.bus.toConversation(route.conversationId, { type: 'message', message: notice });
  deps.runtime.deliver({ agentId: agent.id, kind: 'note', fromId, ...route, text });
  return true;
}

/** Reconnect delays grow exponentially from BASE to MAX with jitter; they start over only after a connection stayed up STABLE. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const STABLE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;
/** An idle connection pings the server (XEP-0199) this often; no answer within PING_TIMEOUT ends it, so a dead link is noticed. */
const PING_EVERY_MS = 60_000;
const PING_TIMEOUT_MS = 20_000;
/** Archive entries are read from this long before the newest line text kept, so clock skew between the two loses nothing. */
const CATCH_UP_OVERLAP_MS = 5 * 60_000;
const ARCHIVE_PAGE = 100;

type SessionOutcome = { kind: 'ended'; upMs: number; reason: string | null } | { kind: 'failed'; reason: string };
const errorText = (e: unknown) => String((e as Error)?.message ?? e);
const describe = (o: SessionOutcome) => o.kind === 'failed' ? `failed: ${o.reason}` : `closed after ${Math.round(o.upMs / 1000)}s${o.reason ? `: ${o.reason}` : ''}`;
/** The wait before reconnect attempt `attempt` (0 after a stable connection): exponential with equal jitter, `unit` in [0, 1). */
export function backoff(attempt: number, unit: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(ceiling / 2 + unit * ceiling / 2);
}

export function withoutStreamManagement(element: Element) {
  if (element.is('features', 'http://etherx.jabber.org/streams')) for (const sm of element.getChildren('sm', 'urn:xmpp:sm:3')) element.remove(sm);
}

export class LineConnection {
  private endSession: (() => void) | null = null;
  private stopped = false;
  private wakeUp: (() => void) | null = null;
  private work: Promise<void> = Promise.resolve();
  private lastLogged: string | null = null;
  private running: Promise<void> | null = null;

  constructor(private deps: Deps, private person: PersonConfig, readonly config: XmppLine, private resource: string, readonly name: string) {}

  start() { this.running ??= this.run(); }
  async stop() {
    this.stopped = true; this.wakeUp?.();
    this.endSession?.();
    await this.running;
  }

  private async run() {
    let attempt = 0;
    while (!this.stopped) {
      const outcome = await this.session();
      if (this.stopped) return;
      attempt = outcome.kind === 'ended' && outcome.upMs >= STABLE_MS ? 0 : attempt + 1;
      const delay = backoff(attempt, Math.random());
      await this.log(`connection to ${this.config.jid} ${describe(outcome)}; retrying in ${Math.round(delay / 1000)}s`);
      await new Promise<void>(resolve => { const t = setTimeout(resolve, delay); this.wakeUp = () => { clearTimeout(t); resolve(); }; });
    }
  }

  /** One connection, from connect to disconnect: `ended` when a connection that came online ends, `failed` when it never did. */
  private async session(): Promise<SessionOutcome> {
    const [username, domain] = this.config.jid.split('@') as [string, string];
    let password: string;
    try { password = readFileSync(this.config.passwordPath, 'utf8').trim(); } catch (e) { return { kind: 'failed', reason: `password unreadable: ${(e as Error).message}` }; }
    const xmpp = client({ service: this.config.service, domain, resource: this.resource, username, password });
    xmpp.reconnect.stop();
    // xmpp.js 0.14's stream management miscounts handled stanzas (it counts presences that arrive before <enabled/>, never counts
    // iq results), and Prosody closes the stream when the count runs high, which happened whenever another resource was online.
    // The line needs none of it: each connect reads the archive, and pings below notice a dead link. So it is never offered.
    xmpp.prependListener('element', withoutStreamManagement);
    let streamError: string | null = null;
    let endSession!: () => void;
    const ended = new Promise<void>(resolve => {
      this.endSession = endSession = resolve;
      xmpp.on('disconnect', resolve); xmpp.on('offline', resolve);
    });
    xmpp.on('error', e => { streamError ??= errorText(e); });
    xmpp.on('stanza', stanza => { if (stanza.is('message')) this.enqueue(stanza); });
    let onlineAt: number | null = null;
    let pinger: ReturnType<typeof setInterval> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // xmpp.start waits for 'online' but never rejects a silent socket close during negotiation.
      await Promise.race([
        xmpp.start(),
        ended.then(() => { throw new Error('disconnected before authentication completed'); }),
        new Promise<never>((_, reject) => { connectTimer = setTimeout(() => reject(new Error('authentication timed out')), CONNECT_TIMEOUT_MS); }),
      ]);
      clearTimeout(connectTimer);
      onlineAt = Date.now();
      this.lastLogged = null;
      pinger = setInterval(() => {
        xmpp.iqCaller.request(xml('iq', { type: 'get', to: domain }, xml('ping', { xmlns: 'urn:xmpp:ping' })), PING_TIMEOUT_MS)
          .catch((e: unknown) => { streamError ??= `ping unanswered: ${errorText(e)}`; endSession(); });
      }, PING_EVERY_MS);
      await xmpp.send(xml('presence'));
      await Promise.race([this.catchUp(xmpp), ended]);
      await ended;
      return { kind: 'ended', upMs: Date.now() - onlineAt, reason: streamError };
    } catch (e) {
      return onlineAt === null ? { kind: 'failed', reason: streamError ?? errorText(e) } : { kind: 'ended', upMs: Date.now() - onlineAt, reason: streamError ?? errorText(e) };
    } finally {
      clearTimeout(connectTimer);
      if (pinger) clearInterval(pinger);
      this.endSession = null;
      // A broken transport must not hold the reconnect loop (or shutdown) in graceful close.
      const transport = xmpp.socket as Socket | { socket: Socket | null } | null;
      const socket = transport instanceof Socket ? transport : transport?.socket;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          xmpp.stop().catch(() => {}),
          new Promise<void>(resolve => { closeTimer = setTimeout(resolve, CLOSE_TIMEOUT_MS); }),
        ]);
      } finally { clearTimeout(closeTimer); socket?.destroy(); }
    }
  }

  /** Reads the account's archive from just before the newest line text kept, page by page; every entry goes through the same handling. */
  private async catchUp(xmpp: Client) {
    const feeds = [this.person, ...this.deps.config.people.filter(p => p.id !== this.person.id && p.phones.length)];
    const newest = (await Promise.all(feeds.map(readTexts))).flat().filter(t => t.source === 'line' && t.line === this.config.line).reduce<number | null>((m, t) => m === null || t.at > m ? t.at : m, null);
    const fields = [xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'urn:xmpp:mam:2'))];
    if (newest !== null) fields.push(xml('field', { var: 'start' }, xml('value', {}, new Date(newest - CATCH_UP_OVERLAP_MS).toISOString())));
    let after: string | null = null;
    for (;;) {
      const set = xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('max', {}, String(ARCHIVE_PAGE)), ...(after ? [xml('after', {}, after)] : []));
      const fin = (await xmpp.iqCaller.request(xml('iq', { type: 'set' }, xml('query', { xmlns: 'urn:xmpp:mam:2', queryid: randomUUID() }, xml('x', { xmlns: 'jabber:x:data', type: 'submit' }, ...fields), set)), 30_000)).getChild('fin', 'urn:xmpp:mam:2');
      const last = fin?.getChild('set', 'http://jabber.org/protocol/rsm')?.getChildText('last') ?? null;
      if (!fin || fin.attrs.complete === 'true' || !last) break;
      after = last;
    }
    await this.work;
  }

  /** Stanzas are handled one at a time in arrival order; a failure is logged and the next one still handled. */
  private enqueue(stanza: Element) {
    this.work = this.work.then(() => this.handle(stanza)).catch(e => this.log(`handling a message failed: ${e}`));
  }

  private async handle(stanza: Element) {
    const unwrapped = unwrapArchived(stanza);
    const meaning = classify(unwrapped?.message ?? stanza, this.config, unwrapped?.archived ?? null, this.deps.now());
    switch (meaning.kind) {
      case 'received': {
        const kept = await receiveLineText(this.deps, this.person, meaning.text, LINE_TEXT_INBOX_ROOT);
        if (kept.kind === 'routed') console.log(JSON.stringify({ type: 'texts-line-routed', line: this.config.line, to: kept.to, id: meaning.text.id }));
        else if (kept.fresh) await receive(this.deps, this.person, [lineItem(meaning.text, this.name, null)]);
        return;
      }
      case 'sent': await storeTexts(this.person, [meaning.text], this.deps.now()); return;
      case 'error': {
        if (unwrapped) return;
        await this.log(`delivery error from ${meaning.peer} for message ${meaning.messageId}: ${meaning.condition}${meaning.detail ? ` (${meaning.detail})` : ''}`);
        await this.tellManager(`A text from ${this.name} ${spaced(this.config.line)} to ${meaning.peer} failed after it was sent: ${meaning.condition}${meaning.detail ? `: ${meaning.detail}` : ''}.`);
        return;
      }
      case 'system':
        if (!unwrapped) console.log(JSON.stringify({ type: 'texts-line-system', person: this.person.id, from: meaning.from, body: meaning.body }));
        return;
      case 'ignored': return;
    }
  }

  private async tellManager(text: string) {
    if (!await tellManager(this.deps, this.person, `line:${this.config.line}`, text)) await this.log(`no Kenaznia on this channel to tell: ${text}`);
  }

  /** Each distinct failure is logged once until the connection next comes online. */
  private async log(message: string) {
    const key = message.replace(/ after \d+s|retrying in \d+s/g, '');
    if (key === this.lastLogged) return;
    this.lastLogged = key;
    await this.deps.store.logError(`texts-line:${this.person.id}:${this.config.line}`, message).catch(() => {});
  }
}

const connections = new Map<string, LineConnection>();
export const lineConnection = (personId: string, line: string) => connections.get(`${personId}:${line}`) ?? null;

export async function startLines(deps: Deps) {
  for (const person of deps.config.people) {
    if (person.manager && 'elsewhere' in person.manager) continue;
    const guarded = <T>(read: () => Result<T, string>): Result<T, string> => { try { return read(); } catch (e) { return err(`extension config unreadable: ${e}`); } };
    const setup = guarded(() => personLine(person, deps.config.channel));
    const kept = guarded(() => personKeptLines(person, deps.config.channel));
    if (!setup.ok) await deps.store.logError(`texts-line:${person.id}`, setup.error);
    if (!kept.ok) await deps.store.logError(`texts-line:${person.id}`, kept.error);
    const held: KeptLine[] = [...(setup.ok && setup.value.kind === 'here' && setup.value.config.kind === 'xmpp' ? [{ config: setup.value.config, name: KENAN_LINE }] : []), ...(kept.ok && kept.value.here ? kept.value.lines : [])];
    if (!held.length) continue;
    if (!person.extensions.includes('texts')) { await deps.store.logError(`texts-line:${person.id}`, `${person.id} has XMPP lines configured but the texts extension is off, so their texts would be stored with no tool to read them`); continue; }
    for (const { config, name } of held) {
      const line = new LineConnection(deps, person, config, `kenan-${deps.config.channel}`, name);
      connections.set(`${person.id}:${config.line}`, line);
      line.start();
    }
  }
}

export async function stopPersonLines(personId: string) {
  const selected = [...connections.entries()].filter(([key]) => key.startsWith(`${personId}:`));
  for (const [key] of selected) connections.delete(key);
  await Promise.all(selected.map(([, line]) => line.stop()));
}

export async function stopLines() {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map(l => l.stop()));
}
