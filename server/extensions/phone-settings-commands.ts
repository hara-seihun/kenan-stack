// Commands use the native app's authenticated notification stream, never a debug connection.
// The shared files also let phonectl and agents on either channel use the same phone.
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { appendFile, chown, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonConfig } from '../config.js';
import { onSettingsPhone, phoneSettingsConnected } from '../notifications.js';
import type { Deps } from '../types.js';

export type SettingsArgs = { action: string; [key: string]: unknown };
export type SettingsOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string; undo?: SettingsArgs; value?: unknown } };
type Request = { id: string; at: number; args: SettingsArgs };
type Person = Pick<PersonConfig, 'id' | 'home' | 'uid' | 'gid'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const refusal = (code: string, message: string): SettingsOutcome => ({ ok: false, error: { code, message } });
export const settingsDir = (p: Pick<PersonConfig, 'home'>) => join(p.home, '.local/share/kenan/phone-settings');
const file = (p: Person, ...parts: string[]) => join(settingsDir(p), ...parts);
const logFile = (p: Person) => p.id === 'alice' ? join(p.home, 'example-data/phone/oneplus-15r.jsonl') : file(p, 'changes.jsonl');
const MUTATIONS = new Set(['set', 'remove', 'disable', 'appop', 'grant', 'unrestrict', 'start', 'end', 'tap', 'tap_text']);
const LOCAL = new Set(['log', 'note', 'shell', 'read']);
const COMMANDS = new Set(['status', 'packages', 'get', ...MUTATIONS, 'ui', 'screenshot', 'shell', 'read']);

async function ownedDir(p: Person, dir: string) { await mkdir(dir, { recursive: true, mode: 0o700 }); await chown(dir, p.uid, p.gid); }
export async function settingsDirs(p: Person) { for (const d of ['outbox', 'claimed', 'results', 'answers', 'shots']) await ownedDir(p, file(p, d)); }
async function writeOwned(p: Person, path: string, data: string | Buffer) {
  const temp = join(path, '..', `.${randomUUID()}.tmp`);
  await writeFile(temp, data, { mode: 0o600 }); await chown(temp, p.uid, p.gid); await rename(temp, path);
}
async function readJson<T>(path: string): Promise<T | null> { return readFile(path, 'utf8').then(s => JSON.parse(s) as T, e => { if (absent(e)) return null; throw e; }); }
async function remove(path: string) { await unlink(path).catch(e => { if (!absent(e)) throw e; }); }
async function log(p: Person, entry: Record<string, unknown>) {
  await ownedDir(p, join(logFile(p), '..'));
  await appendFile(logFile(p), JSON.stringify(entry) + '\n', { mode: 0o600 }); await chown(logFile(p), p.uid, p.gid);
}
async function history(p: Person): Promise<Record<string, unknown>[]> {
  const text = await readFile(logFile(p), 'utf8').catch(e => { if (absent(e)) return ''; throw e; });
  return text.trim().split('\n').filter(Boolean).map(s => JSON.parse(s) as Record<string, unknown>);
}
export function waitSettingsFile(path: string, timeout: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (found: boolean, error?: unknown) => {
      if (settled) return; settled = true; watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(found);
    };
    const check = () => void stat(path).then(() => finish(true), e => { if (!absent(e)) finish(false, e); });
    const abort = () => finish(false, new Error('Phone command cancelled; an already delivered command may have run'));
    const watcher = watch(join(path, '..'), () => check());
    const timer = setTimeout(() => finish(false), timeout);
    signal?.addEventListener('abort', abort); if (signal?.aborted) abort(); else check();
  });
}

/** A command is never replayed on reconnect or timeout. The log retains uncertain mutations. */
export async function requestSettings(p: Person, args: SettingsArgs, now: number, signal?: AbortSignal): Promise<SettingsOutcome> {
  await settingsDirs(p);
  const id = randomUUID(), name = `${id}.json`, outbox = file(p, 'outbox', name), result = file(p, 'results', name);
  await writeOwned(p, outbox, JSON.stringify({ id, at: now, args }));
  try {
    if (!await waitSettingsFile(result, 5_000, signal)) {
      const unclaimed = await unlink(outbox).then(() => true, e => { if (absent(e)) return false; throw e; });
      if (unclaimed) return refusal('phone_not_connected', 'No connected Kenan app claimed this command. The app works over cellular and Wi-Fi without debugging.');
      if (!await waitSettingsFile(result, 33_000, signal)) return refusal('phone_timeout', `The app command did not finish. Check log for ${id} before making a new attempt; it may have run.`);
    }
    const answer = (await readJson<SettingsOutcome>(result))!; await remove(result); return answer;
  } finally { await remove(outbox); }
}

/** Only accepts a response to a request this person's server actually sent to the app. */
export async function receiveSettingsResult(p: Person, raw: unknown): Promise<SettingsOutcome> {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== 'string' || !UUID.test(r.id)) return refusal('invalid_input', 'id: the pending command id');
  const request = await readJson<Request>(file(p, 'claimed', `${r.id}.json`));
  if (!request || LOCAL.has(request.args.action)) return refusal('not_found', 'No pending app command with this id');
  let answer: SettingsOutcome;
  if (r.ok === true && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) answer = { ok: true, value: r.value as Record<string, unknown> };
  else if (r.ok === false && r.error && typeof (r.error as { code?: unknown }).code === 'string' && typeof (r.error as { message?: unknown }).message === 'string') {
    const e = r.error as { code: string; message: string; undo?: SettingsArgs; value?: unknown };
    answer = { ok: false, error: { code: e.code.slice(0, 100), message: e.message.slice(0, 2000),
      ...(e.undo && typeof e.undo === 'object' && COMMANDS.has(e.undo.action) ? { undo: e.undo } : {}),
      ...('value' in e ? { value: e.value } : {}),
    } };
  } else return refusal('invalid_input', 'Expected ok/value or error with code and message');
  await writeOwned(p, file(p, 'answers', `${r.id}.json`), JSON.stringify(answer));
  return { ok: true, value: {} };
}

type Sender = (request: Request) => Promise<SettingsOutcome>;
export async function performSettings(p: Person, request: Request, send: Sender): Promise<SettingsOutcome> {
  const { args, id, at } = request;
  if (args.action === 'log') return { ok: true, value: { entries: (await history(p)).slice(-Number(args.limit ?? 50)) } };
  if (args.action === 'note') {
    if (typeof args.text !== 'string' || !args.text) return refusal('invalid_input', 'note needs text');
    let undo: SettingsArgs | undefined;
    if (args.undo !== undefined) {
      try { undo = JSON.parse(String(args.undo)) as SettingsArgs; } catch { return refusal('invalid_input', 'undo must be a JSON app command, not a shell command'); }
      if (!undo || typeof undo.action !== 'string' || !COMMANDS.has(undo.action)) return refusal('invalid_input', 'undo must be a supported app command');
    }
    await log(p, { id, at, state: 'succeeded', args, ...(undo ? { undo } : {}) });
    return { ok: true, value: { id, note: args.text } };
  }
  if (args.action === 'undo') {
    if (!Array.isArray(args.ids) || !args.ids.length || !args.ids.every(i => typeof i === 'string')) return refusal('invalid_input', 'undo needs ids');
    const entries = await history(p), outcomes: { id: string; outcome: SettingsOutcome }[] = [];
    for (const target of args.ids as string[]) {
      const entry = entries.findLast(e => e.id === target);
      const undo = entry?.undo as SettingsArgs | undefined;
      if (!entry || !['succeeded', 'failed'].includes(String(entry.state)) || !undo || typeof undo !== 'object' || !COMMANDS.has(undo.action)) {
        outcomes.push({ id: target, outcome: refusal('undo_unavailable', 'This entry has no app command to undo it. Historical shell commands cannot run through the app.') }); continue;
      }
      if (entries.some(e => e.undoOf === target && e.state === 'succeeded')) {
        outcomes.push({ id: target, outcome: refusal('already_undone', 'This change was already undone') }); continue;
      }
      const undoId = randomUUID();
      // Dispatch as another claimed request so the app reply remains tied to its owner and command.
      const child: Request = { id: undoId, at: Date.now(), args: undo };
      await writeOwned(p, file(p, 'claimed', `${undoId}.json`), JSON.stringify(child));
      const outcome = await performSettings(p, child, send);
      await remove(file(p, 'claimed', `${undoId}.json`));
      await log(p, { id: undoId, at: Date.now(), undoOf: target, state: outcome.ok ? 'succeeded' : 'failed' });
      entries.push({ undoOf: target, state: outcome.ok ? 'succeeded' : 'failed' });
      outcomes.push({ id: target, outcome });
    }
    return outcomes.every(o => o.outcome.ok) ? { ok: true, value: { outcomes } } : { ok: false, error: { code: 'undo_failed', message: JSON.stringify(outcomes) } };
  }
  if (!COMMANDS.has(args.action)) return refusal('invalid_input', `Unknown phone action ${args.action}`);
  if (args.action === 'shell' || args.action === 'read') return refusal('android_privilege_required', 'The app cannot run commands as Android shell or read privileged system data. Use a supported app action. Debugging is never requested.');
  const mutation = MUTATIONS.has(args.action);
  if (mutation) await log(p, { id, at, args, state: 'requested' });
  let result: SettingsOutcome;
  try { result = await send(request); }
  catch (e) { result = refusal('phone_outcome_unknown', String(e)); }
  if (result.ok && args.action === 'screenshot') {
    const image = result.value.image as { mime?: unknown; base64?: unknown } | undefined;
    if (!image || (image.mime !== 'image/jpeg' && image.mime !== 'image/png') || typeof image.base64 !== 'string') return refusal('invalid_phone_result', 'Screenshot has no valid image');
    const path = file(p, 'shots', `${id}.${image.mime === 'image/png' ? 'png' : 'jpg'}`);
    await writeOwned(p, path, Buffer.from(image.base64, 'base64'));
    result = { ok: true, value: { path, mime: image.mime, width: result.value.width, height: result.value.height } };
  }
  if (mutation) {
    await log(p, { id, at: Date.now(), state: result.ok ? 'succeeded' : ['phone_timeout', 'phone_outcome_unknown'].includes(result.error.code) ? 'unknown' : 'failed', ...(result.ok ? { undo: result.value.undo } : { error: result.error, ...(result.error.undo ? { undo: result.error.undo } : {}) }) });
    if (result.ok) result = { ok: true, value: { ...result.value, id } };
  }
  return result;
}

/** Both channels watch the same folder. Atomic rename selects exactly one sender.
 * Directories are initialized before watching. Changing their ownership here emits
 * another watch event and makes an empty outbox scan itself forever.
 */
export async function deliverSettings(p: Person, deps: Pick<Deps, 'bus' | 'now'>) {
  for (const name of await readdir(file(p, 'outbox'))) {
    if (!UUID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
    const queued = await readJson<Request>(file(p, 'outbox', name));
    if (!queued || queued.id !== name.slice(0, -5) || !queued.args || typeof queued.args.action !== 'string') { await remove(file(p, 'outbox', name)); continue; }
    // An offline channel must not claim commands that the other channel can send.
    if (!LOCAL.has(queued.args.action) && !phoneSettingsConnected(p.id)) continue;
    const claimed = file(p, 'claimed', name);
    if (!await rename(file(p, 'outbox', name), claimed).then(() => true, e => { if (absent(e)) return false; throw e; })) continue;
    void (async () => {
      let result: SettingsOutcome;
      try {
        result = deps.now() - queued.at > 35_000 ? refusal('phone_command_expired', 'This command expired before delivery and was not run') : await performSettings(p, queued, async request => {
          if (!phoneSettingsConnected(p.id)) return refusal('phone_not_connected', 'The Kenan app is not connected. It works over cellular or Wi-Fi without debugging.');
          const answer = file(p, 'answers', `${request.id}.json`);
          deps.bus.toPerson(p.id, { type: 'phone_settings', command: { ...request.args, id: request.id, at: request.at } });
          if (!await waitSettingsFile(answer, 30_000)) return refusal('phone_timeout', 'The phone did not return a result. The command may have run; do not replay it automatically.');
          const outcome = (await readJson<SettingsOutcome>(answer))!; await remove(answer); return outcome;
        });
      } catch (e) { result = refusal('phone_command_error', String(e)); }
      await writeOwned(p, file(p, 'results', name), JSON.stringify(result));
      await remove(claimed);
    })();
  }
}

export async function startSettingsCommands(people: PersonConfig[], deps: Pick<Deps, 'bus' | 'now' | 'store'>): Promise<() => void> {
  const watchers: FSWatcher[] = [];
  const deliver = (p: PersonConfig) => void deliverSettings(p, deps).catch(e => deps.store.logError('phone-settings', String(e)));
  for (const p of people) { await settingsDirs(p); watchers.push(watch(file(p, 'outbox'), () => deliver(p))); deliver(p); }
  // Notification connections already send heartbeats; when one opens/reconnects, deliver pending commands once.
  const unsubscribe = onSettingsPhone(id => { const p = people.find(p => p.id === id); if (p) deliver(p); });
  return () => { for (const watcher of watchers) watcher.close(); unsubscribe(); };
}
