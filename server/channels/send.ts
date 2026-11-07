// One outbound path: the send tool posts to any channel (a shared Kenan chat, Signal, Discord, mail, texts). Every
// platform's rules are checked here, in `guard`, before anything goes out: Kenan chats take only a Kenaznia's posts;
// Signal only Business messages, sends she asked for and messages to the people she lets Kenan reach directly, each with Kenan's label; Discord only short posts; mail only with a request id and a known
// sender; texts only on a route permitted by the configured outbound policy. Mail locks each request and recipient/thread;
// other channels have one writer at a time. A request goes out once, and every send is logged with its receipt.
import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { PersonConfig } from '../config.js';
import { readOwnerFiles, attachErrorText } from '../files/files.js';
import { discordSend } from '../extensions/discord.js';
import { runMail } from '../extensions/mail.js';
import { recipientOf, sendSignal, signalContacts, ownStore, SIGNAL_LABEL, SIGNAL_SEND, type SendTarget } from '../extensions/signal.js';
import { outboundOf, sendDescription, sendTextAs, ownedDir } from '../extensions/texts.js';
import type { KenanTool, ToolContext } from '../types.js';
import { ADDRESS_FORMS, formatAddress, parseAddress, type Address, type Parsed, type Platform } from './address.js';
import { postToChat } from './kenan.js';
import { platformsOf } from './settings.js';

export interface SendArgs {
  to: string; text?: string; attachments?: string[]; replyTo?: string; requestId?: string;
  Business?: boolean; label?: string;
  subject?: string; cc?: string[]; from?: string; fromName?: string; mailbox?: string; supersede?: string[]; reason?: string; continueAfter?: string;
  herRequest?: boolean;
}

/** Discord posts are extremely short (Alice, 2026-10-27): one line of answer, then the data as a short bullet list. */
export const DISCORD_MAX_CHARS = 2000;

/** Every platform's sending rules, in one place: a send either passes all of its channel's rules or names the one it breaks. */
export function guard(person: PersonConfig, agent: ToolContext['agent'], to: Address, args: SendArgs): Parsed<null> {
  const no = (error: string): Parsed<null> => ({ ok: false, error });
  const text = args.text?.trim() ?? '';
  if (!platformsOf(person).includes(to.platform)) return no(`channel_unavailable: ${person.name} has no ${to.platform} channel (has ${platformsOf(person).join(', ')})`);
  if (to.platform !== 'mail' && (args.subject !== undefined || args.cc || args.from || args.fromName || args.mailbox || args.supersede || args.reason || args.continueAfter)) return no('invalid_input: subject, cc, from, fromName, mailbox, supersede, reason and continueAfter are for mail');
  if (to.platform !== 'signal' && (args.Business !== undefined || args.label !== undefined)) return no('invalid_input: Business and label are for Signal');
  if (to.platform !== 'kenan' && to.platform !== 'signal' && args.herRequest !== undefined) return no('invalid_input: herRequest is for Kenan chats and Signal');
  switch (to.platform) {
    case 'kenan':
      if (agent.role !== 'manager') return no('send_kenan_manager_only: only the person\'s Kenaznia posts into their chats; give your parent the text or paths');
      return text || args.attachments?.length ? { ok: true, value: null } : no('invalid_input: send needs text and/or attachments');
    case 'signal':
      if (to.account && (person.id !== 'alice' || args.label !== undefined || args.Business !== undefined || args.herRequest !== undefined)) return no('signal_account_invalid: Kenan’s account is available to Alice’s agents and takes no label, Business or herRequest');
      if (args.label !== undefined && !SIGNAL_LABEL.test(args.label)) return no('signal_label_invalid: label must be "[Kenan]" or look like "[Kenan, Alice\'s assistant, not Alice]"');
      if (args.replyTo) return no('invalid_input: Signal sends don\'t quote; leave replyTo out');
      return text ? { ok: true, value: null } : no('invalid_input: Signal sends need text');
    case 'discord':
      if (!text && !args.attachments?.length) return no('invalid_input: send needs text and/or attachments');
      if (text.length > DISCORD_MAX_CHARS) return no(`discord_too_long: ${text.length} characters. Discord posts are extremely short: one line of answer, then the data as a short bullet list, at most ${DISCORD_MAX_CHARS} characters; keep only what changes what the reader does.`);
      return { ok: true, value: null };
    case 'mail':
      if (!args.requestId) return no('mail_request_id_required: give requestId, and reuse it for this exact message if you try again');
      if (!to.to.length && !args.replyTo) return no('invalid_input: mail needs mail:ADDRESS, or "mail" with replyTo (FOLDER/UIDVALIDITY:UID) to answer a message');
      if (!args.replyTo && !args.from) return no('mail_sender_required: a new message needs from, one of the addresses this mailbox sends as; a reply goes from the address the replied-to message reached');
      if (!args.replyTo && !args.subject?.trim()) return no('invalid_input: a new message needs subject');
      return text ? { ok: true, value: null } : no('invalid_input: mail needs text (the body)');
    case 'texts': {
      const setup = outboundOf(person);
      if (setup.kind === 'invalid') return no(`outbound_texts_misconfigured: ${setup.error}`);
      if (setup.kind === 'none') return no(`no_outbound_texts: ${person.name} has no outbound texting`);
      if (setup.route.kind === 'forbidden') return no(`sms_outbound_not_permitted: ${setup.route.reason}`);
      if (args.attachments?.length || args.replyTo) return no('invalid_input: texts carry only text');
      return text ? { ok: true, value: null } : no('invalid_input: texts need text');
    }
  }
}

/** Who a Signal send goes to and with which label, or why it may not go: Kenan writes on the person's Signal only about
 *  Business, when she asked for this message now, or to someone she lets it message directly (signal.contacts), who gets
 *  the label set for them unless the send names one. */
export async function signalRoute(person: PersonConfig, to: Extract<Address, { platform: 'signal' }>, args: SendArgs): Promise<{ recipient: SendTarget; label: string | null }> {
  if (to.account) return { recipient: await recipientOf(person, ownStore(person), to.to.startsWith('group:') ? to.to.slice(6) : to.to), label: null };
  const contacts = signalContacts(person);
  const recipient = await recipientOf(person, person.signalStore!, to.to.startsWith('group:') ? to.to.slice(6) : to.to);
  const rule = recipient.kind === 'direct' ? contacts.find(c => c.uuid === recipient.uuid.toLowerCase()) : undefined;
  if (!rule && args.Business !== true && args.herRequest !== true) {
    const direct = contacts.length ? ` Kenan may message ${contacts.map(c => c.name).join(' and ')} directly.` : '';
    throw new Error(`signal_send_not_Business: ${person.name}'s rule is that Kenan answers on her Signal only about Business.${direct} Set Business: true if this message is about Business, or herRequest: true if ${person.name} asked you to send this message now; otherwise handle it another way (mail, a call, or tell her).`);
  }
  return { recipient, label: args.label ?? rule?.label ?? null };
}

// ---- Ledger: every send with its request id and outcome ----

type Entry = { requestId: string; channel: string; agentId: string; at: number; herRequest?: true } & ({ state: 'started' } | { state: 'sent'; receipt: unknown } | { state: 'failed'; error: string });
const ledgerFile = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/sends.jsonl');
async function readLedger(person: PersonConfig): Promise<Entry[]> {
  const data = await readFile(ledgerFile(person), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return data.split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry);
}
async function record(person: PersonConfig, entry: Entry): Promise<void> {
  await ownedDir(person, join(person.home, '.local/share/kenan'));
  const handle = await open(ledgerFile(person), 'a', 0o600);
  try { if ((await handle.stat()).uid !== person.uid) await handle.chown(person.uid, person.gid); await handle.appendFile(JSON.stringify(entry) + '\n'); }
  finally { await handle.close(); }
}

/** Non-mail channels have one writer. Mail shares only a request key here; the CLI locks each recipient/thread. */
const writers = new Map<string, Promise<unknown>>();
function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (writers.get(key) ?? Promise.resolve()).then(work);
  const settled = run.then(() => {}, () => {});
  writers.set(key, settled);
  void settled.then(() => { if (writers.get(key) === settled) writers.delete(key); });
  return run;
}

async function dispatch(ctx: ToolContext, to: Address, args: SendArgs, requestId: string, route: { recipient: SendTarget; label: string | null } | null, signal?: AbortSignal): Promise<unknown> {
  const { person, agent, deps } = ctx;
  const text = args.text ?? '';
  switch (to.platform) {
    case 'kenan': {
      let files: { name: string; mime: string; data: string }[] = [];
      if (args.attachments?.length) {
        const read = await readOwnerFiles(deps.placement, person, args.attachments);
        if (!read.ok) throw new Error(attachErrorText(read.error));
        files = read.files.map(f => ({ name: f.name, mime: f.mime, data: f.bytes.toString('base64') }));
      }
      return postToChat(deps, { ownerId: person.id, agentId: agent.id, chatId: to.chatId, text, replyTo: args.replyTo ?? null, herRequest: args.herRequest === true, files });
    }
    case 'signal': {
      const { recipient, label } = route!;
      const sent = await sendSignal(person, deps.placement, SIGNAL_SEND, recipient, { to: to.to, text, attachments: args.attachments ?? [], label, own: to.account === 'kenan-own' }, agent.id, deps.now, signal);
      if (sent.outcome !== 'succeeded') throw new Error(`signal_send_failed: outcome ${sent.outcome}; receipt ${sent.receipt}. The message may or may not have gone out: check the receipt and signal history before sending again.`);
      return { to: recipient.name ?? (recipient.kind === 'group' ? recipient.id : recipient.uuid), receipt: sent.receipt };
    }
    case 'discord':
      return discordSend(person, { ...(to.kind === 'user' ? { user: to.id } : { channel: to.id }), text, ...(args.replyTo ? { replyTo: args.replyTo } : {}), ...(args.attachments?.length ? { paths: args.attachments } : {}) });
    case 'mail': {
      const out = await runMail(ctx, { action: 'send', to: to.to.length ? to.to : undefined, body: text, requestId, ...pick(args, ['cc', 'subject', 'from', 'fromName', 'mailbox', 'supersede', 'reason', 'continueAfter', 'attachments', 'replyTo']) }, signal);
      const output = out.content.map(c => c.text).join('');
      if (out.isError) throw new Error(output);
      return { output };
    }
    case 'texts':
      return sendTextAs(person, agent.id, to.to, text, fetch as never, deps.now);
  }
}
const pick = <T extends object, K extends keyof T>(o: T, keys: K[]): Partial<Pick<T, K>> => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) as Partial<Pick<T, K>>;

export async function send(ctx: ToolContext, args: SendArgs, signal?: AbortSignal): Promise<{ status: 'sent' | 'already_sent'; channel: string; requestId: string; receipt: unknown }> {
  const parsed = parseAddress(args.to);
  if (!parsed.ok) throw new Error(parsed.error);
  const to = parsed.value, channel = formatAddress(to);
  const allowed = guard(ctx.person, ctx.agent, to, args);
  if (!allowed.ok) throw new Error(allowed.error);
  const route = to.platform === 'signal' ? await signalRoute(ctx.person, to, args) : null;
  const requestId = args.requestId ?? randomUUID();
  // A bare "mail" address means any reply, not one shared thread. Do not put all replies
  // behind each other's network waits. The CLI already rejects overlapping recipient/thread sends.
  const writerKey = to.platform === 'mail' ? `mail-request:${requestId}` : channel;
  return inTurn(`${ctx.person.id}|${writerKey}`, async () => {
    if (args.requestId) {
      const last = (await readLedger(ctx.person)).filter(e => e.requestId === requestId).at(-1);
      if (last?.state === 'sent') return { status: 'already_sent' as const, channel: last.channel, requestId, receipt: last.receipt };
      if (last?.state === 'started' && to.platform !== 'mail') throw new Error(`send_uncertain: request ${requestId} to ${last.channel} started at ${new Date(last.at).toISOString()} and never finished; it may or may not have gone out. Check the channel's history, then send again with a new requestId if it didn't.`);
    }
    const base = { requestId, channel, agentId: ctx.agent.id, ...(args.herRequest === true ? { herRequest: true as const } : {}) };
    await record(ctx.person, { ...base, at: ctx.deps.now(), state: 'started' });
    try {
      const receipt = await dispatch(ctx, to, args, requestId, route, signal);
      await record(ctx.person, { ...base, at: ctx.deps.now(), state: 'sent', receipt });
      return { status: 'sent' as const, channel, requestId, receipt };
    } catch (e) {
      await record(ctx.person, { ...base, at: ctx.deps.now(), state: 'failed', error: String((e as Error).message ?? e) }).catch(() => {});
      throw e;
    }
  });
}

const PLATFORM_TEXT: Record<Platform, (person: PersonConfig) => string> = {
  kenan: () => 'kenan:CHAT_ID posts into a Kenan chat as you (Kenaznia only): a shared chat that forwarded you a message (replyTo its message id quotes it), or one of the person\'s own chats (rooms list); a closed chat needs herRequest: true, only when they ask now, and reopens it.',
  signal: person => {
    const direct = signalContacts(person);
    const named = direct.map(c => c.label ? `${c.name} (labelled "${c.label}" automatically)` : c.name).join(' and ');
    return `signal-kenan:CONTACT sends as Kenan on his own Signal account, without a label or Business restriction. signal:CONTACT or signal:group:GROUP_ID sends on ${person.name}'s Signal, only about Business (the configured business topic)${direct.length ? `, or directly to ${named}` : ''}: Business: true is required${direct.length ? ` for anyone else` : ''} and you set it only when the message is about Business; everything else on Signal is read and handled or told to her, never answered there, unless she asks you to send that message now: then set herRequest: true instead (any chat; it is logged as her request). Every message goes out prefixed "[Kenan, ${person.name}'s assistant, not ${person.name}]" (label replaces it: "[Kenan]" or "[Kenan, …]", e.g. "[Kenan, Alice's assistant, not Alice]" for people who know her as Alice). Sends go out one at a time with a receipt and never retry: a signal_send_failed must be checked, not resent.`;
  },
  discord: () => `discord:CHANNEL_ID or discord:user:USER_ID (a DM) posts as Kenan's Discord bot; replyTo a message id; attachments are files from the home; at most ${DISCORD_MAX_CHARS} characters, and keep it extremely short: one line of answer, then the data as a short bullet list (in a server, :name: becomes that server's custom emoji).`,
  mail: () => 'mail:ADDRESS[,ADDRESS…] sends a new message (from and subject required), or "mail" with replyTo FOLDER/UIDVALIDITY:UID answers one (from defaults to the address it reached; to and cc may be added). requestId is required: reuse it for this exact message if you retry. cc, from, fromName, mailbox (with several mailboxes), attachments; a reply continues its thread when you, the manager or an ended worker on your goal wrote it last, and a thread-fenced error names the supersede and reason it needs. Text is the body.',
  texts: person => sendDescription(outboundOf(person)),
};

export function sendTool(ctx: ToolContext): KenanTool {
  const have = platformsOf(ctx.person);
  return {
    name: 'send', files: 'reads', records: 'none', label: 'Send',
    description: `Send a message to a channel: the one place you message anyone outside your own chat with ${ctx.person.name}. to is the channel, exactly as an incoming message names it (${ADDRESS_FORMS}); text, optional attachments (file paths) and replyTo (the message to answer, as the incoming message gives it). Mail has one writer per recipient/thread; other channels have one writer per address. A send with requestId goes out once (the same requestId again returns the first receipt), and every send is logged with its receipt. Your channels:\n${have.map(p => `- ${PLATFORM_TEXT[p](ctx.person)}`).join('\n')}`,
    parameters: Type.Object({
      to: Type.String({ minLength: 1, description: 'The channel, e.g. kenan:CHAT_ID, signal:group:ID, discord:CHANNEL_ID, mail:ADDRESS, texts:+E164' }),
      text: Type.Optional(Type.String({ maxLength: 20_000 })),
      attachments: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 })),
      replyTo: Type.Optional(Type.String({ minLength: 1 })),
      requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      ...(have.includes('signal') ? { Business: Type.Optional(Type.Boolean()), label: Type.Optional(Type.String({ pattern: '^\\[Kenan[,\\]]', maxLength: 120 })) } : {}),
      ...(have.includes('mail') ? {
        subject: Type.Optional(Type.String()), cc: Type.Optional(Type.Array(Type.String())), from: Type.Optional(Type.String()), fromName: Type.Optional(Type.String()), mailbox: Type.Optional(Type.String()),
        supersede: Type.Optional(Type.Array(Type.String())), reason: Type.Optional(Type.String()), continueAfter: Type.Optional(Type.String()),
      } : {}),
      herRequest: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, raw: unknown, signal) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await send(ctx, raw as SendArgs, signal)) }], details: {} }),
  };
}
