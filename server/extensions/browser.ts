import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Extension, ToolContext } from '../types.js';
import { ownerProcess, processResult } from '../tools/owner.js';

/**
 * One agent's browser. Local: the person's configured agent-browser session driving the host's Chrome (egress Europe, a
 * datacenter IP). Kernel: a remote Kernel profile browser (US egress) that `start`/`attach` bound to this agent; every command goes
 * there until `stop`, and a Kernel session whose connection config is gone is a typed error, never a quiet return to local Chrome.
 */
export type BrowserRoute = { kind: 'local' } | { kind: 'kernel'; session: string; config: string };
export type BrowserRun = (ctx: ToolContext, executable: string, args: string[], signal: AbortSignal | undefined) => Promise<{ output: Buffer; exitCode: number }>;
export interface BrowserDeps { run: BrowserRun; kernelBrowser: string; kernelConfigDir(ctx: ToolContext): string; bindingDir(ctx: ToolContext): string }
interface LocalSettings { executable: string; executablePath: string; session: string }
type Binding = { session: string; profile: string | null; boundAt: number };

export class BrowserError extends Error {
  constructor(readonly code: 'browser_not_configured' | 'browser_args_required' | 'kernel_session_invalid' | 'kernel_session_ended' | 'kernel_output_invalid' | 'browser_target_unresolved', message: string) { super(`${code}: ${message}`); }
}

const kernelSession = (value: string) => {
  if (!/^[A-Za-z0-9]+$/.test(value)) throw new BrowserError('kernel_session_invalid', `"${value}" is not a Kernel session id`);
  return value;
};

async function localSettings(ctx: ToolContext): Promise<LocalSettings> {
  const path = ctx.person.extensionConfigPath;
  const settings = path ? JSON.parse(await readFile(path, 'utf8')).tools?.browser : undefined;
  if (typeof settings?.executable !== 'string' || typeof settings.executablePath !== 'string' || typeof settings.session !== 'string')
    throw new BrowserError('browser_not_configured', 'this account has no local browser (tools.browser executable, executablePath, session)');
  return settings;
}

async function readBinding(deps: BrowserDeps, ctx: ToolContext): Promise<Binding | null> {
  const text = await readFile(join(deps.bindingDir(ctx), `${ctx.agent.id}.json`), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return text === null ? null : JSON.parse(text) as Binding;
}
async function writeBinding(deps: BrowserDeps, ctx: ToolContext, binding: Binding | null): Promise<void> {
  const dir = deps.bindingDir(ctx), path = join(dir, `${ctx.agent.id}.json`);
  if (!binding) { await rm(path, { force: true }); return; }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(binding), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** The browser a command goes to: the session named in the call, else the agent's bound Kernel session, else local. */
export async function routeCommand(deps: BrowserDeps, ctx: ToolContext, named: string | undefined): Promise<BrowserRoute> {
  const bound = await readBinding(deps, ctx);
  const session = named ?? bound?.session;
  if (session === undefined) return { kind: 'local' };
  const config = join(deps.kernelConfigDir(ctx), `${kernelSession(session)}.json`);
  if (!await access(config).then(() => true, () => false))
    throw new BrowserError('kernel_session_ended', `Kernel session ${session} has no connection config (it was stopped, expired or reaped). Nothing ran, and no other browser was used. Start a new one with action=start, attach a live one with action=attach, or action=stop session=${session} to return to the local browser.`);
  return { kind: 'kernel', session, config };
}

export async function commandLine(ctx: ToolContext, route: BrowserRoute, args: string[]): Promise<{ executable: string; cli: string[] }> {
  const settings = await localSettings(ctx);
  switch (route.kind) {
    // No --config: agent-browser then reads the person's ~/.agent-browser/config.json, which declares the credential plugins `auth fill` resolves through.
    case 'local': return { executable: settings.executable, cli: ['--executable-path', settings.executablePath, '--session', settings.session, ...args] };
    // kernel-browser writes the person's defaults plus the CDP endpoint into this owner-only config.
    case 'kernel': return { executable: settings.executable, cli: ['--config', route.config, '--session', `kernel-${route.session}`, ...args] };
  }
}

const flagValue = (args: string[], flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

/** `auth fill`/`auth export` bind to a CDP target id; without --target the tool gives the active tab's, as every other command acts on it. */
async function withAuthTarget(deps: BrowserDeps, ctx: ToolContext, route: BrowserRoute, args: string[], signal: AbortSignal | undefined): Promise<string[]> {
  if (args[0] !== 'auth' || (args[1] !== 'fill' && args[1] !== 'export') || flagValue(args, '--target') !== undefined) return args;
  const line = await commandLine(ctx, route, ['--json', 'tab', 'list']);
  const listed = await deps.run(ctx, line.executable, line.cli, signal);
  const tabs = (() => { try { return JSON.parse(listed.output.toString()).data?.tabs as { active: boolean; targetId: string }[] | undefined; } catch { return undefined; } })();
  const active = tabs?.filter(tab => tab.active) ?? [];
  if (listed.exitCode || active.length !== 1) throw new BrowserError('browser_target_unresolved', `could not find the active tab to fill (${listed.output.toString().trim().slice(0, 300) || `exit ${listed.exitCode}`}); pass --target TARGET_ID from \`--json tab list\``);
  return [...args, '--target', active[0]!.targetId];
}

export async function runBrowser(deps: BrowserDeps, ctx: ToolContext, raw: { action: string; profile?: string; session?: string; args?: string[] }, signal: AbortSignal | undefined) {
  switch (raw.action) {
    case 'command': {
      if (!raw.args?.length) throw new BrowserError('browser_args_required', 'args required for browser command');
      const route = await routeCommand(deps, ctx, raw.session);
      const line = await commandLine(ctx, route, await withAuthTarget(deps, ctx, route, raw.args, signal));
      const result = await deps.run(ctx, line.executable, line.cli, signal);
      return { ...processResult(result), details: { exitCode: result.exitCode, browser: route.kind === 'kernel' ? `kernel:${route.session}` : 'local' } };
    }
    case 'start': case 'attach': {
      const target = raw.action === 'start' ? raw.profile : raw.session && kernelSession(raw.session);
      if (!target) throw new BrowserError('browser_args_required', raw.action === 'start' ? 'profile required' : 'session required');
      const result = await deps.run(ctx, deps.kernelBrowser, [raw.action, target], signal);
      if (result.exitCode) return processResult(result);
      const text = result.output.toString();
      const session = (() => { try { return (JSON.parse(text.trim().split('\n').at(-1)!) as { session_id?: unknown }).session_id; } catch { return undefined; } })();
      if (typeof session !== 'string') throw new BrowserError('kernel_output_invalid', `kernel-browser ${raw.action} printed no session id; the remote browser may exist: ${text.slice(0, 500)}`);
      const previous = await readBinding(deps, ctx);
      await writeBinding(deps, ctx, { session: kernelSession(session), profile: raw.action === 'start' ? target : previous?.session === session ? previous.profile : null, boundAt: ctx.deps.now() });
      const left = previous && previous.session !== session ? `\nKernel session ${previous.session} is still running; stop it with action=stop session=${previous.session} when done.` : '';
      return processResult(result, `${text}Browser commands from this agent now go to Kernel session ${session} until action=stop.${left}`);
    }
    case 'stop': {
      const bound = await readBinding(deps, ctx);
      const session = raw.session ? kernelSession(raw.session) : bound?.session;
      if (!session) throw new BrowserError('browser_args_required', 'session required (this agent has no bound Kernel session)');
      const config = join(deps.kernelConfigDir(ctx), `${session}.json`);
      if (await access(config).then(() => true, () => false)) {
        const line = await commandLine(ctx, { kind: 'kernel', session, config }, ['close']);
        await deps.run(ctx, line.executable, line.cli, signal);
      }
      const result = await deps.run(ctx, deps.kernelBrowser, ['stop', session], signal);
      if (bound?.session === session) await writeBinding(deps, ctx, null);
      const unbound = bound?.session === session ? '\nBrowser commands from this agent go to the local browser again.' : '';
      return processResult(result, `${result.output.toString()}${unbound}`);
    }
    default: throw new BrowserError('browser_args_required', `unknown action ${raw.action}`);
  }
}

const ownerRun: BrowserRun = (ctx, executable, args, signal) => ownerProcess(ctx.deps.placement, ctx.person, executable, args, undefined, signal, undefined, 240);

export function createBrowserExtension(deps: BrowserDeps): Extension {
  return { id: 'browser', name: 'Browser',
    promptSnippet: 'Browser: action=command runs agent-browser CLI args (open URL, snapshot -i, click, fill, keyboard type, tab list, screenshot). With no Kernel session it drives the host\'s local Chrome, which egresses from Europe on a datacenter IP: fine for reading, but payment pages, logins, Google and captcha-prone sites need a Kernel browser (US egress, saved profiles). action=start profile=NAME (see `kernel profiles list`) or action=attach session=ID binds a Kernel browser to you: every later command goes to it until action=stop; a command for a Kernel session that has ended is an error, never sent to local Chrome. Vault fills never put secrets in args: `auth fill --credential-provider proton-pass --item "EXACT Agent ITEM TITLE" --field email|username|password|totp|number|verification_number|expiration_date --selector CSS --frame main` (the tool adds the active tab as --target; a login item may keep its identifier in email or username).',
    tool: ctx => ({
      name: 'browser', files: 'writes', label: 'Browser', description: 'Operate a browser as the account owner: the local agent-browser session, or a Kernel profile browser started/attached by this agent (commands follow the bound Kernel session until stop).',
      parameters: Type.Object({ action: Type.Union(['start', 'attach', 'stop', 'command'].map(value => Type.Literal(value))), profile: Type.Optional(Type.String()), session: Type.Optional(Type.String({ description: 'Kernel session id (attach/stop; on command, sends it to that Kernel session)' })), args: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, raw: unknown, signal) => runBrowser(deps, ctx, raw as { action: string; profile?: string; session?: string; args?: string[] }, signal),
    }) };
}

export const browserExtension = createBrowserExtension({
  run: ownerRun,
  kernelBrowser: '/usr/local/bin/kernel-browser',
  kernelConfigDir: ctx => `/run/user/${ctx.person.uid}/kernel-browser`,
  bindingDir: ctx => join(ctx.deps.config.dataDir, 'browser-bindings', ctx.person.id),
});
