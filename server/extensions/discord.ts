// Discord. The channel hosting a person's Kenaznia connects to Discord's gateway as their bot (media config `discord`),
// keeps every message it sees (server channels and the bot's DMs) in the person's home, one JSON line each, raises the
// host event `discord:message` for each, and hands new messages to the person's watcher (watch.ts), which tells
// Kenaznia about the ones worth acting on. Agents read and send with the
// discord tool, over Discord's REST API, from any channel.
import { readFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import WebSocket from 'ws';
import type { PersonConfig } from '../config.js';
import { EVENT_INBOX_ROOT, queueHostEvent } from '../event-inbox.js';
import type { Deps, Extension } from '../types.js';
import { ownedDir, textsDir, waitForNew } from './texts.js';
import { tellManager } from './texts-line.js';
import { rowMatches, type InboxRow } from './inbox-rows.js';
import { receive, registerAcknowledger, type ChannelItem } from '../channels/inbound.js';
import { ACTIONS, runLogged, type ActionArgs } from './discord-actions.js';

const API = 'https://discord.com/api/v10';
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12, 15]);
const JUDGE_WINDOW_MS = 24 * 3600_000;
const BACKFILL_SEED = 50;
const MAX_CHUNKS = 4;

export interface DiscordMessage {
  id: string; channelId: string; channel: string; guildId: string | null; guild: string | null;
  authorId: string; author: string; fromBot: boolean; content: string;
  attachments: { name: string; url: string }[]; replyTo: string | null; at: number; storedAt: number;
  /** Stored from history the first time a channel was seen; never judged. */
  seed?: true;
}

type Setup = { kind: 'none' } | { kind: 'configured'; tokenPath: string };
type Token = { applicationId: string; token: string };

export function discordSetup(person: Pick<PersonConfig, 'extensionConfigPath'>): Setup {
  if (!person.extensionConfigPath) return { kind: 'none' };
  const d = JSON.parse(readFileSync(person.extensionConfigPath, 'utf8')).discord as Record<string, unknown> | undefined;
  if (d === undefined) return { kind: 'none' };
  const { tokenPath, ...extra } = d ?? {};
  if (typeof tokenPath !== 'string' || !tokenPath || Object.keys(extra).length)
    throw new Error('discord must be {"tokenPath": FILE}; where its messages go is the "channels" entry');
  return { kind: 'configured', tokenPath };
}

function readToken(path: string): Token {
  const t = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (typeof t.token !== 'string' || !t.token || typeof t.applicationId !== 'string') throw new Error(`discord_token_invalid: ${path} must hold {"applicationId", "token"}`);
  return { applicationId: t.applicationId, token: t.token };
}

export const discordFile = (person: Pick<PersonConfig, 'home'>) => join(textsDir(person), 'discord.jsonl');
export const messageLink = (m: Pick<DiscordMessage, 'guildId' | 'channelId' | 'id'>) => `https://discord.com/channels/${m.guildId ?? '@me'}/${m.channelId}/${m.id}`;

async function readLines<T>(file: string): Promise<T[]> {
  const data = await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}
export const readMessages = (person: Pick<PersonConfig, 'home'>) => readLines<DiscordMessage>(discordFile(person));

const writers = new Map<string, Promise<unknown>>();
async function append(person: PersonConfig, file: string, lines: unknown[]) {
  await ownedDir(person, textsDir(person));
  const handle = await open(file, 'a', 0o600);
  try {
    if ((await handle.stat()).uid !== person.uid) await handle.chown(person.uid, person.gid);
    await handle.appendFile(lines.map(l => JSON.stringify(l) + '\n').join(''));
  } finally { await handle.close(); }
}
/** Appends the messages not already kept (by id); one writer per file. Returns the newly kept ones. */
export function storeMessages(person: PersonConfig, incoming: DiscordMessage[]): Promise<DiscordMessage[]> {
  const file = discordFile(person);
  const run = (writers.get(file) ?? Promise.resolve()).then(async () => {
    const ids = new Set((await readMessages(person)).map(m => m.id));
    const fresh = incoming.filter(m => !ids.has(m.id) && ids.add(m.id));
    if (fresh.length) await append(person, file, fresh);
    return fresh;
  });
  writers.set(file, run.catch(() => {}));
  return run;
}

// ---- REST ----

export type Rest = (method: string, path: string, body?: unknown) => Promise<unknown>;
export function restFor(token: string, fetcher: typeof fetch = fetch): Rest {
  return async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      const form = body instanceof FormData;
      const res = await fetcher(`${API}${path}`, {
        method, signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bot ${token}`, 'user-agent': 'DiscordBot (https://kenan.example.com, 1)', ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 3) { const wait = Number((await res.json() as { retry_after?: number }).retry_after ?? 1); await new Promise(r => setTimeout(r, Math.min(wait, 30) * 1000)); continue; }
      const text = await res.text();
      if (!res.ok) throw new Error(`discord_http_${res.status}: ${method} ${path.split('?')[0]}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    }
  };
}

type Raw = Record<string, any>;
type ChannelInfo = { name: string; guildId: string | null };

const authorName = (a: Raw) => (a.global_name && a.global_name !== a.username ? `${a.global_name} (${a.username})` : String(a.username ?? a.id));

/** A gateway MESSAGE_CREATE (or REST message) as stored. `channels` names guild channels; a DM is named for its author. */
export function messageRecord(d: Raw, channels: ReadonlyMap<string, ChannelInfo>, guilds: ReadonlyMap<string, string>, now: number): DiscordMessage {
  const info = channels.get(d.channel_id);
  const guildId: string | null = d.guild_id ?? info?.guildId ?? null;
  return {
    id: d.id, channelId: d.channel_id, channel: info ? `#${info.name}` : guildId ? `#${d.channel_id}` : `DM with ${authorName(d.author)}`,
    guildId, guild: guildId ? guilds.get(guildId) ?? null : null,
    authorId: d.author.id, author: authorName(d.author), fromBot: Boolean(d.author.bot), content: d.type === 7 ? '(joined the server)' : String(d.content ?? ''),
    attachments: (d.attachments ?? []).map((a: Raw) => ({ name: String(a.filename), url: String(a.url) })),
    replyTo: d.message_reference?.message_id ?? null, at: Date.parse(d.timestamp), storedAt: now,
  };
}

// ---- Gateway ----

export interface GatewayHandlers { dispatch(type: string, data: Raw): void | Promise<void>; log(text: string): void; fatal(text: string): void }

/** One bot connection to Discord's gateway: identify, heartbeat, resume after drops, reconnect with backoff; a fatal
 *  close code (bad token, intents not allowed) stops it and says why. */
export class Gateway {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private acked = true;
  private stopped = false;
  private failures = 0;

  constructor(private token: string, private gatewayUrl: () => Promise<string>, private h: GatewayHandlers, private intents = INTENTS) {}

  start() { void this.connect(); }

  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.clearHeartbeat();
    this.ws?.close(1000);
  }

  private async connect() {
    if (this.stopped) return;
    let base: string;
    try { base = this.sessionId && this.resumeUrl ? this.resumeUrl : await this.gatewayUrl(); }
    catch (e) { this.h.log(`gateway url: ${e}`); return this.later(); }
    const ws = new WebSocket(`${base}/?v=10&encoding=json`);
    this.ws = ws;
    ws.on('message', raw => { try { this.receive(ws, JSON.parse(String(raw))); } catch (e) { this.h.log(`gateway message: ${e}`); } });
    ws.on('error', e => this.h.log(`gateway error: ${e.message}`));
    ws.on('close', code => {
      if (this.ws !== ws) return;
      this.ws = null; this.clearHeartbeat();
      if (code === 4004 || (code >= 4010 && code <= 4014)) { this.stopped = true; return this.h.fatal(`gateway closed ${code} (${code === 4004 ? 'bad token' : code === 4014 ? 'privileged intent not enabled for the bot' : 'not allowed'})`); }
      if (code === 4007 || code === 4009) this.sessionId = null;
      this.later();
    });
  }

  private later() {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.failures++) * (0.5 + Math.random() / 2);
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private send(ws: WebSocket, payload: unknown) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
  private clearHeartbeat() { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; }

  private receive(ws: WebSocket, p: { op: number; d: any; s: number | null; t: string | null }) {
    if (p.s != null) this.seq = p.s;
    switch (p.op) {
      case 10: {
        this.clearHeartbeat(); this.acked = true;
        const beat = () => {
          if (!this.acked) { this.h.log('gateway heartbeat not acknowledged; reconnecting'); ws.terminate(); return; }
          this.acked = false; this.send(ws, { op: 1, d: this.seq });
        };
        this.heartbeat = setInterval(beat, p.d.heartbeat_interval);
        if (this.sessionId) this.send(ws, { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
        else this.send(ws, { op: 2, d: { token: this.token, intents: this.intents, properties: { os: 'linux', browser: 'kenan', device: 'kenan' } } });
        return;
      }
      case 11: this.acked = true; return;
      case 1: this.send(ws, { op: 1, d: this.seq }); return;
      case 7: ws.close(4000); return;
      case 9: if (!p.d) { this.sessionId = null; this.seq = null; } setTimeout(() => ws.close(4000), 1000 + Math.random() * 4000); return;
      case 0:
        if (p.t === 'READY') { this.sessionId = p.d.session_id; this.resumeUrl = p.d.resume_gateway_url; this.failures = 0; }
        if (p.t === 'RESUMED') this.failures = 0;
        void Promise.resolve(this.h.dispatch(p.t!, p.d)).catch(e => this.h.log(`dispatch ${p.t}: ${e}`));
    }
  }
}

const whereOf = (m: DiscordMessage) => `${m.guild ? `${m.guild} ` : ''}${m.channel}`;
const textOf = (m: DiscordMessage) => `${m.content}${m.attachments.length ? `\n(attachments: ${m.attachments.map(a => a.name).join(', ')})` : ''}`;

/** A Discord message as a channel item; the bot's own messages and history seeded on first sight are context only. */
export function discordItem(m: DiscordMessage): ChannelItem {
  return {
    id: `discord:${m.id}`, source: 'discord', channel: `discord:${m.channelId}`, replyTo: m.id, fromId: null, at: m.at,
    from: `${m.author}${m.fromBot ? ' [bot]' : ''}`, where: whereOf(m),
    thread: `discord:${m.channelId}`, subject: null, contextOnly: m.fromBot || Boolean(m.seed),
    text: textOf(m),
    open: messageLink(m),
  };
}

/** A stored message as an inbox row. */
export const discordRow = (m: DiscordMessage): InboxRow => ({ id: `discord:${m.id}`, source: 'discord', at: m.at, from: m.author, where: whereOf(m), text: textOf(m), chatId: m.channelId });
export const discordRows = async (person: PersonConfig): Promise<InboxRow[]> => (await readMessages(person)).map(discordRow);

/** Resolves with the newest new message from someone else (not the bot, not history seeded on first sight) that
 *  matches, stored at or after `since`, or null once the timeout passes. */
export function waitForDiscord(person: PersonConfig, query: string | undefined, chat: string | undefined, since: number, timeoutMs: number, signal?: AbortSignal): Promise<InboxRow | null> {
  return waitForNew(person, discordFile(person), async () => {
    const hits = (await readMessages(person)).filter(m => m.storedAt >= since && !m.fromBot && !m.seed).map(discordRow).filter(rowMatches(query, chat));
    return hits.at(-1) ?? null;
  }, timeoutMs, signal);
}

// ---- Connection per person ----

class Connection {
  private channels = new Map<string, ChannelInfo>();
  private guilds = new Map<string, string>();
  private gateway: Gateway;
  private rest: Rest;
  private backfilled = new Set<string>();
  private known: Set<string> | null = null;
  private say: (text: string) => Promise<void>;

  constructor(private deps: Deps, private person: PersonConfig, token: Token) {
    this.rest = restFor(token.token);
    const log = (text: string) => deps.store.logError(`discord:${person.id}`, text);
    this.say = async text => { if (!await tellManager(deps, person, 'discord', text)) await log(`no Kenaznia on this channel to tell: ${text.slice(0, 200)}`); };
    this.gateway = new Gateway(token.token, async () => ((await this.rest('GET', '/gateway/bot')) as { url: string }).url, {
      dispatch: (t, d) => this.dispatch(t, d),
      log: text => console.log(JSON.stringify({ event: 'discord_gateway', person: person.id, text })),
      fatal: text => void log(text),
    });
  }

  /** Hands the inbox the last day's stored messages: what it already decided is context, the rest it takes now. */
  async start() {
    registerAcknowledger(this.person.id, 'discord', async item => { await this.rest('PUT', `/channels/${item.channel.slice('discord:'.length)}/messages/${item.replyTo}/reactions/${encodeURIComponent('👀')}/@me`); });
    await receive(this.deps, this.person, (await readMessages(this.person)).filter(m => m.at > this.deps.now() - JUDGE_WINDOW_MS).map(discordItem));
    this.gateway.start();
  }
  async stop() { registerAcknowledger(this.person.id, 'discord', null); await this.gateway.stop(); }

  private cacheChannel(c: Raw, guildId: string | null) { if (c?.id && c.name) this.channels.set(c.id, { name: c.name, guildId: c.guild_id ?? guildId }); }

  private async dispatch(type: string, d: Raw) {
    switch (type) {
      case 'READY':
        this.known = new Set((d.guilds ?? []).map((g: Raw) => g.id));
        console.log(JSON.stringify({ event: 'discord_gateway', person: this.person.id, text: `ready as ${d.user?.username} in ${this.known.size} server(s)` }));
        return;
      case 'GUILD_CREATE':
        if (this.known && !this.known.has(d.id)) { this.known.add(d.id); await this.say(`The Discord bot was added to the server "${d.name}" (id ${d.id}, ${(d.channels ?? []).length} channels). The discord tool's "channels" action lists them.`); }
        this.guilds.set(d.id, d.name);
        for (const c of [...(d.channels ?? []), ...(d.threads ?? [])]) this.cacheChannel(c, d.id);
        await this.backfill(d.id, [...(d.channels ?? []), ...(d.threads ?? [])]);
        return;
      case 'CHANNEL_CREATE': case 'CHANNEL_UPDATE': case 'THREAD_CREATE': case 'THREAD_UPDATE': this.cacheChannel(d, d.guild_id ?? null); return;
      case 'MESSAGE_CREATE': await this.take([messageRecord(d, this.channels, this.guilds, this.deps.now())]); return;
    }
  }

  private async take(messages: DiscordMessage[]) {
    const fresh = await storeMessages(this.person, messages);
    for (const m of fresh) {
      await queueHostEvent(EVENT_INBOX_ROOT, this.person.id, { topic: 'discord:message', id: `discord:${m.id}`, body: { id: m.id, channelId: m.channelId, channel: m.channel, guild: m.guild, author: m.author, fromBot: m.fromBot, content: m.content.slice(0, 2000), link: messageLink(m) } })
        .catch(e => this.deps.store.logError(`discord:${this.person.id}`, `host event: ${e}`));
    }
    await receive(this.deps, this.person, fresh.map(discordItem));
  }

  /** Fetches what each text channel got while we were away (or seeds a channel's last messages the first time). */
  private async backfill(guildId: string, channels: Raw[]) {
    if (this.backfilled.has(guildId)) return;
    this.backfilled.add(guildId);
    const stored = await readMessages(this.person);
    for (const c of channels.filter(c => TEXT_CHANNEL_TYPES.has(c.type) && c.type !== 15)) {
      const last = stored.filter(m => m.channelId === c.id).at(-1);
      try {
        const page = await this.rest('GET', `/channels/${c.id}/messages?limit=${BACKFILL_SEED}${last ? `&after=${last.id}` : ''}`) as Raw[];
        const records = page.reverse().map(d => ({ ...messageRecord({ ...d, guild_id: guildId }, this.channels, this.guilds, this.deps.now()), ...(last ? {} : { seed: true as const }) }));
        if (records.length) await this.take(records);
      } catch (e) { if (!String(e).includes('discord_http_403')) await this.deps.store.logError(`discord:${this.person.id}`, `backfill ${c.name}: ${e}`); }
    }
  }
}

const connections = new Map<string, Connection>();

async function startDiscord(deps: Deps) {
  for (const person of deps.config.people) {
    if (!person.extensions.includes('discord') || !person.manager || 'elsewhere' in person.manager) continue;
    try {
      const setup = discordSetup(person);
      if (setup.kind === 'none') { await deps.store.logError(`discord:${person.id}`, 'the discord extension is on but the extension config has no "discord" entry'); continue; }
      const connection = new Connection(deps, person, readToken(setup.tokenPath));
      connections.set(person.id, connection);
      await connection.start();
    } catch (e) { await deps.store.logError(`discord:${person.id}`, `not started: ${e}`); }
  }
}

export async function stopDiscordPerson(id: string): Promise<void> {
  const entry = connections.get(id);
  connections.delete(id);
  await entry?.stop();
}

async function stopDiscord() {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map(c => c.stop()));
}

// ---- Tool ----

/** Splits text into Discord-sized messages, at paragraph or line breaks where it can. */
export function chunks(text: string, size = 2000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > size / 2 ? cut : size;
    out.push(rest.slice(0, at).trimEnd()); rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export type GuildEmoji = { id: string; name: string; animated?: boolean };

const EMOJI_TOKEN = /```[\s\S]*?```|`[^`\n]*`|<a?:\w+:\d+>|<(a?):(\w{2,32}):>|:(\w{2,32}):/g;

/** Writes `:name:` (and a broken `<:name:>`) as the guild custom emoji `<:name:id>` / `<a:name:id>`; unknown names, code spans/blocks and finished emoji stay as typed. */
export function emojify(text: string, emojis: GuildEmoji[]): string {
  if (!emojis.length) return text;
  const byName = new Map(emojis.map(e => [e.name, e]));
  return text.replace(EMOJI_TOKEN, (all, _anim, broken, plain) => {
    const e = byName.get(broken ?? plain);
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : all;
  });
}

const EMOJI_TTL_MS = 5 * 60_000;
const emojiCache = new Map<string, { at: number; emojis: GuildEmoji[] }>();
async function guildEmojis(rest: Rest, guildId: string): Promise<GuildEmoji[]> {
  const hit = emojiCache.get(guildId);
  if (hit && Date.now() - hit.at < EMOJI_TTL_MS) return hit.emojis;
  const emojis = (await rest('GET', `/guilds/${guildId}/emojis`) as Raw[]).filter(e => e.available !== false).map(e => ({ id: String(e.id), name: String(e.name), animated: !!e.animated }));
  emojiCache.set(guildId, { at: Date.now(), emojis });
  return emojis;
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });

type Args = { action: 'channels' | 'history' | (typeof ACTIONS)[number]; channel?: string; user?: string; limit?: number; before?: string; text?: string; replyTo?: string; paths?: string[] };

/** Sends as the bot (the send tool's Discord route, server/channels/send.ts). */
export async function discordSend(person: PersonConfig, args: { channel?: string; user?: string; text?: string; replyTo?: string; paths?: string[] }) {
  const setup = discordSetup(person);
  if (setup.kind === 'none') throw new Error(`discord_not_configured: ${person.name} has no "discord" entry in the extension config`);
  return send(restFor(readToken(setup.tokenPath).token), args);
}

async function send(rest: Rest, args: Pick<Args, 'channel' | 'user' | 'text' | 'replyTo' | 'paths'>) {
  if (!args.text?.trim() && !args.paths?.length) throw new Error('invalid_input: send needs text and/or paths');
  if ((args.channel === undefined) === (args.user === undefined)) throw new Error('invalid_input: send needs exactly one of channel (a channel id) or user (a user id, for a DM)');
  const target = args.channel ? await rest('GET', `/channels/${args.channel}`) as Raw : await rest('POST', '/users/@me/channels', { recipient_id: args.user }) as Raw;
  const channelId: string = target.id, guildId: string = target.guild_id ?? '@me';
  const text = target.guild_id ? emojify(args.text ?? '', await guildEmojis(rest, target.guild_id)) : args.text ?? '';
  const parts = chunks(text);
  if (parts.length > MAX_CHUNKS) throw new Error(`text_too_long: at most ${MAX_CHUNKS * 2000} characters`);
  const sent: { id: string; link: string }[] = [];
  const total = Math.max(parts.length, 1);
  for (let i = 0; i < total; i++) {
    const payload: Raw = { content: parts[i] ?? '', allowed_mentions: { parse: ['users', 'roles'], replied_user: true } };
    if (i === 0 && args.replyTo) payload.message_reference = { message_id: args.replyTo, fail_if_not_exists: false };
    let body: unknown = payload;
    if (i === total - 1 && args.paths?.length) {
      const form = new FormData();
      payload.attachments = args.paths.map((p, n) => ({ id: n, filename: basename(p) }));
      form.append('payload_json', JSON.stringify(payload));
      for (const [n, p] of args.paths.entries()) form.append(`files[${n}]`, new Blob([await readFile(p)]), basename(p));
      body = form;
    }
    const m = await rest('POST', `/channels/${channelId}/messages`, body) as Raw;
    sent.push({ id: m.id, link: `https://discord.com/channels/${guildId}/${channelId}/${m.id}` });
  }
  return { status: 'sent', channel: channelId, messages: sent };
}

export const discordExtension: Extension = {
  id: 'discord', name: 'Discord',
  promptSnippet: 'Discord: Kenan\'s Discord bot watches its servers and DMs; their messages reach you as the Discord channel\'s mode says, and the inbox tool lists and waits for them. The discord tool lists channels, reads a channel\'s history and runs server actions; send (discord:CHANNEL_ID, discord:user:USER_ID) posts as the bot.',
  start: startDiscord,
  stop: stopDiscord,
  tool: ({ person }) => ({
    name: 'discord', files: 'reads', records: 'none', label: 'Discord',
    description: `Read Discord as Kenan's Discord bot (the ResearchCo server and the bot's DMs); send posts there (to "discord:CHANNEL_ID" or "discord:user:USER_ID"). Find messages with the inbox tool (recent, wait). action "channels": the servers and their text channels with ids. action "history": the live history of one channel (channel id, limit 1–100, optional before = a message id). Server actions (typed errors like role_not_found, member_ambiguous, missing_permission; each logged to discord-actions.jsonl; server defaults to the only server the bot is in, channel and role take a name or id, member a username, display name, nickname or id): servers; roles; members (query, limit); give_role / take_role (member, role); react / unreact (channel, message, emoji: unicode, :name: or <:name:id>); pin / unpin (channel, message); edit / delete (channel, message, text; the bot's own messages only); create_channel (name, kind text|voice|category|announcement, topic, parent); create_thread (channel, name, optional message to start from, optional text); set_topic (channel, topic). Messages arrive as host events on topic "discord:message", so wake on: "event" with that topic waits for a reply.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('channels'), Type.Literal('history'), ...ACTIONS.map(a => Type.Literal(a))]),
      server: Type.Optional(Type.String({ minLength: 1 })), member: Type.Optional(Type.String({ minLength: 1 })), role: Type.Optional(Type.String({ minLength: 1 })),
      message: Type.Optional(Type.String({ pattern: '^\\d{5,25}$' })), emoji: Type.Optional(Type.String({ minLength: 1 })), text: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), kind: Type.Optional(Type.Union(['text', 'voice', 'category', 'announcement'].map(k => Type.Literal(k)))),
      topic: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })), parent: Type.Optional(Type.String({ minLength: 1 })),
      query: Type.Optional(Type.String({ minLength: 1 })),
      channel: Type.Optional(Type.String({ minLength: 1 })),
      user: Type.Optional(Type.String({ pattern: '^\\d{5,25}$' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      before: Type.Optional(Type.String({ pattern: '^\\d{5,25}$' })),
    }),
    execute: async (_id, raw: unknown) => {
      const args = raw as Args;
      const setup = discordSetup(person);
      if (setup.kind === 'none') throw new Error(`discord_not_configured: ${person.name} has no "discord" entry in the extension config`);
      const rest = () => restFor(readToken(setup.tokenPath).token);
      switch (args.action) {
        case 'channels': {
          const r = rest();
          const guilds = await r('GET', '/users/@me/guilds') as Raw[];
          return result({ servers: await Promise.all(guilds.map(async g => ({ id: g.id, name: g.name, channels: ((await r('GET', `/guilds/${g.id}/channels`)) as Raw[]).filter(c => TEXT_CHANNEL_TYPES.has(c.type)).map(c => ({ id: c.id, name: c.name, type: c.type, topic: c.topic ?? null })) }))) });
        }
        case 'history': {
          if (!args.channel) throw new Error('invalid_input: history needs channel');
          const page = await rest()('GET', `/channels/${args.channel}/messages?limit=${args.limit ?? 50}${args.before ? `&before=${args.before}` : ''}`) as Raw[];
          return result({ items: page.map(d => ({ id: d.id, author: authorName(d.author), fromBot: Boolean(d.author.bot), content: d.content, attachments: (d.attachments ?? []).map((a: Raw) => a.filename), replyTo: d.message_reference?.message_id ?? null, at: d.timestamp })) });
        }
        default: return result(await runLogged(person, rest(), args as ActionArgs));
      }
    },
  }),
};
