import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import type { PersonConfig } from '../config.js';
import type { Deps, Extension, ToolContext } from '../types.js';
import { ownerProcess, processResult } from '../tools/owner.js';
import { ownerFiles } from '../tools/file-helper.js';
import { outputPreview } from '../tools/output-preview.js';

/**
 * One agent's browser. Local: an agent-specific session driving its own host Chrome (a
 * datacenter IP). Cloud: a Browser Use Cloud browser (US residential egress, optional saved profile) that `start`/`attach` bound to this
 * agent through `cloud-browser`; every command goes there until `stop`, and a cloud session whose connection config is gone is a typed
 * error, never a quiet return to local Chrome.
 */
export type BrowserRoute = { kind: 'local' } | { kind: 'cloud'; session: string; config: string };
/** Who a browser call runs for: the agent's owner, the agent, and the channel's deps (a tool call, or the idle sweep). */
export interface Caller { person: PersonConfig; agentId: string; deps: Deps }
export type BrowserRun = (caller: Caller, executable: string, args: string[], signal: AbortSignal | undefined) => Promise<{ output: Buffer; exitCode: number }>;
export interface BrowserDeps { run: BrowserRun; cloudBrowser: string; /** Whether this host has the cloud-browser command; checked when the extension is created and on start/attach. Defaults to the file existing. */ cloudAvailable?: () => boolean; cloudConfigDir(person: PersonConfig): string; /** Bindings live in ROOT/PERSON/AGENT.json. */ bindingRoot(deps: Deps): string }
interface LocalSettings { executable: string; executablePath: string; session: string }
/**
 * An agent's bound cloud browser. live: commands go to it; it stops itself (with the profile save of action=stop) once idle
 * past the channel's limit, or past keepAliveMinutes when the agent asked for that. ended: the idle sweep stopped it, so a
 * command is the typed cloud_session_ended naming why, never a quiet switch to local Chrome, until the agent starts,
 * attaches or stops.
 */
type LiveBinding = { state: 'live'; session: string; profile: string | null; boundAt: number; lastUsedAt: number; keepAliveMinutes: number | null; stopFailures: number };
type EndedBinding = { state: 'ended'; session: string; profile: string | null; endedAt: number; reason: string };
type Binding = LiveBinding | EndedBinding;

export class BrowserError extends Error {
  constructor(readonly code: 'browser_not_configured' | 'browser_args_required' | 'browser_url_required' | 'browser_target_required' | 'browser_text_required' | 'browser_keepalive_invalid' | 'browser_output_limit_invalid' | 'cloud_session_invalid' | 'cloud_not_needed' | 'cloud_browser_unavailable' | 'cloud_session_ended' | 'cloud_output_invalid' | 'browser_binding_invalid' | 'cloud_upload_args' | 'cloud_upload_selector_ref' | 'cloud_upload_tab_unknown', message: string) { super(`${code}: ${message}`); }
}

/** Browser Use session ids are UUIDs; anything else (a Kernel id like b4x5pw9spz073cvfn5o3fgf2, a path) can't name one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cloudSession = (value: string) => {
  if (!UUID.test(value)) throw new BrowserError('cloud_session_invalid', `"${value}" is not a cloud browser session id (Browser Use session ids are UUIDs; see cloud-browser list)`);
  return value;
};

async function localSettings(person: PersonConfig): Promise<LocalSettings> {
  const path = person.extensionConfigPath;
  const settings = path ? JSON.parse(await readFile(path, 'utf8')).tools?.browser : undefined;
  if (typeof settings?.executable !== 'string' || typeof settings.executablePath !== 'string' || typeof settings.session !== 'string')
    throw new BrowserError('browser_not_configured', 'this account has no local browser (tools.browser executable, executablePath, session)');
  return settings;
}

const bindingPath = (deps: BrowserDeps, caller: Caller) => join(deps.bindingRoot(caller.deps), caller.person.id, `${caller.agentId}.json`);
const isString = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A binding file as written by this module; files from before the idle stop ({session, profile, boundAt}) were last used when bound.
 * foreign: its session id is not a Browser Use UUID (bindings left from the Kernel browsers, retired 2026-10-28, look like
 * b4x5pw9spz073cvfn5o3fgf2). Nothing in the stack can stop those and Kernel ended them at its own lifetime limit, so the
 * binding is dead: it is removed once, never sent to Browser Use.
 */
type ParsedBinding = Binding | { state: 'foreign'; session: string };
export function parseBinding(text: string, path: string): ParsedBinding {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const profile = raw.profile === null || raw.profile === 'none' ? null : isString(raw.profile) ? raw.profile : undefined;
  if (!isString(raw.session) || profile === undefined) throw new BrowserError('browser_binding_invalid', `${path} has no session/profile`);
  if (!UUID.test(raw.session)) return { state: 'foreign', session: raw.session };
  const session = raw.session;
  if (raw.state === undefined && isTime(raw.boundAt)) return { state: 'live', session, profile, boundAt: raw.boundAt, lastUsedAt: raw.boundAt, keepAliveMinutes: null, stopFailures: 0 };
  if (raw.state === 'live' && isTime(raw.boundAt) && isTime(raw.lastUsedAt) && (raw.keepAliveMinutes === null || isTime(raw.keepAliveMinutes)) && isTime(raw.stopFailures))
    return { state: 'live', session, profile, boundAt: raw.boundAt, lastUsedAt: raw.lastUsedAt, keepAliveMinutes: raw.keepAliveMinutes, stopFailures: raw.stopFailures };
  if (raw.state === 'ended' && isTime(raw.endedAt) && isString(raw.reason)) return { state: 'ended', session, profile, endedAt: raw.endedAt, reason: raw.reason };
  throw new BrowserError('browser_binding_invalid', `${path} is not a live or ended binding`);
}

/** The agent's binding; a foreign one is deleted here and named in `dropped`, so the sweep logs it once. */
async function loadBinding(deps: BrowserDeps, caller: Caller): Promise<{ binding: Binding | null; dropped: string | null }> {
  const path = bindingPath(deps, caller);
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) return { binding: null, dropped: null };
  const parsed = parseBinding(text, path);
  if (parsed.state !== 'foreign') return { binding: parsed, dropped: null };
  await rm(path, { force: true });
  return { binding: null, dropped: parsed.session };
}
const readBinding = async (deps: BrowserDeps, caller: Caller): Promise<Binding | null> => (await loadBinding(deps, caller)).binding;
async function writeBinding(deps: BrowserDeps, caller: Caller, binding: Binding | null): Promise<void> {
  const path = bindingPath(deps, caller), dir = dirname(path);
  if (!binding) { await rm(path, { force: true }); return; }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(binding), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** One browser operation per agent at a time: a command, start, attach or stop never overlaps the idle sweep stopping that agent's browser. */
const agentQueues = new Map<string, Promise<unknown>>();
export function withAgent<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const previous = agentQueues.get(agentId) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.then(() => undefined, () => undefined);
  agentQueues.set(agentId, tail);
  void tail.then(() => { if (agentQueues.get(agentId) === tail) agentQueues.delete(agentId); });
  return next;
}

/**
 * When a bound cloud browser stops itself. Browser Use bills residential proxy bandwidth while a page sits open (an idle
 * Amazon tab cost $14 in an hour on 2026-11-01), so an agent's browser lives only while the agent uses it: `idleMinutes`
 * after its last command, or `afterTurnMinutes` once the agent's turn has ended. keepAlive on start/attach replaces both.
 * Set per channel as `cloudBrowserIdleStop` in its config; left out, the household policy below.
 */
export interface IdleStop { idleMinutes: number; afterTurnMinutes: number }
export const HOUSEHOLD_IDLE_STOP: IdleStop = { idleMinutes: 5, afterTurnMinutes: 1 };
export const idleStopOf = (config: { cloudBrowserIdleStop?: IdleStop }): IdleStop => config.cloudBrowserIdleStop ?? HOUSEHOLD_IDLE_STOP;
export const MAX_KEEP_ALIVE_MINUTES = 45;

/** Why a live binding is due to stop now, or null while it may run on. */
export function idleStopReason(binding: LiveBinding, policy: IdleStop, now: number, turnRunning: boolean): string | null {
  const idle = now - binding.lastUsedAt, minutes = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;
  if (binding.keepAliveMinutes !== null) return idle >= binding.keepAliveMinutes * 60_000 ? `no browser command for ${minutes(idle)} (keepAlive ${binding.keepAliveMinutes} min)` : null;
  if (idle >= policy.idleMinutes * 60_000) return `no browser command for ${minutes(idle)} (idle limit ${policy.idleMinutes} min)`;
  if (!turnRunning && idle >= policy.afterTurnMinutes * 60_000) return `the agent's turn ended and no browser command came for ${minutes(idle)}`;
  return null;
}

export type BrowserArgs = { action: string; profile?: string; session?: string; keepAlive?: number; residential?: boolean; images?: boolean; args?: string[]; url?: string; target?: string; text?: string; path?: string; all?: boolean; outputLimit?: number };
/** The typed actions as the agent-browser command they run; a missing field is a typed error naming it. */
export function typedCommand(raw: BrowserArgs): string[] | null {
  const need = (field: 'url' | 'target' | 'text', what: string) => { const v = raw[field]; if (typeof v !== 'string' || !v) throw new BrowserError(`browser_${field}_required`, `${raw.action} needs ${field}: ${what}`); return v; };
  switch (raw.action) {
    case 'open': return ['open', need('url', 'the address to open')];
    case 'click': return ['click', need('target', 'a CSS selector or a snapshot ref like @e12')];
    case 'fill': return ['fill', need('target', 'a CSS selector or a snapshot ref like @e12'), need('text', 'what to type (secrets go through auth fill, never here)')];
    case 'snapshot': return raw.all ? ['snapshot'] : ['snapshot', '-i'];
    case 'screenshot': return raw.path ? ['screenshot', raw.path] : ['screenshot'];
    default: return null;
  }
}

/** The browser a command goes to: the session named in the call, else the agent's bound cloud browser session, else local. */
export async function routeCommand(deps: BrowserDeps, caller: Caller, named: string | undefined): Promise<BrowserRoute> {
  const bound = await readBinding(deps, caller);
  if (bound?.state === 'ended' && (named === undefined || named === bound.session))
    throw new BrowserError('cloud_session_ended', `cloud browser session ${bound.session} was stopped automatically at ${new Date(bound.endedAt).toISOString()}: ${bound.reason}. ${bound.profile ? `Its saved profile ${bound.profile} can be loaded again. ` : ''}Nothing ran, and no other browser was used. Start a new one with action=start profile=${bound.profile ?? 'none'} (keepAlive=MINUTES for a long interactive flow), or action=stop to return to the local browser.`);
  const session = named ?? bound?.session;
  if (session === undefined) return { kind: 'local' };
  const config = join(deps.cloudConfigDir(caller.person), `${cloudSession(session)}.json`);
  if (!await access(config).then(() => true, () => false))
    throw new BrowserError('cloud_session_ended', `cloud browser session ${session} has no connection config (it was stopped, expired or reaped). Nothing ran, and no other browser was used. Start a new one with action=start profile=none, attach a live one with action=attach, or action=stop session=${session} to return to the local browser.`);
  return { kind: 'cloud', session, config };
}

/** A browser daemon outlives its agent's turn and run, so every start tells it to exit after this long idle; the next command starts a fresh one. */
const idleTimeout = '10m'

export async function commandLine(person: PersonConfig, route: BrowserRoute, args: string[], agentId: string): Promise<{ executable: string; cli: string[] }> {
  const settings = await localSettings(person);
  switch (route.kind) {
    // No --config: agent-browser then reads the person's ~/.agent-browser/config.json, which declares the credential plugins `auth fill` resolves through.
    // The configured session is a channel prefix, not shared mutable tab/ref state. Encoding the full
    // identity keeps managers and workers distinct without lossy replacement or UUID truncation.
    case 'local': return { executable: settings.executable, cli: ['--executable-path', settings.executablePath, '--session', `${settings.session}-${Buffer.from(agentId).toString('base64url')}`, '--idle-timeout', idleTimeout, ...args] };
    // cloud-browser writes the person's defaults plus the CDP endpoint into this owner-only config.
    case 'cloud': return { executable: settings.executable, cli: ['--config', route.config, '--session', `cloud-${route.session}${agentId ? `-${agentId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 12)}` : ''}`, '--idle-timeout', idleTimeout, ...args] };
  }
}

/** The client owns the session-wide lock, so no daemon is disconnected before an active consumer can refuse a stop. */
async function stopCloud(deps: BrowserDeps, caller: Caller, session: string, signal: AbortSignal | undefined, idleBefore?: number) {
  return deps.run(caller, deps.cloudBrowser, ['stop', session, ...(idleBefore === undefined ? [] : ['--idle-before', String(idleBefore)])], signal);
}

const stopDeferred = (output: Buffer): boolean => {
  try { return JSON.parse(output.toString().trim().split('\n').at(-1)!).stopped === false; }
  catch { return false; }
};

/** Provider cost metadata is already minutes behind. Refresh it in the background, at most once a minute per
 * session; page commands use the last reading and never wait for a provider list request. */
const PROXY_WARN_USD = 1, PROXY_CHECK_MS = 60_000;
type ProxyReading = { at: number; usd: number | null; pending: boolean };
const proxyReadingsOf = new WeakMap<BrowserDeps, Map<string, ProxyReading>>();
function proxySpend(deps: BrowserDeps, caller: Caller, session: string): number | null {
  const proxyReadings = proxyReadingsOf.get(deps) ?? new Map<string, ProxyReading>();
  proxyReadingsOf.set(deps, proxyReadings);
  const now = caller.deps.now(), last = proxyReadings.get(session);
  if (last && (last.pending || now - last.at < PROXY_CHECK_MS)) return last.usd;
  const reading: ProxyReading = { at: now, usd: last?.usd ?? null, pending: true };
  proxyReadings.set(session, reading);
  void deps.run(caller, deps.cloudBrowser, ['list'], undefined).then(listed => {
    if (listed.exitCode !== 0) return;
    try {
      const found = (JSON.parse(listed.output.toString().trim().split('\n').at(-1)!) as { id?: unknown; proxyCost?: unknown }[]).find(b => b.id === session);
      const cost = Number(found?.proxyCost);
      if (found && typeof found.proxyCost === 'string' && Number.isFinite(cost)) reading.usd = cost;
    } catch { /* Keep the last successful reading when optional metadata is unavailable. */ }
  }, () => {}).finally(() => { reading.pending = false; });
  for (const [key, value] of proxyReadings) if (!value.pending && now - value.at > 6 * 60 * 60_000) proxyReadings.delete(key);
  return reading.usd;
}

const keepAliveOf = (raw: BrowserArgs): number | null => {
  if (raw.keepAlive === undefined) return null;
  if (!Number.isInteger(raw.keepAlive) || raw.keepAlive < 1 || raw.keepAlive > MAX_KEEP_ALIVE_MINUTES)
    throw new BrowserError('browser_keepalive_invalid', `keepAlive must be whole minutes from 1 to ${MAX_KEEP_ALIVE_MINUTES}`);
  return raw.keepAlive;
};

const DEFAULT_OUTPUT_LIMIT = 50 * 1024, MAX_OUTPUT_LIMIT = 2 * 1024 * 1024, MIN_OUTPUT_LIMIT = 1024;
const outputLimitOf = (raw: BrowserArgs): number => {
  const limit = raw.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_OUTPUT_LIMIT || limit > MAX_OUTPUT_LIMIT)
    throw new BrowserError('browser_output_limit_invalid', `outputLimit must be whole bytes from ${MIN_OUTPUT_LIMIT} to ${MAX_OUTPUT_LIMIT}`);
  return limit;
};

export async function runBrowser(deps: BrowserDeps, ctx: ToolContext, raw: BrowserArgs, signal: AbortSignal | undefined) {
  const limit = outputLimitOf(raw);
  const caller: Caller = { person: ctx.person, agentId: ctx.agent.id, deps: ctx.deps };
  const result = await withAgent(caller.agentId, () => runLocked(deps, caller, raw, signal));
  // Failures retain their complete diagnostic text; only successful browser text is bounded.
  if (result.isError) return result;
  const full = Buffer.from(result.content[0]!.text);
  if (full.length <= limit) return result;
  const path = join('/var/tmp', caller.person.unixUser, 'browser-output', `browser-${randomUUID()}.log`);
  const files = ownerFiles(caller.deps.placement, caller.person);
  await files.mkdir(dirname(path));
  await files.write(path, full);
  let totalLines = 1;
  for (const byte of full) if (byte === 10) totalLines++;
  const budget = limit - Buffer.byteLength(outputPreview(Buffer.alloc(0), Buffer.alloc(0), full.length, path, totalLines));
  const half = Math.floor(budget / 2);
  const text = outputPreview(full.subarray(0, half), full.subarray(full.length - (budget - half)), full.length, path, totalLines);
  return { ...result, content: [{ type: 'text' as const, text }], details: { ...result.details, truncated: true, fullOutputPath: path, outputBytes: full.length } };
}

async function runLocked(deps: BrowserDeps, caller: Caller, raw: BrowserArgs, signal: AbortSignal | undefined): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown>; isError: boolean }> {
  const typed = typedCommand(raw);
  if (typed) return runLocked(deps, caller, { action: 'command', session: raw.session, args: typed }, signal);
  const policy = idleStopOf(caller.deps.config);
  switch (raw.action) {
    case 'command': {
      if (!raw.args?.length) throw new BrowserError('browser_args_required', 'args required for browser command');
      const route = await routeCommand(deps, caller, raw.session);
      if (route.kind === 'cloud' && raw.args[0] === 'upload') return cloudUpload(deps, caller, route, raw.args.slice(1), signal);
      const line = await commandLine(caller.person, route, raw.args, caller.agentId);
      try {
        const spent = route.kind === 'cloud' ? proxySpend(deps, caller, route.session) : null;
        const result = await deps.run(caller, line.executable, line.cli, signal);
        // A provider may stop a browser before its timeout. Its CDP gateway then returns 502, not an expiry error.
        // Refresh only the connection metadata; never repeat a page operation or silently replace the browser.
        if (route.kind === 'cloud' && result.exitCode !== 0 && /CDP WebSocket connect failed:/.test(result.output.toString())) {
          const refreshed = await deps.run(caller, deps.cloudBrowser, ['attach', route.session], signal);
          const status = refreshed.output.toString();
          if (refreshed.exitCode !== 0 && /session_not_active:/.test(status)) {
            const bound = await readBinding(deps, caller);
            const reason = 'the browser provider ended the session';
            if (bound?.session === route.session) await writeBinding(deps, caller, { state: 'ended', session: route.session, profile: bound.profile, endedAt: caller.deps.now(), reason });
            await rm(route.config, { force: true });
            throw new BrowserError('cloud_session_ended', `cloud browser session ${route.session} has ended at the provider. Nothing ran, and no other browser was used. Start a new browser with action=start profile=${bound?.profile ?? 'none'}${bound?.profile ? ' to load its saved profile' : ''}. The previous open pages cannot be recovered.`);
          }
          // attach contains a private live-view URL on success: do not include its output in diagnostics.
          const recovery = refreshed.exitCode === 0
            ? 'The session is still active and its connection configuration was refreshed. No page operation was repeated; the next command will reconnect to the same browser.'
            : 'The provider status could not be read. No page operation was repeated and no other browser was used.';
          return { ...processResult(result, `${result.output.toString()}\n${recovery}`), details: { exitCode: result.exitCode, browser: `cloud:${route.session}` } };
        }
        const warning = route.kind === 'cloud' && spent !== null && spent >= PROXY_WARN_USD ? `\ncloud browser session ${route.session} has used $${spent.toFixed(2)} of residential proxy bandwidth so far; an open page keeps using it, so action=stop the moment you are done.` : '';
        return { ...processResult(result, `${result.output.toString()}${warning}`), details: { exitCode: result.exitCode, browser: route.kind === 'cloud' ? `cloud:${route.session}` : 'local', ...(spent === null ? {} : { proxyUsd: spent }) } };
      } finally {
        const bound = route.kind === 'cloud' ? await readBinding(deps, caller) : null;
        if (bound?.state === 'live' && route.kind === 'cloud' && bound.session === route.session) await writeBinding(deps, caller, { ...bound, lastUsedAt: caller.deps.now() });
      }
    }
    case 'start': case 'attach': {
      if (!cloudAvailable(deps)) throw new BrowserError('cloud_browser_unavailable', `this host has no cloud browser (${deps.cloudBrowser} is not installed); only the local browser works here. Nothing was started.`);
      const target = raw.action === 'start' ? raw.profile : raw.session && cloudSession(raw.session);
      if (!target) throw new BrowserError('browser_args_required', raw.action === 'start' ? 'profile required' : 'session required');
      const keepAlive = keepAliveOf(raw);
      // A throwaway browser has no login to keep, so it only reads: the local browser reads for free, residential bandwidth is paid per GB.
      if (raw.action === 'start' && target === 'none' && !raw.residential) throw new BrowserError('cloud_not_needed', 'a cloud browser with profile none has no saved login, so it is only for reading, and reading is free on the local browser (the default while no cloud browser is bound): just use open/snapshot. Start one with a profile NAME to use a saved login or pay, or pass residential=true for a site that refuses datacenter addresses. Nothing was started.');
      const result = await deps.run(caller, deps.cloudBrowser, [raw.action, target, ...(keepAlive === null ? [] : ['--keep-alive', String(keepAlive)]), ...(raw.action === 'start' && raw.images ? ['--images'] : [])], signal);
      if (result.exitCode) return processResult(result);
      const text = result.output.toString();
      const session = (() => { try { return (JSON.parse(text.trim().split('\n').at(-1)!) as { session_id?: unknown }).session_id; } catch { return undefined; } })();
      if (typeof session !== 'string') throw new BrowserError('cloud_output_invalid', `cloud-browser ${raw.action} printed no session id; the remote browser may exist: ${text.slice(0, 500)}`);
      const previous = await readBinding(deps, caller), now = caller.deps.now();
      await writeBinding(deps, caller, { state: 'live', session: cloudSession(session), profile: raw.action === 'start' ? target === 'none' ? null : target : previous?.session === session ? previous.profile : null, boundAt: now, lastUsedAt: now, keepAliveMinutes: keepAlive, stopFailures: 0 });
      const left = previous?.state === 'live' && previous.session !== session ? `\ncloud browser session ${previous.session} is still running; stop it with action=stop session=${previous.session} when done.` : '';
      const life = keepAlive === null
        ? `It stops itself (profile saved) once all consumers are idle: ${policy.idleMinutes} min without commands, or ${policy.afterTurnMinutes} min after each bound agent ends its turn; still stop it yourself the moment you are done.`
        : `It stops itself (profile saved) once all consumers are idle; your keepAlive is ${keepAlive} min without commands; stop it yourself the moment you are done.`;
      return processResult(result, `${text}Browser commands from this agent now go to cloud browser session ${session} until action=stop. ${life}${left}`);
    }
    case 'stop': {
      const bound = await readBinding(deps, caller);
      const session = raw.session ? cloudSession(raw.session) : bound?.session;
      if (!session) throw new BrowserError('browser_args_required', 'session required (this agent has no bound cloud browser session)');
      if (bound?.state === 'ended' && bound.session === session) {
        await writeBinding(deps, caller, null);
        return processResult({ output: Buffer.from(''), exitCode: 0 }, `cloud browser session ${session} had already stopped (${bound.reason}).\nBrowser commands from this agent go to the local browser again.`);
      }
      const result = await stopCloud(deps, caller, session, signal);
      if (result.exitCode === 0 && stopDeferred(result.output)) return processResult(result, `${result.output.toString()}\nThe browser is still in use; its binding and connection config were kept.`);
      if (result.exitCode === 0 && bound?.session === session) await writeBinding(deps, caller, null);
      const unbound = result.exitCode === 0 && bound?.session === session ? '\nBrowser commands from this agent go to the local browser again.' : '';
      return processResult(result, `${result.output.toString()}${unbound}`);
    }
    default: throw new BrowserError('browser_args_required', `unknown action ${raw.action}`);
  }
}

/**
 * Browser Use refuses DOM.setFileInputFiles for files outside its own downloads directory, so agent-browser's upload fails
 * on a cloud browser. cloud-browser upload streams the local bytes into the input instead, on the tab this agent's
 * agent-browser session has active, and dispatches input/change once. It takes one file and a CSS selector.
 */
async function cloudUpload(deps: BrowserDeps, caller: Caller, route: Extract<BrowserRoute, { kind: 'cloud' }>, args: string[], signal: AbortSignal | undefined) {
  const [selector, ...files] = args;
  if (!selector || files.length !== 1)
    throw new BrowserError('cloud_upload_args', 'upload on a cloud browser takes exactly one selector and one file: args ["upload", "CSS selector", "/path/to/file"]; upload several files one input at a time');
  if (selector.startsWith('@'))
    throw new BrowserError('cloud_upload_selector_ref', `upload on a cloud browser needs a CSS selector for the file input, not the snapshot ref ${selector}; nothing was uploaded`);
  const tabs = await commandLine(caller.person, route, ['tab', '--json'], caller.agentId);
  const listed = await deps.run(caller, tabs.executable, tabs.cli, signal);
  if (listed.exitCode !== 0) return processResult(listed, `${listed.output.toString()}\nThe active tab could not be read; nothing was uploaded.`);
  const active = (() => {
    try {
      const reply = JSON.parse(listed.output.toString().trim().split('\n').at(-1)!) as { data?: { tabs?: { active?: unknown; targetId?: unknown }[] } };
      const found = reply.data?.tabs?.filter(tab => tab.active === true) ?? [];
      return found.length === 1 && typeof found[0]!.targetId === 'string' ? found[0]!.targetId : null;
    } catch { return null; }
  })();
  if (active === null) throw new BrowserError('cloud_upload_tab_unknown', 'agent-browser did not report exactly one active tab; nothing was uploaded. Select the tab with args ["tab", "N"] and retry');
  const result = await deps.run(caller, deps.cloudBrowser, ['upload', route.session, files[0]!, '--selector', selector, '--target', active], signal);
  const bound = await readBinding(deps, caller);
  if (bound?.state === 'live' && bound.session === route.session) await writeBinding(deps, caller, { ...bound, lastUsedAt: caller.deps.now() });
  return { ...processResult(result), details: { exitCode: result.exitCode, browser: `cloud:${route.session}` } };
}

export type SweepOutcome = { person: string; agent: string; session: string } & ({ kind: 'stopped'; reason: string } | { kind: 'stop_failed'; attempt: number; output: string } | { kind: 'stop_refused'; output: string } | { kind: 'dropped' } | { kind: 'invalid'; error: string });

/**
 * A stop Browser Use (or the broker) refuses for this session itself: no such session (404/410), an id it can't parse (400/422),
 * or a session the broker records as someone else's (403 denied). Asking again gets the same answer, so it is never retried.
 * Anything else (broker unreachable, 401, 429, 5xx) may pass and is retried.
 */
export const permanentStopRefusal = (output: string): boolean =>
  /\bhttp_(400|404|410|422)\b/.test(output) || /\bhttp_403\b.*denied: that browser session is not yours/.test(output);

/**
 * Stops every bound cloud browser of this channel that is due (idleStopReason), the way action=stop does. Bindings are
 * files, so this also catches browsers left bound across a restart. A failed stop is retried on the next sweeps and remains eligible for cleanup so a billable browser is never abandoned.
 * A permanent refusal (permanentStopRefusal) ends the binding at once, and a foreign binding is removed: one outcome each.
 */
const reportedInvalid = new Set<string>();
export async function sweepIdle(deps: BrowserDeps, server: Deps): Promise<SweepOutcome[]> {
  const root = deps.bindingRoot(server), policy = idleStopOf(server.config);
  const outcomes: SweepOutcome[] = [];
  // Include CLI-only browsers too. Their consumers use the ordinary idle limit, not another agent's turn-end limit.
  await Promise.all(server.config.people.map(async person => {
    const bindingFiles = await readdir(join(root, person.id)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const groups = new Map<string, { caller: Caller; bound: LiveBinding }[]>();
    for (const file of bindingFiles.filter(f => f.endsWith('.json'))) {
      const caller: Caller = { person, agentId: file.slice(0, -5), deps: server };
      await withAgent(caller.agentId, async () => {
        try {
          const loaded = await loadBinding(deps, caller);
          if (loaded.dropped !== null) outcomes.push({ kind: 'dropped', person: person.id, agent: caller.agentId, session: loaded.dropped });
          if (loaded.binding?.state !== 'live') return;
          const bound = loaded.binding;
          groups.set(bound.session, [...(groups.get(bound.session) ?? []), { caller, bound }]);
        } catch (error) {
          const key = `${person.id}/${caller.agentId}: ${error}`;
          if (!reportedInvalid.has(key)) outcomes.push({ kind: 'invalid', person: person.id, agent: caller.agentId, session: '', error: String(error) });
          reportedInvalid.add(key);
        }
      });
    }
    const configDir = deps.cloudConfigDir(person);
    for (const file of await readdir(configDir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
      const session = file.replace(/\.json$/, '');
      if (file.endsWith('.json') && UUID.test(session) && !groups.has(session)) groups.set(session, []);
    }
    await Promise.all([...groups].map(async ([session, bindings]) => {
      const now = server.now(), config = join(configDir, `${session}.json`);
      const fallback: Caller = { person, agentId: server.runtime.managerFor(person.id) ?? `manager:${person.id}`, deps: server };
      const caller = bindings[0]?.caller ?? fallback;
      const where = { person: person.id, agent: caller.agentId, session };
      try {
        const records = new Map<string, { lastUsedAt: number; keepAliveMinutes: number | null }>();
        const activityDir = join(configDir, `${session}.activity`);
        for (const file of await readdir(activityDir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
          if (!file.endsWith('.json')) continue;
          const record = JSON.parse(await readFile(join(activityDir, file), 'utf8')) as { agentId?: unknown; lastUsedAt?: unknown; keepAliveMinutes?: unknown };
          if (!isTime(record.lastUsedAt) || !(record.agentId === null || isString(record.agentId)) || !(record.keepAliveMinutes === undefined || record.keepAliveMinutes === null || isTime(record.keepAliveMinutes))) throw new Error(`invalid browser activity record ${file}`);
          records.set(record.agentId ?? `shell:${file}`, { lastUsedAt: record.lastUsedAt, keepAliveMinutes: typeof record.keepAliveMinutes === 'number' ? record.keepAliveMinutes : null });
        }
        const reasons: string[] = [];
        for (const { caller: owner, bound } of bindings) {
          const record = records.get(owner.agentId);
          const reason = idleStopReason({ ...bound, lastUsedAt: Math.max(bound.lastUsedAt, record?.lastUsedAt ?? 0), keepAliveMinutes: record?.keepAliveMinutes ?? bound.keepAliveMinutes }, policy, now, server.runtime.turnOf(owner.agentId) !== null);
          if (reason === null) return;
          reasons.push(reason);
          records.delete(owner.agentId);
        }
        for (const record of records.values()) {
          const limit = record.keepAliveMinutes ?? policy.idleMinutes;
          if (now - record.lastUsedAt < limit * 60_000) return;
        }
        if (!bindings.length && !records.size) {
          const modifiedAt = await stat(config).then(s => s.mtimeMs, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
          if (now - modifiedAt < policy.idleMinutes * 60_000) return;
        }
        const reason = reasons[0] ?? `no browser consumer used this session within its idle limit`;
        // The exclusive client lock also catches a CLI command starting after the records were read.
        const result = await stopCloud(deps, caller, session, undefined, now);
        if (result.exitCode === 0 && stopDeferred(result.output)) return;
        if (result.exitCode === 0 || permanentStopRefusal(result.output.toString())) {
          for (const { caller: owner, bound } of bindings) await withAgent(owner.agentId, async () => {
            const current = await readBinding(deps, owner);
            if (current?.state === 'live' && current.session === session) await writeBinding(deps, owner, { state: 'ended', session, profile: bound.profile, endedAt: now, reason: `${reason}; ${result.exitCode === 0 ? costLine(result.output.toString()) : `Browser Use refused to stop it (${result.output.toString().slice(0, 300)})`}` });
          });
          outcomes.push(result.exitCode === 0 ? { kind: 'stopped', ...where, reason } : { kind: 'stop_refused', ...where, output: result.output.toString().slice(0, 300) });
        } else {
          // Keep failed stops eligible for the next sweep; never abandon a billable browser after three failures.
          const attempt = Math.max(0, ...bindings.map(({ bound }) => bound.stopFailures)) + 1;
          for (const { caller: owner } of bindings) await withAgent(owner.agentId, async () => {
            const current = await readBinding(deps, owner);
            if (current?.state === 'live' && current.session === session) await writeBinding(deps, owner, { ...current, stopFailures: attempt });
          });
          outcomes.push({ kind: 'stop_failed', ...where, attempt, output: result.output.toString().slice(0, 300) });
        }
      } catch (error) {
        outcomes.push({ kind: 'invalid', ...where, error: String(error) });
      }
    }));
  }));
  return outcomes;
}

/** What `cloud-browser stop` said the session cost so far (Browser Use settles proxy bandwidth a little after the stop). */
function costLine(output: string): string {
  try {
    const stopped = JSON.parse(output.trim().split('\n').at(-1)!) as { browserCost?: unknown; proxyCost?: unknown; startedAt?: unknown; finishedAt?: unknown };
    const usd = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? `$${Number(v).toFixed(2)}` : 'unknown';
    return `stopped with browser ${usd(stopped.browserCost)}, proxy ${usd(stopped.proxyCost)} reported so far`;
  } catch { return 'stopped'; }
}

/** Preserve why the runner stopped; a killed client says nothing about an already-dispatched browser action. */
export function browserProcessResult(result: Awaited<ReturnType<typeof ownerProcess>>) {
  if (result.termination !== 'timeout' && result.termination !== 'cancelled') return result;
  const timedOut = result.termination === 'timeout';
  const message = `${timedOut ? 'browser_command_timeout: the browser command exceeded its 240-second deadline' : 'browser_command_cancelled: the browser command was cancelled'}. The client was stopped, but the browser action may already have happened. No action was repeated. Inspect the same browser before deciding whether to retry; do not repeat a payment, submission or other input just because this command failed.`;
  return { ...result, exitCode: timedOut ? 124 : 130, output: Buffer.concat([result.output, Buffer.from(`\n${message}\n`)]) };
}

// The agent id names its cloud-browser consumer record, so keepAlive and idle stop apply per agent.
const ownerRun: BrowserRun = async (caller, executable, args, signal) => browserProcessResult(await ownerProcess(caller.deps.placement, caller.person, executable, args, undefined, signal, undefined, 240, undefined, caller.agentId));

const cloudAvailable = (deps: BrowserDeps) => (deps.cloudAvailable ?? (() => existsSync(deps.cloudBrowser)))();
const VAULT_SNIPPET = ' Vault fills never put secrets in args: `auth fill --credential-provider proton-pass --item "EXACT Agent ITEM TITLE" --field email|username|password|totp|number|verification_number|expiration_date --selector CSS`. It fills in the active tab; for a login inside an iframe, run `frame SELECTOR` first and the fill goes into that frame. A login item may keep its identifier in email or username.';
const TYPED = 'Browser: open (url), click (target), fill (target, text), snapshot (interactive elements with @refs; all: true for everything) and screenshot (optional path) are typed actions; action=command runs any other agent-browser CLI args (keyboard type, tab list, frame…).';
const CLOUD_SNIPPET = TYPED + ' With no cloud browser session it drives the host\'s local Chrome, which egresses from a datacenter IP: fine for reading, but payment pages, logins, Google and captcha-prone sites need a cloud browser (Browser Use Cloud: US residential egress, saved profiles that keep logins, about $0.02/h plus residential bandwidth at about $5 per GB, which an open page keeps using: an idle Amazon tab cost $14 in an hour). Cloud browsers block images, video and fonts (start images=true only for a captcha or ID check); a cloud browser with no profile is refused unless residential=true, because reading belongs on the free local browser. action=start profile=NAME (`cloud-browser profiles`; personal-profile holds Alice\'s logins) or action=attach session=ID binds a cloud browser to you: every later command goes to it until action=stop, which saves the profile. Stop it as soon as you are done. Sharing a cloud config registers each CLI consumer automatically. Cleanup waits for all consumers to be idle and never stops an active command. Left idle it stops itself, profile saved: after 5 minutes without a browser command, or 1 minute after each bound agent ends its turn; for a long interactive flow (a person signing in through the live view) start or attach with keepAlive=MINUTES instead. A command for a cloud browser session that has ended is an error naming why, never sent to local Chrome. On a cloud browser, command upload takes a CSS selector and one file (args ["upload", SELECTOR, PATH]) and streams it into that input on the active tab.' + VAULT_SNIPPET;
/** Hosts without cloud-browser must not advertise a cloud route they can't start. */
const LOCAL_SNIPPET = TYPED + ' It drives the host\'s local Chrome, which egresses from a datacenter IP: fine for reading, but Google sign-in and captcha-prone sites will challenge it. This host has no cloud browser (cloud-browser is not installed), so action=start and action=attach are refused; a login that needs residential egress has to be done on a host that has one.' + VAULT_SNIPPET;

/** How often the channel looks for idle cloud browsers, and how long after start it first looks (the runtime resumes interrupted turns first). */
const SWEEP_EVERY_MS = 30_000, FIRST_SWEEP_MS = 90_000;

export function createBrowserExtension(deps: BrowserDeps): Extension {
  let timer: ReturnType<typeof setTimeout> | undefined, sweeping: Promise<void> | null = null;
  const sweep = (server: Deps) => {
    sweeping ??= sweepIdle(deps, server).then(async outcomes => {
      for (const outcome of outcomes) {
        console.log(JSON.stringify({ type: 'cloud_browser_idle_sweep', ...outcome }));
        if (outcome.kind !== 'stopped' && outcome.kind !== 'dropped') await server.store.logError('browser', `cloud_browser_idle_${outcome.kind}: ${JSON.stringify(outcome)}`).catch(() => {});
      }
    }, async (error: unknown) => {
      console.error(JSON.stringify({ type: 'cloud_browser_idle_sweep_failed', error: String(error) }));
      await server.store.logError('browser', `cloud_browser_idle_sweep_failed: ${error}`).catch(() => {});
    }).finally(() => { sweeping = null; });
  };
  return { id: 'browser', name: 'Browser',
    promptSnippet: cloudAvailable(deps) ? CLOUD_SNIPPET : LOCAL_SNIPPET,
    start: async server => {
      if (!cloudAvailable(deps)) return;
      const tick = () => { sweep(server); timer = setTimeout(tick, SWEEP_EVERY_MS); timer.unref(); };
      timer = setTimeout(tick, FIRST_SWEEP_MS); timer.unref();
    },
    stop: async () => { if (timer) clearTimeout(timer); timer = undefined; await sweeping; },
    tool: ctx => ({
      name: 'browser', files: 'writes', records: 'none', label: 'Browser', description: cloudAvailable(deps) ? 'Operate a browser as the account owner: the local agent-browser session, or a Browser Use Cloud browser started/attached by this agent (commands follow the bound cloud browser session until stop; an idle one stops itself).' : 'Operate the local browser as the account owner (agent-browser). This host has no cloud browser, so start and attach are refused.',
      parameters: Type.Object({ action: Type.Union(['open', 'click', 'fill', 'snapshot', 'screenshot', 'command', 'start', 'attach', 'stop'].map(value => Type.Literal(value))), url: Type.Optional(Type.String({ description: 'open: the address' })), target: Type.Optional(Type.String({ description: 'click/fill: a CSS selector or a snapshot ref like @e12' })), text: Type.Optional(Type.String({ description: 'fill: non-secret text, including email and shipping address; secrets use auth fill from the vault' })), all: Type.Optional(Type.Boolean({ description: 'snapshot: the whole tree, not only interactive elements' })), path: Type.Optional(Type.String({ description: 'screenshot: where to save it' })), profile: Type.Optional(Type.String()), session: Type.Optional(Type.String({ description: 'cloud browser session id (attach/stop; on other actions, sends them to that cloud browser session)' })), residential: Type.Optional(Type.Boolean({ description: 'start with profile none: allow a login-free cloud browser (otherwise refused: reading uses the free local browser)' })), images: Type.Optional(Type.Boolean({ description: 'start: load images, video and fonts (blocked by default to save proxy bandwidth); only for captchas, ID checks and pages unusable without pictures' })), keepAlive: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_KEEP_ALIVE_MINUTES, description: 'start/attach: minutes without a command before the cloud browser stops itself, for a long interactive flow; replaces the 5-minute idle and end-of-turn stops' })), args: Type.Optional(Type.Array(Type.String({ description: 'command: raw agent-browser arguments' }))), outputLimit: Type.Optional(Type.Integer({ minimum: MIN_OUTPUT_LIMIT, maximum: MAX_OUTPUT_LIMIT, description: 'Successful text output limit in bytes (default 50 KiB, maximum 2 MiB); larger output keeps first/last context and saves the complete text to a readable file' })) }),
      execute: async (_id, raw: unknown, signal) => runBrowser(deps, ctx, raw as BrowserArgs, signal),
    }) };
}

export const browserExtension = createBrowserExtension({
  run: ownerRun,
  cloudBrowser: '/usr/local/bin/cloud-browser',
  cloudConfigDir: person => `/run/user/${person.uid}/cloud-browser`,
  bindingRoot: server => join(server.config.dataDir, 'browser-bindings'),
});
