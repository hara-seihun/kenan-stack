// Discord server actions for the discord tool: roles, members, reactions, pins, the bot's own messages, channels,
// threads and topics. Every failure is a typed error "code: detail"; every action is appended to discord-actions.jsonl.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonConfig } from '../config.js';
import { ownedDir, textsDir } from './texts.js';
import { emojify, type GuildEmoji, type Rest } from './discord.js';

type Raw = Record<string, any>;
export const ACTIONS = ['servers', 'roles', 'members', 'give_role', 'take_role', 'react', 'unreact', 'pin', 'unpin', 'edit', 'delete', 'create_channel', 'create_thread', 'set_topic'] as const;
export type ActionName = typeof ACTIONS[number];
export type ActionArgs = { action: ActionName; server?: string; member?: string; role?: string; channel?: string; message?: string; emoji?: string; text?: string; name?: string; kind?: 'text' | 'voice' | 'category' | 'announcement'; topic?: string; parent?: string; query?: string; limit?: number };

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
const isId = (s: string) => /^\d{5,25}$/.test(s);
const need = <T>(v: T | undefined, what: string): T => v === undefined || v === '' ? fail('invalid_input', `${what} is required`) : v;

/** Turns Discord's HTTP failures into typed errors. */
async function call(rest: Rest, method: string, path: string, body?: unknown, notFound = 'not_found'): Promise<any> {
  try { return await rest(method, path, body); }
  catch (e) {
    const m = String(e instanceof Error ? e.message : e);
    const status = /discord_http_(\d+)/.exec(m)?.[1];
    if (status === '403') return fail('missing_permission', `${method} ${path.split('?')[0]}: the bot lacks permission or its role sits below the target's (${m.slice(m.indexOf(': ') + 2, 200)})`);
    if (status === '404') return fail(notFound, `${method} ${path.split('?')[0]}`);
    if (status === '400') return fail('invalid_input', m.slice(0, 300));
    throw e;
  }
}

async function resolveGuild(rest: Rest, server: string | undefined): Promise<Raw> {
  const guilds = await call(rest, 'GET', '/users/@me/guilds') as Raw[];
  if (server === undefined) return guilds.length === 1 ? guilds[0]! : fail('server_required', `the bot is in ${guilds.length} servers: ${guilds.map(g => g.name).join(', ')}`);
  const hits = guilds.filter(g => g.id === server || g.name.toLowerCase() === server.toLowerCase());
  if (hits.length === 1) return hits[0]!;
  return hits.length ? fail('server_ambiguous', hits.map(g => `${g.name} ${g.id}`).join(', ')) : fail('server_not_found', server);
}

async function resolveRole(rest: Rest, guildId: string, role: string): Promise<Raw> {
  const roles = await call(rest, 'GET', `/guilds/${guildId}/roles`) as Raw[];
  const hits = roles.filter(r => r.id === role || r.name.toLowerCase() === role.replace(/^@/, '').toLowerCase());
  if (hits.length === 1) return hits[0]!;
  return hits.length ? fail('role_ambiguous', hits.map(r => `${r.name} ${r.id}`).join(', ')) : fail('role_not_found', `${role}; roles: ${roles.map(r => r.name).join(', ')}`);
}

const memberView = (m: Raw) => ({ id: m.user.id, username: m.user.username, displayName: m.user.global_name ?? null, nick: m.nick ?? null, bot: Boolean(m.user.bot), roles: m.roles as string[] });

async function resolveMember(rest: Rest, guildId: string, who: string): Promise<Raw> {
  if (isId(who)) return call(rest, 'GET', `/guilds/${guildId}/members/${who}`, undefined, 'member_not_found');
  const name = who.replace(/^@/, '').toLowerCase();
  const found = await call(rest, 'GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(name)}&limit=25`) as Raw[];
  const exact = found.filter(m => [m.user.username, m.user.global_name, m.nick].some(n => typeof n === 'string' && n.toLowerCase() === name));
  const pick = exact.length ? exact : found;
  if (pick.length === 1) return pick[0]!;
  const list = pick.map(m => `${m.user.username}${m.user.global_name ? ` (${m.user.global_name})` : ''} ${m.user.id}`).join(', ');
  return pick.length ? fail('member_ambiguous', `${who}: ${list}; pass the id`) : fail('member_not_found', who);
}

async function resolveChannel(rest: Rest, guildId: string, channel: string): Promise<Raw> {
  if (isId(channel)) return call(rest, 'GET', `/channels/${channel}`, undefined, 'channel_not_found');
  const all = await call(rest, 'GET', `/guilds/${guildId}/channels`) as Raw[];
  const hits = all.filter(c => c.name.toLowerCase() === channel.replace(/^#/, '').toLowerCase());
  if (hits.length === 1) return hits[0]!;
  return hits.length ? fail('channel_ambiguous', hits.map(c => `#${c.name} ${c.id} type ${c.type}`).join(', ')) : fail('channel_not_found', channel);
}

async function emojiParam(rest: Rest, guildId: string, emoji: string): Promise<string> {
  const custom = /^<a?:(\w+):(\d+)>$/.exec(emoji);
  if (custom) return encodeURIComponent(`${custom[1]}:${custom[2]}`);
  if (/^:\w{2,32}:$/.test(emoji)) {
    const emojis = await call(rest, 'GET', `/guilds/${guildId}/emojis`) as GuildEmoji[];
    const e = emojis.find(x => `:${x.name}:` === emoji);
    return e ? encodeURIComponent(`${e.name}:${e.id}`) : fail('emoji_not_found', emoji);
  }
  return encodeURIComponent(emoji);
}

const CHANNEL_KINDS = { text: 0, voice: 2, category: 4, announcement: 5 } as const;

async function ownMessage(rest: Rest, channelId: string, messageId: string): Promise<void> {
  const me = await call(rest, 'GET', '/users/@me') as Raw;
  const m = await call(rest, 'GET', `/channels/${channelId}/messages/${messageId}`, undefined, 'message_not_found') as Raw;
  if (m.author.id !== me.id) fail('not_own_message', `message ${messageId} was written by ${m.author.username}; the bot may only edit or delete its own`);
}

export async function runAction(rest: Rest, a: ActionArgs): Promise<unknown> {
  if (a.action === 'servers') return { servers: ((await call(rest, 'GET', '/users/@me/guilds')) as Raw[]).map(g => ({ id: g.id, name: g.name })) };
  const guild = await resolveGuild(rest, a.server);
  const g = guild.id as string;
  const channelOf = async () => resolveChannel(rest, g, need(a.channel, 'channel'));
  switch (a.action) {
    case 'roles': return { server: guild.name, roles: ((await call(rest, 'GET', `/guilds/${g}/roles`)) as Raw[]).sort((x, y) => y.position - x.position).map(r => ({ id: r.id, name: r.name, position: r.position, managed: r.managed })) };
    case 'members': {
      const limit = Math.min(a.limit ?? 50, 1000);
      const list = a.query ? await call(rest, 'GET', `/guilds/${g}/members/search?query=${encodeURIComponent(a.query)}&limit=${Math.min(limit, 100)}`) : await call(rest, 'GET', `/guilds/${g}/members?limit=${limit}`);
      const roles = new Map(((await call(rest, 'GET', `/guilds/${g}/roles`)) as Raw[]).map(r => [r.id, r.name]));
      return { server: guild.name, members: (list as Raw[]).map(m => { const v = memberView(m); return { ...v, roles: v.roles.map(id => roles.get(id) ?? id) }; }) };
    }
    case 'give_role': case 'take_role': {
      const role = await resolveRole(rest, g, need(a.role, 'role'));
      const member = await resolveMember(rest, g, need(a.member, 'member'));
      const had = (member.roles as string[]).includes(role.id);
      if (a.action === 'give_role' ? had : !had) return { status: 'unchanged', member: member.user.username, role: role.name, had };
      await call(rest, a.action === 'give_role' ? 'PUT' : 'DELETE', `/guilds/${g}/members/${member.user.id}/roles/${role.id}`);
      return { status: a.action === 'give_role' ? 'given' : 'taken', member: member.user.username, memberId: member.user.id, role: role.name };
    }
    case 'react': case 'unreact': {
      const c = await channelOf(); const msg = need(a.message, 'message');
      const e = await emojiParam(rest, g, need(a.emoji, 'emoji'));
      await call(rest, a.action === 'react' ? 'PUT' : 'DELETE', `/channels/${c.id}/messages/${msg}/reactions/${e}/@me`, undefined, 'message_not_found');
      return { status: a.action === 'react' ? 'reacted' : 'unreacted', channel: c.id, message: msg, emoji: a.emoji };
    }
    case 'pin': case 'unpin': {
      const c = await channelOf(); const msg = need(a.message, 'message');
      await call(rest, a.action === 'pin' ? 'PUT' : 'DELETE', `/channels/${c.id}/pins/${msg}`, undefined, 'message_not_found');
      return { status: a.action === 'pin' ? 'pinned' : 'unpinned', channel: c.id, message: msg };
    }
    case 'edit': {
      const c = await channelOf(); const msg = need(a.message, 'message'); const text = need(a.text, 'text');
      await ownMessage(rest, c.id, msg);
      await call(rest, 'PATCH', `/channels/${c.id}/messages/${msg}`, { content: emojify(text, (await call(rest, 'GET', `/guilds/${g}/emojis`)) as GuildEmoji[]) });
      return { status: 'edited', channel: c.id, message: msg };
    }
    case 'delete': {
      const c = await channelOf(); const msg = need(a.message, 'message');
      await ownMessage(rest, c.id, msg);
      await call(rest, 'DELETE', `/channels/${c.id}/messages/${msg}`);
      return { status: 'deleted', channel: c.id, message: msg };
    }
    case 'create_channel': {
      const name = need(a.name, 'name'); const kind = a.kind ?? 'text';
      if (!(kind in CHANNEL_KINDS)) fail('invalid_input', `kind must be one of ${Object.keys(CHANNEL_KINDS).join(', ')}`);
      const body: Raw = { name, type: CHANNEL_KINDS[kind] };
      if (a.topic !== undefined) body.topic = a.topic;
      if (a.parent !== undefined) body.parent_id = (await resolveChannel(rest, g, a.parent)).id;
      const c = await call(rest, 'POST', `/guilds/${g}/channels`, body) as Raw;
      return { status: 'created', id: c.id, name: c.name, kind, link: `https://discord.com/channels/${g}/${c.id}` };
    }
    case 'create_thread': {
      const c = await channelOf(); const name = need(a.name, 'name');
      const path = a.message ? `/channels/${c.id}/messages/${a.message}/threads` : `/channels/${c.id}/threads`;
      const t = await call(rest, 'POST', path, a.message ? { name } : { name, type: 11 }, 'message_not_found') as Raw;
      if (a.text) await call(rest, 'POST', `/channels/${t.id}/messages`, { content: emojify(a.text, (await call(rest, 'GET', `/guilds/${g}/emojis`)) as GuildEmoji[]) });
      return { status: 'created', id: t.id, name: t.name, parent: c.id, link: `https://discord.com/channels/${g}/${t.id}` };
    }
    case 'set_topic': {
      const c = await channelOf();
      await call(rest, 'PATCH', `/channels/${c.id}`, { topic: need(a.topic, 'topic') });
      return { status: 'topic_set', channel: c.id, name: c.name };
    }
    default: return fail('unknown_action', String((a as { action: unknown }).action));
  }
}

export const actionLog = (person: Pick<PersonConfig, 'home'>) => join(textsDir(person), 'discord-actions.jsonl');

/** Runs an action and appends its outcome (ok or the typed error) to the person's action log. */
export async function runLogged(person: PersonConfig, rest: Rest, a: ActionArgs, now: () => number = Date.now): Promise<unknown> {
  const entry = async (outcome: unknown) => { await ownedDir(person, textsDir(person)); await appendFile(actionLog(person), JSON.stringify({ at: now(), person: person.id, args: a, ...outcome as object }) + '\n', { mode: 0o600 }); };
  try { const value = await runAction(rest, a); await entry({ ok: true, result: value }); return value; }
  catch (e) { await entry({ ok: false, error: String(e instanceof Error ? e.message : e) }); throw e; }
}
