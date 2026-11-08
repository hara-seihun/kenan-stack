// Kenan shared chats as a channel. A chat with two or more people is not a room any Kenaznia sits in: each member's own
// Kenaznia hears it as a channel (kenan:CHAT), gets its messages forwarded into its own chat as its channel mode says
// (addressed by default: "@kenaznia" from its own person, its own name, a reply to it), and answers with send.
// The chat may live on the other channel of this host (Beta or production): items and posts cross through the link.
import type { ConversationSummary, Message } from '../../shared/contract.js';
import { chatKenaznia, chatTargets, sinceAgentSpoke, type ChatKenaznia } from '../agents/addressed.js';
import { hostedManager, type PersonConfig } from '../config.js';
import { filePart, saveFile } from '../files/files.js';
import { notifyChatMembers } from '../chat-notify.js';
import { NOTIFY_OUTBOX_ROOT } from '../notify-outbox.js';
import type { Deps } from '../types.js';
import { receive, type ChannelFile, type ChannelItem } from './inbound.js';
import { forward, toSiblings, type LinkResult } from './link.js';

const EARLIER_MAX = 20, EARLIER_CHARS = 20_000, EARLIER_LINE_CHARS = 8000, PAGE = 60, FILES_MAX = 10;

export const managerIdOf = (personId: string) => `manager:${personId}`;
/** How a person's Kenaznia is named in a chat it posts in from another channel. */
export const remoteKenazniaName = (person: Pick<PersonConfig, 'name'>) => `${person.name}'s Kenaznia`;

const fileIdsOf = (m: Message) => m.parts.flatMap(p => p.type === 'file' || p.type === 'image' ? [p.fileId] : []);
const fileNamesOf = (m: Message) => m.parts.flatMap(p => p.type === 'file' ? [p.name] : p.type === 'image' ? ['picture'] : []);
const withFiles = (text: string, m: Message) => { const names = fileNamesOf(m); return names.length ? `${text}\n(attachments: ${names.join(', ')})` : text; };

/** What was said since the Kenaznia last wrote, as lines, and the messages those lines come from. */
function earlierLines(page: Message[], managerId: string, before: string, name: (id: string) => string): { lines: string[]; messages: Message[] } {
  const lines: string[] = [], messages: Message[] = [];
  let room = EARLIER_CHARS;
  for (const m of sinceAgentSpoke(page, managerId, before).slice(-EARLIER_MAX).reverse()) {
    const line = `${name(m.authorId)}: ${withFiles(m.text, m).replace(/\s+/g, ' ').trim()}`.slice(0, EARLIER_LINE_CHARS);
    if (line.length > room) break;
    room -= line.length; lines.unshift(line); messages.unshift(m);
  }
  return { lines, messages };
}

/** The files a channel item carries: the message's own first, then the earlier lines', newest first, at most FILES_MAX. */
async function channelFiles(deps: Pick<Deps, 'store'>, message: Message, earlier: Message[]): Promise<ChannelFile[]> {
  const ids = [...new Set([...fileIdsOf(message), ...earlier.slice().reverse().flatMap(fileIdsOf)])].slice(0, FILES_MAX);
  const stored = await Promise.all(ids.map(id => deps.store.getFile(id)));
  return stored.flatMap(f => f ? [{ id: f.id, name: f.name, mime: f.mime, path: f.path }] : []);
}

/** Whether a chat is shared: two or more people (not agents) in it. */
export async function humansIn(deps: Pick<Deps, 'store'>, conversation: ConversationSummary): Promise<{ humans: string[]; names: Map<string, string> }> {
  const people = await deps.store.listPeople();
  const kinds = new Map(people.map(p => [p.id, p.kind]));
  return { humans: conversation.memberIds.filter(id => kinds.get(id) === 'human'), names: new Map(people.map(p => [p.id, p.name])) };
}

/**
 * A person's message in a shared chat: every member with a Kenaznia gets it as a channel item (addressed or not), on
 * the channel hosting that Kenaznia; the item's channel mode there decides what reaches it. The writer's own messages
 * reach the writer's inbox too: addressed ones straight, unaddressed ones as their mode says (context for "addressed",
 * the watcher for "filtered", so a question the writer puts to the room can reach their Kenaznia).
 */
export async function routeSharedMessage(deps: Deps, message: Message, conversation: ConversationSummary, humans: string[], names: Map<string, string>): Promise<void> {
  const page = (await deps.store.listMessages(conversation.id, { kind: 'latest' }, PAGE)).messages;
  const name = (id: string) => {
    const shown = names.get(id) ?? id;
    if (!id.startsWith('manager:')) return shown;
    const owner = names.get(id.slice('manager:'.length));
    return owner && !shown.includes(owner) ? `${owner}'s ${shown}` : shown;
  };
  const members = humans.flatMap(id => { const p = deps.person(id); return p && p.manager ? [p] : []; });
  const kenaznias: ChatKenaznia[] = members.map(p => chatKenaznia(p, names.get(managerIdOf(p.id)) ?? (hostedManager(p)?.name ?? remoteKenazniaName(p))));
  const targets = chatTargets(message.text, message.authorId, kenaznias);
  for (const person of members) {
    const addressed = targets.get(person.id) ?? null;
    const earlier = earlierLines(page, managerIdOf(person.id), message.id, name);
    const item: ChannelItem = {
      id: `kenan:${message.id}`, source: 'kenan', channel: `kenan:${conversation.id}`, replyTo: message.id, at: message.createdAt,
      from: name(message.authorId), fromId: message.authorId, where: `“${conversation.title}” with ${humans.map(name).join(', ')}`,
      thread: `kenan:${conversation.id}`, subject: null, open: null, contextOnly: false, addressed,
      text: withFiles(message.text, message), earlier: earlier.lines, files: await channelFiles(deps, message, earlier.messages),
    };
    if (hostedManager(person)) await receive(deps, person, [item]);
    else void forward(deps, person, [item]);
  }
}

export interface PostFile { name: string; mime: string; data: string }
/** A Kenaznia's message into a chat: ownerId is its person, agentId the Kenaznia (manager:PERSON). */
export interface PostRequest { ownerId: string; agentId: string; chatId: string; text: string; replyTo: string | null; herRequest: boolean; files: PostFile[] }
export interface Posted { chat: string; channel: string; messageId: string; on: string }

const failed = (error: string): LinkResult<Posted> => ({ ok: false, error });

/** Posts into a chat held in this channel's database; `not_here` when it isn't one of ours. */
export async function postLocal(deps: Deps, req: PostRequest): Promise<LinkResult<Posted>> {
  const owner = deps.person(req.ownerId);
  if (!owner) return failed(`not_here: ${req.ownerId} is not a person of ${deps.config.channel}`);
  if (req.agentId !== managerIdOf(owner.id)) return failed('send_kenan_manager_only: only a person\'s Kenaznia posts into chats');
  const members = await deps.store.conversationMembers(req.chatId);
  if (!members.length) return failed(`not_here: no chat ${req.chatId} on ${deps.config.channel}`);
  if (!members.includes(owner.id)) return failed(`send_not_member: ${owner.name} is not in that chat`);
  const chat = (await deps.store.getConversation(req.chatId, owner.id))!;
  if (chat.agentId) return failed('send_agent_chat: that is an agent\'s own chat; send to one of the person\'s chats');
  if (chat.archived && !req.herRequest) return failed(`room_closed: “${chat.title}” is closed; post there only if ${owner.name} asks now (herRequest: true reopens it)`);
  if (!req.text.trim() && !req.files.length) return failed('invalid_input: send needs text and/or attachments');
  let quote = '';
  if (req.replyTo) {
    const replied = await deps.store.getMessage(chat.id, req.replyTo);
    if (!replied) return failed(`send_reply_not_found: no message ${req.replyTo} in “${chat.title}”`);
    const author = (await deps.store.listPeople()).find(p => p.id === replied.authorId)?.name ?? replied.authorId;
    const excerpt = replied.text.split('\n').filter(l => !l.startsWith('>')).join(' ').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
    quote = `> **${author}:** ${excerpt.length > 160 ? `${excerpt.slice(0, 159).trimEnd()}…` : excerpt}`.trimEnd() + '\n\n';
  }
  if (!(await deps.store.getAgent(req.agentId))) {
    const known = (await deps.store.listPeople()).some(p => p.id === req.agentId);
    if (!known) await deps.store.upsertPerson({ id: req.agentId, name: remoteKenazniaName(owner), kind: 'agent' });
  }
  const patch = { ...(members.includes(req.agentId) ? {} : { addMemberIds: [req.agentId] }), ...(chat.archived ? { archived: false } : {}) };
  let current = chat;
  if (Object.keys(patch).length) {
    current = await deps.store.updateConversation(chat.id, owner.id, patch);
    deps.bus.invalidateMembers(chat.id);
    for (const id of current.memberIds) { const theirs = id === owner.id ? current : await deps.store.getConversation(chat.id, id); if (theirs) deps.bus.toPerson(id, { type: 'conversation', conversation: theirs }); }
  }
  const parts = await Promise.all(req.files.map(async f => filePart(await saveFile(deps, owner.id, f.name, f.mime, Buffer.from(f.data, 'base64')))));
  const message = await deps.store.appendMessage({ conversationId: chat.id, authorId: req.agentId, role: 'assistant', display: 'shown', text: `${quote}${req.text}`, parts });
  deps.bus.toConversation(chat.id, { type: 'message', message });
  void notifyChatMembers(deps, NOTIFY_OUTBOX_ROOT, current, message).catch(e => deps.store.logError('chat_notify', String(e)).catch(() => {}));
  return { ok: true, value: { chat: chat.title, channel: `kenan:${chat.id}`, messageId: message.id, on: deps.config.channel } };
}

/** Posts here when the chat is ours, else on the sibling channel that holds it. */
export async function postToChat(deps: Deps, req: PostRequest): Promise<Posted> {
  const here = await postLocal(deps, req);
  if (here.ok) return here.value;
  if (!here.error.startsWith('not_here')) throw new Error(here.error);
  const there = await toSiblings<Posted>(deps, '/post', req);
  if (there.ok) return there.value;
  throw new Error(there.error.startsWith('not_here') || there.error.startsWith('link_none') ? `send_chat_not_found: no chat ${req.chatId} that ${req.ownerId} is in, on any channel` : there.error);
}
