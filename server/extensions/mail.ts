import { pageParameters, arrayPage, type PageRequest } from '../tools/pagination.js';
import { readFile } from 'node:fs/promises';
import { Type } from 'typebox';
import type { Extension, ToolContext } from '../types.js';
import type { PersonConfig } from '../config.js';
import { ownerProcess, processResult, type ProcessPlacement } from '../tools/owner.js';

type MailSettings =
  | { kind: 'hosted'; account: string; fromName: string }
  | { kind: 'bridge'; credentialPath: string; port: number | undefined; imapPort: number | undefined };
async function mailSettings(person: PersonConfig): Promise<MailSettings> {
  const path = person.extensionConfigPath;
  const settings: unknown = path ? JSON.parse(await readFile(path, 'utf8')).tools?.mail : undefined;
  if (!settings || typeof settings !== 'object') throw new Error('mail_unconfigured: Mail is not configured for this account');
  const value = settings as Record<string, unknown>;
  if (typeof value.account === 'string' && value.account) {
    if ('credentialPath' in value) throw new Error('mail_config_invalid: tools.mail names both a hosted account and a Bridge credential');
    if (typeof value.fromName !== 'string' || !value.fromName.trim()) throw new Error('mail_config_invalid: a hosted tools.mail needs fromName, the display name on its sent mail');
    return { kind: 'hosted', account: value.account, fromName: value.fromName };
  }
  if (typeof value.credentialPath === 'string' && value.credentialPath) {
    const port = (key: string) => typeof value[key] === 'number' ? value[key] as number : undefined;
    return { kind: 'bridge', credentialPath: value.credentialPath, port: port('port'), imapPort: port('imapPort') };
  }
  throw new Error('mail_config_invalid: tools.mail needs account (hosted IMAP/SMTP account file) or credentialPath (Proton Bridge)');
}
export function mailEnv(person: Pick<PersonConfig, 'unixUser'>, settings: MailSettings): string[] {
  switch (settings.kind) {
    case 'hosted': return [`MAIL_ACCOUNT_FILE=${settings.account}`];
    case 'bridge': {
      // Kenan's existing CLI owns the working personal Bridge through its Pass entry.
      if (person.unixUser === 'kenan') return [];
      const env = [`MAIL_BRIDGE_CREDENTIAL_FILE=${settings.credentialPath}`];
      if (settings.port) env.push(`MAIL_BRIDGE_SMTP_PORT=${settings.port}`);
      if (settings.imapPort || settings.port) env.push(`MAIL_BRIDGE_IMAP_PORT=${settings.imapPort ?? settings.port! - 1}`);
      return env;
    }
  }
}
export interface MailRow { uid: string; date: string; from: string; subject: string; reference: string; messageId: string }
const mailRows = (output: string) => output.trim().split('\n').filter(line => line && !line.startsWith('#')).map((line): MailRow => {
  const [uid = '', date = '', from = '', subject = '', reference = '', messageId = ''] = line.split('\t'); return { uid, date, from, subject, reference, messageId };
});
/** The newest 400 messages in a folder matching IMAP search criteria, oldest first. */
export async function searchMail(placement: ProcessPlacement, person: PersonConfig, folder: string, criteria: string, signal?: AbortSignal): Promise<MailRow[]> {
  const result = await ownerProcess(placement, person, '/usr/bin/env', [...mailEnv(person, await mailSettings(person)), '/usr/local/bin/mail-search', 'search', folder, '--criteria', criteria], undefined, signal, undefined, 90);
  const output = result.output.toString();
  if (result.exitCode !== 0) throw new Error(`mail-search exited ${result.exitCode}: ${output.trim().slice(-500) || 'no output'}`);
  return mailRows(output);
}

export interface SavedAttachment { path: string; bytes: number; type: string; filename: string }
const savedAttachments = (output: string) => output.trim().split('\n').filter(line => line && !line.startsWith('#')).map((line): SavedAttachment => {
  const [path = '', bytes = '', type = '', filename = ''] = line.split('\t'); return { path, bytes: Number(bytes), type, filename };
});

type MailArgs = PageRequest & { action: 'folders' | 'search' | 'read' | 'attachments' | 'draft' | 'send' | 'inspect'; folder?: string; criteria?: string; references?: string[]; directory?: string; to?: string[]; cc?: string[]; subject?: string; body?: string; attachments?: string[]; replyTo?: string; from?: string; requestId?: string; continueAfter?: string; supersede?: string[]; reason?: string };
export function createMailExtension(): Extension {
  return { id: 'mail', name: 'Mail', promptSnippet: 'Use mail to search/read mail, save a message\'s attachments to a directory, and draft or send explicitly authorized messages. A reply is sent from the address of ours the replied-to message reached; a new message needs an explicit from. For sending reuse the requestId for that exact message. Read CLI errors; do not resend an uncertain outcome.', tool: (ctx: ToolContext) => ({
    name: 'mail', files: 'writes', label: 'Mail', description: 'Search, read, draft, send and inspect mail. Search/folders return {items,nextCursor}, 20 per page (max 50). Search shows newest first within the CLI newest-400-UID window; repeat same folder/criteria with cursor. Read uses exact UID references and lists attachments (name, type, bytes). Attachments saves one message\'s attachments (references: exactly one) into directory, read-only, and returns their paths. Draft/send pick From: explicit from (must be an address this mailbox owns), else on a reply the address of ours the replied-to message was delivered to; otherwise a sender-required error. There is no default sender; the output names the choice as "# from: ADDRESS (basis)".',
    parameters: Type.Object({ ...pageParameters, action: Type.Union(['folders','search','read','attachments','draft','send','inspect'].map(value => Type.Literal(value))), folder: Type.Optional(Type.String()), criteria: Type.Optional(Type.String()), references: Type.Optional(Type.Array(Type.String())), directory: Type.Optional(Type.String({ description: 'For attachments: directory to save into (created if missing; relative paths are under your home). Existing files are never overwritten.' })), to: Type.Optional(Type.Array(Type.String())), cc: Type.Optional(Type.Array(Type.String())), subject: Type.Optional(Type.String()), body: Type.Optional(Type.String()), attachments: Type.Optional(Type.Array(Type.String())), replyTo: Type.Optional(Type.String({ description: 'Search reference (UIDVALIDITY:UID) of the message replied to, with folder set to the folder it was found in; or FOLDER/UIDVALIDITY:UID. Without to, replies to its Reply-To/From' })), from: Type.Optional(Type.String({ description: 'Sender address, one this mailbox owns. Required for a new message; on a reply it overrides the address the replied-to message reached' })), requestId: Type.Optional(Type.String()), continueAfter: Type.Optional(Type.String()), supersede: Type.Optional(Type.Array(Type.String())), reason: Type.Optional(Type.String()) }),
    execute: async (_id, raw: unknown, signal) => {
      const args = raw as MailArgs;
      const settings = await mailSettings(ctx.person);
      const env = mailEnv(ctx.person, settings);
      let command: string, cli: string[], body: string | undefined;
      if (args.action === 'attachments') {
        const [reference, ...extra] = args.references ?? [];
        if (!reference || extra.length) throw new Error('attachments takes exactly one reference');
        if (!args.directory) throw new Error('directory required');
        command = '/usr/local/bin/mail-search'; cli = ['attachments', args.folder ?? 'INBOX', reference, '--out', args.directory];
      } else if (args.action === 'folders' || args.action === 'search' || args.action === 'read') {
        command = '/usr/local/bin/mail-search'; cli = [args.action];
        if (args.action !== 'folders') cli.push(args.folder ?? 'INBOX');
        if (args.action === 'search') cli.push('--criteria', args.criteria ?? 'ALL');
        if (args.action === 'read') { if (!args.references?.length) throw new Error('references required'); cli.push(...args.references); }
      } else {
        command = '/usr/local/bin/mail-send'; cli = [];
        if (args.action === 'inspect') { if (!args.requestId) throw new Error('requestId required'); cli.push('--inspect-action', args.requestId); }
        else {
          if (args.body === undefined) throw new Error('body required');
          if (!args.to?.length && !args.replyTo) throw new Error('to required unless replying (replyTo)');
          cli.push('--body-file', '/dev/stdin'); body = args.body;
          for (const to of args.to ?? []) cli.push('--to', to);
          for (const cc of args.cc ?? []) cli.push('--cc', cc);
          for (const path of args.attachments ?? []) cli.push('--attach', path);
          if (args.subject) cli.push('--subject', args.subject);
          if (args.from) cli.push('--from-addr', args.from);
          if (settings.kind === 'hosted') cli.push('--from-name', settings.fromName);
          if (args.replyTo) {
            const replyTo = args.replyTo.includes('/') ? args.replyTo : args.folder ? `${args.folder}/${args.replyTo}` : undefined;
            if (!replyTo) throw new Error('replyTo needs its folder: pass folder with the search reference, or replyTo as FOLDER/UIDVALIDITY:UID');
            cli.push('--reply-to', replyTo);
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
      const result = await ownerProcess(ctx.deps.placement, ctx.person, '/usr/bin/env', [...env, command, ...cli], body, signal, undefined, 90);
      let output = result.output.toString();
      if (result.exitCode === 0 && (args.action === 'folders' || args.action === 'search')) {
        const diagnostics = output.trim().split('\n').filter(line => line.startsWith('#'));
        const rows: ({ folder: string } | MailRow)[] = args.action === 'folders' ? output.trim().split('\n').filter(line => line && !line.startsWith('#')).map(folder => ({ folder })) : mailRows(output);
        const page = arrayPage(rows, args, JSON.stringify(['mail',ctx.person.id,args.action,args.folder ?? 'INBOX',args.criteria ?? 'ALL']), row => 'uid' in row ? String(9999999999-Number(row.uid)).padStart(10,'0') : row.folder);
        output = JSON.stringify({ ...page, ...(args.action === 'search' ? { window: 'Newest 400 matching UIDs (CLI search window); use tighter criteria for older mail.' } : {}), diagnostics });
      }
      if (result.exitCode === 0 && args.action === 'attachments') output = JSON.stringify({ saved: savedAttachments(output) });
      return processResult(result, output);
    },
  }) };
}

export const mailExtension = createMailExtension();
