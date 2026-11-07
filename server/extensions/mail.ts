import { pageParameters, arrayPage, type PageRequest } from '../tools/pagination.js';
import { readFile } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Type } from 'typebox';
import type { Extension, ToolContext } from '../types.js';
import type { PersonConfig } from '../config.js';
import type { AgentInfo } from '../../shared/contract.js';
import { ownerProcess, processResult, type ProcessPlacement } from '../tools/owner.js';

/** The longest a mail wait holds its tool call, like the inbox wait. */
export const MAX_WAIT_SECONDS = 600;
export interface Mailbox { address: string; account: string; fromName: string }
type MailSettings =
  | { kind: 'hosted'; mailboxes: Mailbox[] }
  | { kind: 'bridge'; credentialPath: string; port: number | undefined; imapPort: number | undefined; senders: SenderNames };
/** The From display name of each sender address (lower-case base address, no +tag). An address missing here can only send with an explicit fromName. */
export type SenderNames = Record<string, string>;
const lower = (address: string) => address.trim().toLowerCase();
const baseAddress = (address: string) => lower(address).replace(/\+[^@]*@/, '@');
const displayName = (name: unknown): name is string => typeof name === 'string' && name.trim() !== '' && !/[\r\n]/.test(name);
export function senderNames(value: unknown): SenderNames {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error('mail_config_invalid: tools.mail.senders needs {"ADDRESS": "Display Name", ...}, the From name of every address this account sends as');
  for (const [address, name] of Object.entries(value)) {
    if (!address.includes('@') || address !== baseAddress(address)) throw new Error(`mail_config_invalid: tools.mail.senders key ${JSON.stringify(address)} must be a lower-case address without a +tag`);
    if (!displayName(name)) throw new Error(`mail_config_invalid: tools.mail.senders[${address}] must be a one-line display name`);
  }
  return value as SenderNames;
}
function hostedMailbox(address: string, value: unknown): Mailbox {
  if (!address.includes('@') || address !== lower(address)) throw new Error(`mail_config_invalid: tools.mail.mailboxes key ${JSON.stringify(address)} must be a lower-case mail address`);
  if (!value || typeof value !== 'object') throw new Error(`mail_config_invalid: tools.mail.mailboxes[${address}] needs account and fromName`);
  const { account, fromName, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length) throw new Error(`mail_config_invalid: tools.mail.mailboxes[${address}] has unknown keys ${Object.keys(extra).join(', ')}`);
  if (typeof account !== 'string' || !account.startsWith('/')) throw new Error(`mail_config_invalid: tools.mail.mailboxes[${address}].account must be the absolute path of its account file`);
  if (!displayName(fromName)) throw new Error(`mail_config_invalid: tools.mail.mailboxes[${address}] needs fromName, the display name on its sent mail`);
  return { address, account, fromName };
}
async function mailSettings(person: PersonConfig): Promise<MailSettings> {
  const path = person.extensionConfigPath;
  const settings: unknown = path ? JSON.parse(await readFile(path, 'utf8')).tools?.mail : undefined;
  if (!settings || typeof settings !== 'object') throw new Error('mail_unconfigured: Mail is not configured for this account');
  const value = settings as Record<string, unknown>;
  if ('mailboxes' in value) {
    if ('credentialPath' in value || 'account' in value || 'senders' in value) throw new Error('mail_config_invalid: tools.mail names both hosted mailboxes (each with its fromName) and Bridge settings');
    const entries = value.mailboxes && typeof value.mailboxes === 'object' && !Array.isArray(value.mailboxes) ? Object.entries(value.mailboxes) : [];
    if (!entries.length) throw new Error('mail_config_invalid: tools.mail.mailboxes needs at least one {"ADDRESS": {"account": PATH, "fromName": NAME}}');
    return { kind: 'hosted', mailboxes: entries.map(([address, mailbox]) => hostedMailbox(address, mailbox)) };
  }
  if (typeof value.credentialPath === 'string' && value.credentialPath) {
    const port = (key: string) => typeof value[key] === 'number' ? value[key] as number : undefined;
    return { kind: 'bridge', credentialPath: value.credentialPath, port: port('port'), imapPort: port('imapPort'), senders: senderNames(value.senders) };
  }
  throw new Error('mail_config_invalid: tools.mail needs mailboxes (hosted IMAP/SMTP account files by address) or credentialPath (Proton Bridge)');
}
/** The mailbox a call works in: the one named, the only one, or for a draft/send the one whose address is its from. */
export function chooseMailbox(mailboxes: Mailbox[], named: string | undefined, from: string | undefined): Mailbox {
  const known = mailboxes.map(mailbox => mailbox.address).join(', ');
  if (named !== undefined) {
    const mailbox = mailboxes.find(candidate => candidate.address === lower(named));
    if (!mailbox) throw new Error(`mailbox_unknown: ${named} is not one of your mailboxes (${known})`);
    return mailbox;
  }
  if (mailboxes.length === 1) return mailboxes[0]!;
  const sender = from === undefined ? undefined : mailboxes.find(candidate => candidate.address === baseAddress(from));
  if (sender) return sender;
  throw new Error(`mailbox_required: you have several mailboxes (${known}); pass mailbox`);
}
type Target = { kind: 'hosted'; mailbox: Mailbox } | Exclude<MailSettings, { kind: 'hosted' }>;
export function mailEnv(person: Pick<PersonConfig, 'unixUser'>, target: Target): string[] {
  switch (target.kind) {
    case 'hosted': return [`MAIL_ACCOUNT_FILE=${target.mailbox.account}`];
    case 'bridge': {
      // Kenan's personal Bridge login is mail_identity's local cache, filled from its Proton Pass entry.
      if (person.unixUser === 'kenan') return [];
      const env = [`MAIL_BRIDGE_CREDENTIAL_FILE=${target.credentialPath}`];
      if (target.port) env.push(`MAIL_BRIDGE_SMTP_PORT=${target.port}`);
      if (target.imapPort || target.port) env.push(`MAIL_BRIDGE_IMAP_PORT=${target.imapPort ?? target.port! - 1}`);
      return env;
    }
  }
}
const targets = (settings: MailSettings): Target[] => settings.kind === 'hosted' ? settings.mailboxes.map(mailbox => ({ kind: 'hosted', mailbox })) : [settings];
/** The folder `mail-search` reads as every folder new mail can land in: INBOX, Spam, Archive and every user folder and label
 *  (not Sent, Drafts, Trash or All Mail), a message in several listed once. Proton filters file mail straight into folders,
 *  so a wait on INBOX alone missed codes and replies filed elsewhere (2026-11-02). The default of every mail wait, wake and search. */
export const EVERY_FOLDER = '*';
/** folder is where the message is; reference (UIDVALIDITY:UID) also finds it with folder "*", each folder having its own UIDVALIDITY. */
export interface MailRow { uid: string; date: string; from: string; subject: string; reference: string; messageId: string; folder: string }
/** mailbox is the hosted mailbox's address when the person has several, else null. */
export type FoundMail = MailRow & { mailbox: string | null };
const mailRows = (output: string) => output.trim().split('\n').filter(line => line && !line.startsWith('#')).map((line): MailRow => {
  const [uid = '', date = '', from = '', subject = '', reference = '', messageId = '', folder = ''] = line.split('\t'); return { uid, date, from, subject, reference, messageId, folder };
});
/** A folder's position as of a search (UIDVALIDITY:newest UID, or for "*" an opaque token), per mailbox address ('bridge' for a Proton Bridge account). */
export type MailPositions = Map<string, string>;
const targetKey = (target: Target) => target.kind === 'hosted' ? target.mailbox.address : 'bridge';
const nextPosition = (output: string) => /^# next=(\S+)$/m.exec(output)?.[1];
/** Stateless continuations survive restarts and retain every folder's watermark, without printing the expanded map. */
function compactToken(token: string): string {
  // CLI folder maps have an F prefix; page cursors are plain base64url JSON.
  const prefix = token.startsWith('F') ? 'F' : '';
  const payload = token.slice(prefix.length), bytes = Buffer.from(payload, 'base64url');
  if (bytes.toString('base64url') !== payload) return token;
  const compressed = `z1.${prefix}.${deflateRawSync(bytes).toString('base64url')}`;
  return compressed.length < token.length ? compressed : token;
}
function expandToken(token: string | undefined): string | undefined {
  if (!token?.startsWith('z1.')) return token;
  try {
    const match = /^z1\.(F?)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) throw new Error('invalid compressed token');
    return match[1]! + inflateRawSync(Buffer.from(match[2]!, 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('base64url');
  }
  catch { throw new Error('invalid_mail_continuation: use the complete cursor or after from the preceding result'); }
}
function listedMail(row: MailRow, full?: boolean) {
  if (full) return row;
  const { uid: _uid, messageId: _messageId, ...item } = row;
  return item;
}

/** Check the installed CLI's local help before background mail starts; no credentials or IMAP connection needed. */
export async function checkMailCli(placement: ProcessPlacement, person: PersonConfig, signal?: AbortSignal): Promise<void> {
  const fail = () => new Error('mail_cli_incompatible: /usr/local/bin/mail-search must support position and search --after TOKEN; run sh deploy/install-mail.sh install from the running app source');
  try {
    const result = await ownerProcess(placement, person, '/usr/local/bin/mail-search', ['--help'], undefined, signal, undefined, 10);
    const help = result.output.toString();
    if (result.exitCode !== 0 || result.termination !== 'exit' || !/mail-search position FOLDER/.test(help) || !/mail-search search FOLDER[^\n]*--after TOKEN/.test(help)) throw fail();
  } catch (e) {
    if (signal?.aborted) return;
    throw fail();
  }
}
const mailSearchError = (operation: string, exitCode: number, output: string) => new Error(exitCode === 64
  ? `mail_cli_incompatible: mail-search rejected ${operation}; run sh deploy/install-mail.sh install from the running app source`
  : `mail-search ${operation} exited ${exitCode}: ${output.trim().slice(-500) || 'no output'}`);
async function targetPosition(placement: ProcessPlacement, person: PersonConfig, target: Target, folder: string, criteria: string, signal?: AbortSignal): Promise<string> {
  const result = await ownerProcess(placement, person, '/usr/bin/env', [...mailEnv(person, target), '/usr/local/bin/mail-search', 'position', folder, '--criteria', criteria], undefined, signal, undefined, 90);
  const output = result.output.toString();
  if (result.exitCode !== 0) throw mailSearchError('position', result.exitCode, output);
  const position = nextPosition(output);
  if (!position) throw new Error('mail-search position returned no UID watermark');
  return position;
}
/** Capture each mailbox's folder UID watermark with STATUS, without searching criteria or fetching messages.
 * Criteria are parsed by the CLI so a malformed expression fails at scheduling, not in a background watch. */
export async function mailPosition(placement: ProcessPlacement, person: PersonConfig, folder: string, criteria: string, signal?: AbortSignal): Promise<MailPositions> {
  return new Map(await Promise.all(targets(await mailSettings(person)).map(async target =>
    [targetKey(target), await targetPosition(placement, person, target, folder, criteria, signal)] as const)));
}
/** The newest 400 messages in a folder matching IMAP search criteria, oldest first, in each of the person's mailboxes.
 * With `idle`, each mailbox first waits (IMAP IDLE, up to `seconds`) for a message newer than its position in `idle.after`;
 * a mailbox already past it, or with no position yet, searches at once, and the first mailbox to answer ends the others'
 * waits (they are searched again next time). `positions` comes back for the next call. With `newerThan`, criteria only examine UIDs above each mailbox/folder watermark. */
export async function searchMail(placement: ProcessPlacement, person: PersonConfig, folder: string, criteria: string, signal?: AbortSignal, idle?: { after: MailPositions; seconds: number }, newerThan?: MailPositions): Promise<{ rows: FoundMail[]; positions: MailPositions }> {
  const all = targets(await mailSettings(person));
  const first = new AbortController();
  const stop = () => first.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const positions: MailPositions = new Map(idle?.after ?? []);
  try {
    const found = await Promise.all(all.map(async (target): Promise<FoundMail[]> => {
      const after = idle?.after.get(targetKey(target));
      const wait = idle && after ? ['--idle-after', after, '--idle', String(idle.seconds)] : [];
      const baseline = newerThan?.get(targetKey(target));
      if (newerThan && !baseline) throw new Error(`mailbox_position_missing: no scheduled UID watermark for ${targetKey(target)}; arrival cannot be determined`);
      const bounded = baseline ? ['--after', baseline] : [];
      const result = await ownerProcess(placement, person, '/usr/bin/env', [...mailEnv(person, target), '/usr/local/bin/mail-search', 'search', folder, ...wait, ...bounded, '--criteria', criteria], undefined, first.signal, undefined, 90 + (wait.length ? idle!.seconds : 0));
      if (result.termination === 'cancelled' && !signal?.aborted) return [];
      const output = result.output.toString();
      if (result.exitCode !== 0) throw mailSearchError('search', result.exitCode, output);
      const next = nextPosition(output);
      if (!next) throw new Error('mail-search search returned no UID watermark');
      positions.set(targetKey(target), next);
      if (wait.length) first.abort();
      const mailbox = target.kind === 'hosted' && all.length > 1 ? target.mailbox.address : null;
      return mailRows(output).map(row => ({ ...row, mailbox }));
    }));
    return { rows: found.flat(), positions };
  } finally { signal?.removeEventListener('abort', stop); }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An IMAP SEARCH date (1-Nov-2026), in UTC. */
export const imapDate = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
/** How far back a folder watch lists mail, and the longest one IMAP IDLE lasts. */
export const WATCH_LOOKBACK_MS = 2 * 86_400_000;
export const WATCH_IDLE_SECONDS = 600;
type Search = typeof searchMail;
type Watch = { result: Promise<{ rows: FoundMail[]; positions: MailPositions }>; stop: AbortController; waiters: number };
/** Waits until a person's folder moves past `after` (at once when `after` is null) and lists its last WATCH_LOOKBACK_MS of
 *  mail. Callers watching the same folder from the same position share one wait, so one mail-search IDLE process per
 *  mailbox serves the inbound-mail channel and every mail wake on that folder (until 2026-11-01 each held its own:
 *  17 IDLE processes at once). The shared wait stops early only when every caller has gone. */
export function folderWatches(search: Search) {
  const watches = new Map<string, Watch>();
  return (placement: ProcessPlacement, person: PersonConfig, folder: string, after: MailPositions | null, now: number, signal: AbortSignal): Promise<{ rows: FoundMail[]; positions: MailPositions }> => {
    const key = [person.id, folder, ...[...after ?? []].sort().map(([k, v]) => `${k}=${v}`)].join('\0');
    let watch = watches.get(key);
    if (!watch) {
      const stop = new AbortController();
      const result = search(placement, person, folder, `SINCE ${imapDate(now - WATCH_LOOKBACK_MS)}`, stop.signal, after ? { after, seconds: WATCH_IDLE_SECONDS } : undefined);
      const started: Watch = watch = { result, stop, waiters: 0 };
      watches.set(key, started);
      void result.catch(() => undefined).finally(() => { if (watches.get(key) === started) watches.delete(key); });
    }
    const shared = watch;
    shared.waiters++;
    return new Promise((resolve, reject) => {
      let left = false;
      const leave = () => { if (left) return false; left = true; signal.removeEventListener('abort', gone); shared.waiters--; return true; };
      const gone = () => {
        if (!leave()) return;
        if (shared.waiters === 0) { shared.stop.abort(); if (watches.get(key) === shared) watches.delete(key); }
        reject(signal.reason ?? new Error('aborted'));
      };
      if (signal.aborted) { gone(); return; }
      signal.addEventListener('abort', gone, { once: true });
      shared.result.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    });
  };
}
export const watchFolder = folderWatches(searchMail);

export interface MailMessage { reference: string; from: string; to: string; date: string; subject: string; body: string; attachments: string[] }
/** Parses `mail-search read` output: one "===== UIDVALIDITY:UID\tFrom: …\tDate: …" block per message. */
export function parseRead(output: string): MailMessage[] {
  return output.split(/^===== /m).slice(1).map(block => {
    const [first = '', ...rest] = block.split('\n');
    const [reference = '', from = '', date = ''] = first.split('\t');
    const header = (name: string) => rest.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
    const blank = rest.indexOf('');
    const text = rest.slice(blank + 1).join('\n');
    const cut = text.search(/\nAttachments \(\d+\):\n/);
    const attachments = cut < 0 ? [] : text.slice(cut).split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).split('\t')[0]!);
    return { reference, from: from.replace(/^From: /, ''), date: date.replace(/^Date: /, ''), to: header('To'), subject: header('Subject'), body: (cut < 0 ? text : text.slice(0, cut)).trim(), attachments };
  });
}
/** Reads whole messages (headers, text body, attachment names) without marking them seen; mailbox is a hosted mailbox's address, null for the only one. */
export async function readMail(placement: ProcessPlacement, person: PersonConfig, mailbox: string | null, folder: string, references: string[], signal?: AbortSignal): Promise<MailMessage[]> {
  const settings = await mailSettings(person);
  const target: Target = settings.kind === 'hosted' ? { kind: 'hosted', mailbox: chooseMailbox(settings.mailboxes, mailbox ?? undefined, undefined) } : settings;
  const result = await ownerProcess(placement, person, '/usr/bin/env', [...mailEnv(person, target), '/usr/local/bin/mail-search', 'read', folder, ...references], undefined, signal, undefined, 120);
  const output = result.output.toString();
  if (result.exitCode !== 0) throw new Error(`mail-search read exited ${result.exitCode}: ${output.trim().slice(-500) || 'no output'}`);
  return parseRead(output);
}

export interface SavedAttachment { path: string; bytes: number; type: string; filename: string }
const savedAttachments = (output: string) => output.trim().split('\n').filter(line => line && !line.startsWith('#')).map((line): SavedAttachment => {
  const [path = '', bytes = '', type = '', filename = ''] = line.split('\t'); return { path, bytes: Number(bytes), type, filename };
});

/** The writers (agents' own conversation ids) whose mail threads `agent` continues without naming a supersede: for a worker,
 * its person's manager and the ended (archived or stopped) workers on its goal; for a manager, any ended worker of its person.
 * A live writer's thread stays fenced, so one outbound channel never has two writers at once. */
export function inheritableWriters(agent: AgentInfo, agents: AgentInfo[]): string[] {
  const ended = (other: AgentInfo) => other.role === 'worker' && (other.archived || other.state === 'stopped');
  return agents.filter(other => other.id !== agent.id && other.ownerId === agent.ownerId && (agent.role === 'manager'
    ? ended(other)
    : other.role === 'manager' || (ended(other) && agent.goalId !== null && other.goalId === agent.goalId))).map(other => other.conversationId);
}

export type MailArgs = PageRequest & { full?: boolean; action: 'folders' | 'search' | 'wait' | 'read' | 'attachments' | 'move' | 'spam' | 'archive' | 'trash' | 'draft' | 'send' | 'inspect'; destination?: string; timeoutSeconds?: number; sinceSeconds?: number; after?: string; mailbox?: string; folder?: string; criteria?: string; references?: string[]; directory?: string; to?: string[]; cc?: string[]; subject?: string; body?: string; attachments?: string[]; replyTo?: string; from?: string; fromName?: string; requestId?: string; continueAfter?: string; supersede?: string[]; reason?: string };
export function createMailExtension(): Extension {
  return { id: 'mail', name: 'Mail', promptSnippet: 'Use mail to search/read mail, wait for a mail you just triggered (a sign-in link or code: action "wait", never sleep-and-search; without folder, search and wait cover every folder new mail lands in, Spam and filter folders included), save a message\'s attachments to a directory, and draft explicitly authorized messages; sending goes through the send tool (mail:ADDRESS, or mail with replyTo). Read CLI errors.', tool: (ctx: ToolContext) => ({
    name: 'mail', files: 'writes', records: 'none', label: 'Mail', description: 'Search, wait for, read, move, draft and inspect mail (send it with the send tool, to "mail:ADDRESS" or "mail" with replyTo). Folders: mail filters file incoming mail straight into folders, so without folder, search and wait cover every folder new mail can land in (INBOX, Spam, Archive and every user folder and label; not Sent, Drafts, Trash or All Mail), each message once, and every result names its folder; folder narrows them to one folder (e.g. "Sent" or "All Mail"). Search/folders return {items,nextCursor}, 20 per page (max 50). Search shows newest first, within the newest 400 matches of each folder; repeat same folder/criteria with cursor. Search/wait items include date, from, subject, reference and folder; full:true also includes uid and messageId. Continuations are opaque: pass the complete nextCursor as cursor or after as after. Wait: after you trigger a mail (a sign-in link, a code, a receipt), returns the matching mail that arrives within timeoutSeconds (1–' + MAX_WAIT_SECONDS + ') as {items} the moment the mail server has it, or {timedOut: true, after}; sinceSeconds also accepts matches received up to that many seconds before the call (use it when the mail may already be in), and after (a timed-out wait\'s after) continues past mail already seen. Proton mail reaches the mailbox 20–40 s after it is sent. Read, attachments, move and replyTo take a result\'s reference (UIDVALIDITY:UID) as is and find its folder themselves (FOLDER/UIDVALIDITY:UID also works). Read lists attachments (name, type, bytes). Attachments saves one message\'s attachments (references: exactly one) into directory, read-only, and returns their paths. Move takes references and destination, an existing folder (else a folder-missing error), and returns {moved}; spam, archive and trash are move to Spam (how Proton learns to filter it), Archive and Trash. With several mailboxes, pass mailbox (its address) except on a draft/send whose from is a mailbox address. Draft/send pick From: explicit from (must be an address this mailbox owns), else on a reply the address of ours the replied-to message was delivered to; otherwise a sender-required error. There is no default sender; the output names the choice as "# from: NAME <ADDRESS> (basis)". The From display name is the one configured for that address (or the mailbox), or fromName for this send; an address with no configured name is a sender-name-unconfigured error.',
    parameters: Type.Object({ ...pageParameters, full: Type.Optional(Type.Boolean({ description: 'Include uid and messageId in search/wait results; reference already suffices to read or act on mail.' })), action: Type.Union(['folders','search','wait','read','attachments','move','spam','archive','trash','draft','inspect'].map(value => Type.Literal(value))), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_SECONDS })), sinceSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })), after: Type.Optional(Type.String({ description: 'For wait: the after a timed-out wait returned, to continue past mail already seen' })), mailbox: Type.Optional(Type.String({ description: 'Which of your mailboxes (its address), needed only when you have several; a draft or send from a mailbox address works in that mailbox' })), folder: Type.Optional(Type.String({ description: 'One folder to search or wait in (e.g. "INBOX", "Sent", "All Mail"); omitted, every folder new mail can land in. Read, attachments and move find a reference\'s folder without it' })), destination: Type.Optional(Type.String({ description: 'For move: the existing folder to move the references to' })), criteria: Type.Optional(Type.String()), references: Type.Optional(Type.Array(Type.String())), directory: Type.Optional(Type.String({ description: 'For attachments: directory to save into (created if missing; relative paths are under your home). Existing files are never overwritten.' })), to: Type.Optional(Type.Array(Type.String())), cc: Type.Optional(Type.Array(Type.String())), subject: Type.Optional(Type.String()), body: Type.Optional(Type.String()), attachments: Type.Optional(Type.Array(Type.String())), replyTo: Type.Optional(Type.String({ description: 'Reference (UIDVALIDITY:UID) of the message replied to, as search, wait or a wake gave it; or FOLDER/UIDVALIDITY:UID. Without to, replies to its Reply-To/From' })), from: Type.Optional(Type.String({ description: 'Sender address, one this mailbox owns. Required for a new message; on a reply it overrides the address the replied-to message reached' })), fromName: Type.Optional(Type.String({ description: 'From display name for this send only, replacing the name configured for the sender address' })), requestId: Type.Optional(Type.String()), continueAfter: Type.Optional(Type.String({ description: 'Rarely needed: the request this send follows; omit it to continue the thread\'s latest request automatically' })), supersede: Type.Optional(Type.Array(Type.String({ description: 'Take a thread over from a live writer or past an unsettled request: the request ids a thread-fenced error names, with reason' }))), reason: Type.Optional(Type.String()) }),
    execute: (_id, raw: unknown, signal) => runMail(ctx, raw as MailArgs, signal),
  }) };
}

/** Page order of search rows, newest first: by date, since UIDs of different folders don't compare. */
export const newestFirst = (row: MailRow) => `${String(9e13 - (Date.parse(row.date) || 0)).padStart(14, '0')} ${row.folder} ${row.uid.padStart(10, '0')}`;

const MOVE_FOLDERS = { spam: 'Spam', archive: 'Archive', trash: 'Trash' } as const;
/** The folder a move, spam, archive or trash action moves to; move names it as destination. */
export function moveDestination(args: Pick<MailArgs, 'action' | 'destination'>): string {
  if (args.action === 'move') { if (!args.destination) throw new Error('destination required for move (an existing folder)'); return args.destination; }
  if (args.action === 'spam' || args.action === 'archive' || args.action === 'trash') { if (args.destination) throw new Error(`${args.action} moves to ${MOVE_FOLDERS[args.action]}; use move for another destination`); return MOVE_FOLDERS[args.action]; }
  throw new Error(`${args.action} is not a move action`);
}

/** One mail action as the person. The mail tool runs every action but send; the send tool (server/channels/send.ts) runs send. */
export async function runMail(ctx: ToolContext, args: MailArgs, signal?: AbortSignal) {
      const settings = await mailSettings(ctx.person);
      const target: Target = settings.kind === 'hosted' ? { kind: 'hosted', mailbox: chooseMailbox(settings.mailboxes, args.mailbox, args.action === 'draft' || args.action === 'send' ? args.from : undefined) } : settings;
      if (settings.kind === 'bridge' && args.mailbox !== undefined) throw new Error('mailbox_unknown: this account has one Proton mailbox; omit mailbox');
      const env = mailEnv(ctx.person, target);
      let command: string, cli: string[], body: string | undefined;
      if (args.action === 'attachments') {
        const [reference, ...extra] = args.references ?? [];
        if (!reference || extra.length) throw new Error('attachments takes exactly one reference');
        if (!args.directory) throw new Error('directory required');
        command = '/usr/local/bin/mail-search'; cli = ['attachments', args.folder ?? EVERY_FOLDER, reference, '--out', args.directory];
      } else if (args.action === 'folders' || args.action === 'search' || args.action === 'read') {
        command = '/usr/local/bin/mail-search'; cli = [args.action];
        if (args.action !== 'folders') cli.push(args.folder ?? EVERY_FOLDER);
        if (args.action === 'search') cli.push('--criteria', args.criteria ?? 'ALL');
        if (args.action === 'read') { if (!args.references?.length) throw new Error('references required'); cli.push(...args.references); }
      } else if (args.action === 'move' || args.action === 'spam' || args.action === 'archive' || args.action === 'trash') {
        if (!args.references?.length) throw new Error('references required');
        const destination = moveDestination(args);
        command = '/usr/local/bin/mail-search'; cli = ['move', args.folder ?? EVERY_FOLDER, destination, ...args.references];
      } else if (args.action === 'wait') {
        if (!args.criteria?.trim()) throw new Error('criteria required for wait (IMAP search, e.g. FROM "anthropic")');
        if (args.timeoutSeconds === undefined) throw new Error('timeoutSeconds is required for wait');
        command = '/usr/local/bin/mail-search'; cli = ['wait', args.folder ?? EVERY_FOLDER, '--timeout', String(args.timeoutSeconds)];
        if (args.sinceSeconds) cli.push('--since', String(args.sinceSeconds));
        if (args.after) cli.push('--after', expandToken(args.after)!);
        cli.push('--criteria', args.criteria);
      } else {
        command = '/usr/local/bin/mail-send'; cli = [];
        if (args.action === 'inspect') { if (!args.requestId) throw new Error('requestId required'); cli.push('--inspect-action', args.requestId); }
        else {
          if (args.body === undefined) throw new Error('body required');
          if (!args.to?.length && !args.replyTo) throw new Error('to required unless replying (replyTo)');
          cli.push('--stdin-envelope');
          let inheritWriters: string[] = [];
          if (args.action === 'send') {
            const agents = await ctx.deps.store.listAgents(ctx.agent.ownerId, { includeArchived: true });
            const self = agents.find(agent => agent.id === ctx.agent.id);
            if (!self) throw new Error(`agent_missing: ${ctx.agent.id} is not among its owner's agents`);
            inheritWriters = inheritableWriters(self, agents);
          }
          body = JSON.stringify({ body: args.body, inheritWriters, senderNames: settings.kind === 'bridge' ? settings.senders : {} });
          for (const to of args.to ?? []) cli.push('--to', to);
          for (const cc of args.cc ?? []) cli.push('--cc', cc);
          for (const path of args.attachments ?? []) cli.push('--attach', path);
          if (args.subject) cli.push('--subject', args.subject);
          if (args.from) cli.push('--from-addr', args.from);
          const fromName = args.fromName ?? (target.kind === 'hosted' ? target.mailbox.fromName : undefined);
          if (fromName !== undefined) cli.push('--from-name', fromName);
          if (args.replyTo) {
            cli.push('--reply-to', args.replyTo.includes('/') ? args.replyTo : `${args.folder ?? EVERY_FOLDER}/${args.replyTo}`);
          }
          if (args.action === 'send') {
            if (!args.requestId) throw new Error('requestId required for send');
            cli.push('--send', '--request-id', args.requestId, '--writer-id', ctx.agent.conversationId);
            if (args.continueAfter) cli.push('--continue-after', args.continueAfter);
            for (const prior of args.supersede ?? []) cli.push('--supersede', prior);
            if (args.reason) cli.push('--reason', args.reason);
          }
        }
      }
      const result = await ownerProcess(ctx.deps.placement, ctx.person, '/usr/bin/env', [...env, command, ...cli], body, signal, undefined, 90 + (args.action === 'wait' ? args.timeoutSeconds! : 0));
      let output = result.output.toString();
      if (args.action === 'send' && (result.exitCode !== 0 || result.termination !== 'exit')) {
        // Diagnostics (including the From line) can surround the CLI's JSON result.
        const jsonResult = (text: string): Record<string, unknown> | undefined => {
          for (const line of text.trim().split('\n').reverse()) {
            try {
              const value: unknown = JSON.parse(line);
              if (value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value && typeof value.ok === 'boolean') return value as Record<string, unknown>;
            } catch { /* Not a JSON result. */ }
          }
          return undefined;
        };
        // A normal CLI failure already describes its outcome; do not replace its typed error.
        if (result.termination !== 'exit' || !jsonResult(output)) {
          let receipt: Record<string, unknown> | null = null;
          let inspectionError: unknown;
          try {
            const inspection = await ownerProcess(ctx.deps.placement, ctx.person, '/usr/bin/env', [...env, '/usr/local/bin/mail-send', '--inspect-action', args.requestId!], undefined, undefined, undefined, 10);
            const inspected = jsonResult(inspection.output.toString());
            if (inspected?.value && typeof inspected.value === 'object' && !Array.isArray(inspected.value)) receipt = inspected.value as Record<string, unknown>;
            if (inspection.termination !== 'exit' || inspection.exitCode !== 0) inspectionError = inspected ?? { exitCode: inspection.exitCode, termination: inspection.termination };
          } catch {
            inspectionError = { error: 'mail-receipt-inspection-failed' };
          }
          if (receipt?.state === 'succeeded') return processResult({ exitCode: 0, output: result.output }, JSON.stringify({ ok: true, requestId: args.requestId, value: receipt, replayed: true, recovered: true }));
          const error = result.termination === 'timeout' ? 'mail-send-timeout' : result.termination === 'exit' ? 'mail-send-failed' : 'mail-send-interrupted';
          return processResult({ exitCode: result.exitCode || 1, output: result.output }, JSON.stringify({
            ok: false, error, requestId: args.requestId, value: receipt,
            retrySameRequest: receipt?.state === 'prepared' || receipt?.state === 'failed-before-effect',
            message: 'Send outcome is not confirmed. Inspect the same requestId with action=inspect; do not create a new ID or resend.',
            ...(inspectionError === undefined ? {} : { inspectionError }),
          }));
        }
      }
      if (result.exitCode === 0 && args.action === 'wait') {
        const timedOut = /^# wait: timed-out; after=(\S+)$/m.exec(output);
        output = JSON.stringify(timedOut ? { timedOut: true, after: compactToken(timedOut[1]!) } : { items: mailRows(output).reverse().map(row => listedMail(row, args.full)) });
      }
      if (result.exitCode === 0 && (args.action === 'folders' || args.action === 'search')) {
        const rows: ({ folder: string } | MailRow)[] = args.action === 'folders' ? output.trim().split('\n').filter(line => line && !line.startsWith('#')).map(folder => ({ folder })) : mailRows(output);
        const page = arrayPage(rows, { ...args, cursor: expandToken(args.cursor) }, JSON.stringify(['mail',ctx.person.id,target.kind === 'hosted' ? target.mailbox.address : 'bridge',args.action,args.folder ?? EVERY_FOLDER,args.criteria ?? 'ALL']), row => 'uid' in row ? newestFirst(row) : row.folder);
        output = JSON.stringify({ items: page.items.map(row => 'uid' in row ? listedMail(row, args.full) : row), nextCursor: page.nextCursor === null ? null : compactToken(page.nextCursor) });
      }
      if (result.exitCode === 0 && output.trim() !== '' && (args.action === 'move' || args.action === 'spam' || args.action === 'archive' || args.action === 'trash')) output = JSON.stringify({ moved: output.trim().split('\n').filter(line => !line.startsWith('#')).map(line => { const [reference = '', destination = ''] = line.split('\t'); return { reference, destination }; }) });
      if (result.exitCode === 0 && args.action === 'attachments') output = JSON.stringify({ saved: savedAttachments(output) });
      return processResult(result, output);
}

export const mailExtension = createMailExtension();
