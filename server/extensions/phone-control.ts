// Phone control (extension `phone`): with the person's consent, given twice (the extension in her channel config, and the
// Android app's accessibility service she turns on herself), her agents see and operate her phone during a session the
// phone shows with a "Stop" notification. Commands are files in her home, so whichever channel holds the phone's stream
// delivers them, whichever channel the agent runs on: the agent's channel writes outbox/ID.json, the channel with a
// controllable phone stream claims it (an atomic rename to claimed/) and sends it down GET /api/notifications, and the
// phone posts the result to /api/ext/phone/results, which lands in results/ID.json. Screenshots and the session log stay
// there too, owned by the person, and nowhere else.
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { appendFile, chown, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { PhoneAction, PhoneBubblePlace, PhoneCommand, PhoneDirection, PhoneKey, PhoneResult } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';
import { fail } from '../db/errors.js';
import { personOf } from '../http/app.js';
import { onControllablePhone, phoneControllable } from '../notifications.js';
import { ownerProcess } from '../tools/owner.js';
import type { Deps, Extension, ToolContext } from '../types.js';
import { ownedDir } from './texts.js';

export const IDLE_MS = 10 * 60_000;
/** A command no channel has claimed by then has no phone to go to. */
export const CLAIM_MS = 5_000;
export const RESULT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const KEYS: PhoneKey[] = ['back', 'home', 'recents', 'notifications', 'enter'];
const DIRECTIONS: PhoneDirection[] = ['up', 'down', 'left', 'right'];
const PLACES = ['top', 'bottom'] as const;
export const SAY_MAX = 200;

type Person = Pick<PersonConfig, 'id' | 'home' | 'uid' | 'gid'>;
/** What the phone itself reports to /ended. "stopped" is the pre-2026-10-22 app's single word for all three of
 *  stop_tapped, dismissed and service_off. */
export const PHONE_END_REASONS = ['stop_tapped', 'dismissed', 'service_off', 'idle', 'stopped'] as const;
export type PhoneEndReason = typeof PHONE_END_REASONS[number];
/** ended: an agent called end. lost: the phone answered that it had no such session without having reported an end
 *  (its app was restarted or killed, e.g. by battery saver). */
export type EndReason = 'ended' | 'lost' | PhoneEndReason;
export type Session =
  | { state: 'active'; id: string; startedAt: number; lastActivityAt: number }
  | { state: 'ended'; id: string; endedAt: number; reason: EndReason };

const END_EXPLAINED: Record<EndReason, string> = {
  ended: 'an agent ended it with action "end"',
  idle: `nothing was sent to it for ${IDLE_MS / 60_000} minutes (idle timeout)`,
  stop_tapped: 'she tapped Stop on the phone\'s "Kenan is using your phone" notification',
  dismissed: 'the "Kenan is using your phone" notification was swiped away on the phone',
  service_off: 'Kenan\'s accessibility service on the phone was switched off or killed by Android',
  stopped: 'the phone app reported it stopped without saying how: Stop tapped, its notification swiped away, or Kenan\'s accessibility service switched off or killed by Android (battery saver can do this). This app version cannot tell which, so do not assume she tapped Stop',
  lost: 'the phone no longer had the session and never reported ending it: the Kenan app was restarted or killed in the background (battery saver can do this). She did not tap Stop',
};
export const explainEnd = (session: Extract<Session, { state: 'ended' }>, now: number) =>
  `The last session (${session.id.slice(0, 8)}) ended ${Math.max(0, Math.round((now - session.endedAt) / 1000))} s ago (${session.reason}): ${END_EXPLAINED[session.reason]}`;
export type PhoneError = { code: string; message: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: PhoneError };

export const phoneDir = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/phone');
const path = (person: Person, ...parts: string[]) => join(phoneDir(person), ...parts);
const SUBDIRS = ['outbox', 'claimed', 'results', 'shots', 'sessions'];

export async function phoneDirs(person: Person) {
  for (const sub of SUBDIRS) await ownedDir(person, path(person, sub));
}

async function writeOwned(person: Person, file: string, data: string | Buffer) {
  const temp = join(file, '..', `.${randomUUID()}.tmp`);
  await writeFile(temp, data, { mode: 0o600 });
  await chown(temp, person.uid, person.gid);
  await rename(temp, file);
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const readJson = async <T>(file: string): Promise<T | null> => {
  const data = await readFile(file, 'utf8').catch(e => { if (missing(e)) return null; throw e; });
  return data === null ? null : JSON.parse(data) as T;
};

/** The current session; an active one idle for IDLE_MS is ended (and recorded so) on reading. */
export async function readSession(person: Person, now: number): Promise<Session | null> {
  const session = await readJson<Session>(path(person, 'session.json'));
  if (session?.state !== 'active' || now - session.lastActivityAt < IDLE_MS) return session;
  const ended: Session = { state: 'ended', id: session.id, endedAt: session.lastActivityAt + IDLE_MS, reason: 'idle' };
  await writeSession(person, ended);
  return ended;
}
const writeSession = (person: Person, session: Session) => writeOwned(person, path(person, 'session.json'), JSON.stringify(session));

/** Records the end the phone reports (Stop tapped, notification dismissed, service off, or its own idle timer) if it is about the current session. */
export async function phoneEnded(person: Person, sessionId: string, reason: PhoneEndReason, now: number): Promise<boolean> {
  const session = await readSession(person, now);
  if (session?.state !== 'active' || session.id !== sessionId) return false;
  await writeSession(person, { state: 'ended', id: sessionId, endedAt: now, reason });
  return true;
}

function waitForFile(dir: string, name: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (found: boolean, error?: unknown) => {
      if (settled) return; settled = true;
      watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve(found);
    };
    const check = () => void stat(join(dir, name)).then(() => finish(true), e => { if (!missing(e)) finish(false, e); });
    const aborted = () => finish(false, new Error('Phone command cancelled'));
    const watcher: FSWatcher = watch(dir, (_event, file) => { if (file === name) check(); });
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener('abort', aborted);
    check();
  });
}

/** Sends one command to whichever channel holds her controllable phone and returns the phone's answer. */
export async function sendCommand(person: Person, command: PhoneCommand, signal?: AbortSignal): Promise<Outcome<Record<string, unknown>>> {
  await phoneDirs(person);
  const name = `${command.id}.json`, outbox = path(person, 'outbox', name);
  await writeOwned(person, outbox, JSON.stringify(command));
  const cleanup = () => Promise.all([path(person, 'claimed', name), path(person, 'results', name)].map(f => unlink(f).catch(e => { if (!missing(e)) throw e; })));
  if (!await waitForFile(path(person, 'results'), name, CLAIM_MS, signal)) {
    const unclaimed = await unlink(outbox).then(() => true, e => { if (missing(e)) return false; throw e; });
    if (unclaimed) return { ok: false, error: { code: 'phone_not_connected', message: 'No phone with Kenan\'s accessibility service on is connected. She needs the Kenan Beta app open or running in the background, with "Allow Kenan to use this phone" turned on.' } };
    if (!await waitForFile(path(person, 'results'), name, RESULT_MS - CLAIM_MS, signal)) {
      await cleanup();
      return { ok: false, error: { code: 'phone_timeout', message: `The phone did not answer within ${RESULT_MS / 1000} s` } };
    }
  }
  const result = (await readJson<PhoneResult>(path(person, 'results', name)))!;
  await cleanup();
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
}

/** Claims the person's pending commands for this channel's phone stream and sends them down it. */
export async function deliverPending(person: Person, deps: Pick<Deps, 'bus' | 'now'>) {
  if (!phoneControllable(person.id)) return;
  for (const name of await readdir(path(person, 'outbox'))) {
    if (!name.endsWith('.json')) continue;
    const claimed = path(person, 'claimed', name);
    if (!await rename(path(person, 'outbox', name), claimed).then(() => true, e => { if (missing(e)) return false; throw e; })) continue;
    const command = (await readJson<PhoneCommand>(claimed))!;
    if (deps.now() - command.at > CLAIM_MS) { await unlink(claimed); continue; }
    deps.bus.toPerson(person.id, { type: 'phone', command });
  }
}

type ShotValue = { image: { mime: 'image/jpeg' | 'image/png'; base64: string }; width: number; height: number };
/** Validates a posted result for a command claimed for this person; a screenshot is kept as a file beside her session log. */
export async function storeResult(person: Person, raw: unknown): Promise<Outcome<null>> {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== 'string' || !UUID.test(r.id)) return { ok: false, error: { code: 'invalid_input', message: 'id: the command id' } };
  const name = `${r.id}.json`;
  const command = await readJson<PhoneCommand>(path(person, 'claimed', name));
  if (!command) return { ok: false, error: { code: 'not_found', message: 'No such pending command' } };
  let result: PhoneResult;
  if (r.ok === true && r.value && typeof r.value === 'object') {
    const value = r.value as Record<string, unknown>;
    if (command.action === 'screenshot') {
      const shot = value as Partial<ShotValue>;
      if (!shot.image || (shot.image.mime !== 'image/jpeg' && shot.image.mime !== 'image/png') || typeof shot.image.base64 !== 'string' || !Number.isInteger(shot.width) || !Number.isInteger(shot.height))
        return { ok: false, error: { code: 'invalid_input', message: 'screenshot: {image: {mime, base64}, width, height}' } };
      await ownedDir(person, path(person, 'shots', command.sessionId));
      const file = path(person, 'shots', command.sessionId, `${command.id}.${shot.image.mime === 'image/png' ? 'png' : 'jpg'}`);
      await writeOwned(person, file, Buffer.from(shot.image.base64, 'base64'));
      result = { id: r.id, ok: true, value: { path: file, mime: shot.image.mime, width: shot.width, height: shot.height } };
    } else result = { id: r.id, ok: true, value };
  } else if (r.ok === false && r.error && typeof (r.error as PhoneError).code === 'string' && typeof (r.error as PhoneError).message === 'string') {
    const error = r.error as PhoneError;
    result = { id: r.id, ok: false, error: { code: error.code.slice(0, 100), message: error.message.slice(0, 2000) } };
  } else return { ok: false, error: { code: 'invalid_input', message: 'ok: true with value, or false with error {code, message}' } };
  await writeOwned(person, path(person, 'results', name), JSON.stringify(result));
  return { ok: true, value: null };
}

type Args = { action: string; x?: number; y?: number; node?: number; long?: boolean; x2?: number; y2?: number; durationMs?: number; direction?: string; text?: string; secret?: { item: string; field: string }; key?: string; package?: string; place?: string };
type Planned = { action: PhoneAction; secret: { item: string; field: string } | null };
const bad = (message: string): Outcome<Planned> => ({ ok: false, error: { code: 'invalid_input', message } });
const coordinate = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

export function planAction(a: Args): Outcome<Planned> {
  const plain = (action: PhoneAction): Outcome<Planned> => ({ ok: true, value: { action, secret: null } });
  switch (a.action) {
    case 'start': case 'end': case 'screenshot': case 'ui': return plain({ action: a.action });
    case 'tap': {
      const long = a.long === true;
      if (a.node !== undefined && a.x === undefined && a.y === undefined) return Number.isInteger(a.node) && a.node >= 0 ? plain({ action: 'tap', target: { kind: 'node', node: a.node }, long }) : bad('node: an index from the last ui');
      if (a.node === undefined && coordinate(a.x) && coordinate(a.y)) return plain({ action: 'tap', target: { kind: 'point', x: a.x!, y: a.y! }, long });
      return bad('tap needs x and y (screenshot pixels) or node (from ui), not both');
    }
    case 'swipe': {
      if (![a.x, a.y, a.x2, a.y2].every(coordinate)) return bad('swipe needs x, y (from) and x2, y2 (to) in screenshot pixels');
      const durationMs = a.durationMs ?? 300;
      if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 5000) return bad('durationMs: 50–5000');
      return plain({ action: 'swipe', x1: a.x!, y1: a.y!, x2: a.x2!, y2: a.y2!, durationMs });
    }
    case 'scroll': {
      if (!DIRECTIONS.includes(a.direction as PhoneDirection)) return bad('direction: up, down, left or right (the way the content moves into view)');
      if (a.node !== undefined && !(Number.isInteger(a.node) && a.node >= 0)) return bad('node: an index from the last ui');
      return plain({ action: 'scroll', direction: a.direction as PhoneDirection, node: a.node ?? null });
    }
    case 'type': {
      if ((a.text === undefined) === (a.secret === undefined)) return bad('type needs exactly one of text or secret');
      if (a.secret) {
        if (typeof a.secret.item !== 'string' || !a.secret.item || typeof a.secret.field !== 'string' || !a.secret.field) return bad('secret: {item: exact vault item title, field}');
        return { ok: true, value: { action: { action: 'type', text: '', secret: true }, secret: a.secret } };
      }
      if (typeof a.text !== 'string' || a.text.length > 5000) return bad('text: at most 5000 characters');
      return plain({ action: 'type', text: a.text, secret: false });
    }
    case 'key': return KEYS.includes(a.key as PhoneKey) ? plain({ action: 'key', key: a.key as PhoneKey }) : bad(`key: ${KEYS.join(', ')}`);
    case 'open': return typeof a.package === 'string' && PACKAGE.test(a.package) ? plain({ action: 'open', package: a.package }) : bad('package: an Android package name, e.g. com.ubercab.eats');
    case 'say': {
      if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > SAY_MAX) return bad(`say needs text: 1–${SAY_MAX} characters for her to read`);
      if ((a.x === undefined) !== (a.y === undefined) || (a.x !== undefined && !(coordinate(a.x) && coordinate(a.y)))) return bad('say: x and y together (screenshot pixels) ring the spot to tap, or neither');
      if (a.place !== undefined && !PLACES.includes(a.place as typeof PLACES[number])) return bad('place: top or bottom');
      const point = a.x === undefined ? null : { x: a.x, y: a.y! };
      const place: PhoneBubblePlace = (a.place as PhoneBubblePlace | undefined) ?? (point ? 'away' : 'top');
      return plain({ action: 'say', text: a.text.trim(), place, point });
    }
    default: return bad(`Unknown phone action ${String(a.action)}`);
  }
}

export type VaultRead = (person: PersonConfig, item: string, field: string, signal?: AbortSignal) => Promise<Outcome<string>>;
/** Reads one field of a vault item as the person (Business-pass reaches her "Business…" items); the value goes only to the phone. */
const BusinessVault = (deps: Deps): VaultRead => async (person, item, field, signal) => {
  const run = await ownerProcess(deps.placement, person, '/usr/local/bin/Business-pass', ['view', item, field], undefined, signal, undefined, 60);
  const value = run.output.toString().replace(/\r?\n$/, '');
  if (run.exitCode !== 0 || !value) return { ok: false, error: { code: 'vault_read_failed', message: `Business-pass could not read field "${field}" of "${item}" (exit ${run.exitCode})` } };
  return { ok: true, value };
};

const idleTimers = new Map<string, NodeJS.Timeout>();
/** At IDLE_MS after the last command the session ends here too, so the phone's notification goes even if its own timer didn't run. */
function armIdleEnd(person: Person, sessionId: string, deps: Pick<Deps, 'now'>) {
  clearTimeout(idleTimers.get(person.id));
  idleTimers.set(person.id, setTimeout(async () => {
    idleTimers.delete(person.id);
    const session = await readSession(person, deps.now()).catch(() => null);
    if (session?.state === 'ended' && session.id === sessionId && session.reason === 'idle')
      await sendCommand(person, { id: randomUUID(), sessionId, at: deps.now(), action: 'end' }).catch(() => undefined);
  }, IDLE_MS + 1000).unref());
}

const logLine = (person: Person, sessionId: string, entry: Record<string, unknown>) =>
  ownedDir(person, path(person, 'sessions')).then(async () => {
    const file = path(person, 'sessions', `${sessionId}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    await chown(file, person.uid, person.gid);
  });

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] as Content[], details: {} });
const refuse = (error: PhoneError) => { throw new Error(`${error.code}: ${error.message}`); };

const queues = new Map<string, Promise<unknown>>();
/** One person's phone calls run one at a time in the order they were made, so a batch like [start, ui] or [open, end]
 *  acts in that order instead of racing (a ui read the previous session's end before start had written the new one). */
export function runPhone(ctx: Pick<ToolContext, 'person'> & { deps: Pick<Deps, 'now'> }, vault: VaultRead, raw: Args, signal?: AbortSignal) {
  const id = ctx.person.id;
  const run = (queues.get(id) ?? Promise.resolve()).then(() => runPhoneNow(ctx, vault, raw, signal));
  const settled = run.then(() => undefined, () => undefined);
  queues.set(id, settled);
  void settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
  return run;
}

async function runPhoneNow(ctx: Pick<ToolContext, 'person'> & { deps: Pick<Deps, 'now'> }, vault: VaultRead, raw: Args, signal?: AbortSignal) {
  const { person, deps } = ctx;
  const planned = planAction(raw);
  if (!planned.ok) return refuse(planned.error);
  const { action, secret } = planned.value;
  await phoneDirs(person);
  const session = await readSession(person, deps.now());
  const active = session?.state === 'active' ? session : null;
  if (action.action === 'start' && active) return text({ session: active, note: 'Session already active' });
  if (action.action === 'end' && !active) return text({ session });
  if (action.action !== 'start' && action.action !== 'end' && !active)
    return refuse({ code: 'phone_no_session', message: session?.state === 'ended' ? `${explainEnd(session, deps.now())}. Call phone with action "start" to begin a new one` : 'Call phone with action "start" first' });
  const sessionId = active?.id ?? randomUUID();
  let wire = action;
  if (secret) {
    const read = await vault(person as PersonConfig, secret.item, secret.field, signal);
    if (!read.ok) return refuse(read.error);
    wire = { action: 'type', text: read.value, secret: true };
  }
  const id = randomUUID(), at = deps.now();
  if (active) await writeSession(person, { ...active, lastActivityAt: at });
  const outcome = await sendCommand(person, { id, sessionId, at, ...wire }, signal);
  const logged = action.action === 'type' && secret ? { action: 'type', secret } : action;
  await logLine(person, sessionId, { at, id, ...logged, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), ...(outcome.ok && action.action === 'screenshot' ? { shot: outcome.value.path } : {}) });
  if (action.action === 'end') { await writeSession(person, { state: 'ended', id: sessionId, endedAt: at, reason: 'ended' }); clearTimeout(idleTimers.get(person.id)); }
  if (!outcome.ok) {
    if (outcome.error.code === 'phone_session_not_active' && active) {
      const now = await readSession(person, deps.now());
      const ended: Session = now?.state === 'ended' && now.id === sessionId ? now : { state: 'ended', id: sessionId, endedAt: deps.now(), reason: 'lost' };
      if (ended !== now) await writeSession(person, ended);
      clearTimeout(idleTimers.get(person.id));
      return refuse({ code: 'phone_session_not_active', message: `${explainEnd(ended, deps.now())}. Call phone with action "start" to begin a new one` });
    }
    if (outcome.error.code === 'invalid_command' && action.action === 'say')
      return refuse({ code: 'phone_app_outdated', message: 'The Kenan app on her phone is too old to show bubbles; it needs the app update (Settings → Update, or the automatic update prompt). Everything else still works' });
    return refuse(outcome.error);
  }
  if (action.action === 'start') await writeSession(person, { state: 'active', id: sessionId, startedAt: at, lastActivityAt: at });
  if (action.action !== 'end') armIdleEnd(person, sessionId, deps);
  if (action.action === 'screenshot') {
    const shot = outcome.value as { path: string; mime: string; width: number; height: number };
    return { content: [{ type: 'text', text: JSON.stringify({ width: shot.width, height: shot.height, path: shot.path }) }, { type: 'image', data: (await readFile(shot.path)).toString('base64'), mimeType: shot.mime }] as Content[], details: {} };
  }
  return text(action.action === 'start' ? { session: { state: 'active', id: sessionId, startedAt: at }, phone: outcome.value } : outcome.value);
}

const watchers: FSWatcher[] = [];
let releaseListener: (() => void) | null = null;

export const phoneExtension: Extension = {
  id: 'phone', name: 'Phone',
  promptSnippet: 'Phone: the phone tool sees and operates the person\'s own Android phone (she turned it on herself). Start a session, look with screenshot or ui, act with tap/swipe/scroll/type/key/open, show her instructions on the screen with say, and end it when done; she sees "Kenan is using your phone · Stop" meanwhile and can stop it any time.',
  routes(app, deps) {
    app.use('*', async (c, next) => { if (!deps.person(personOf(c))?.extensions.includes('phone')) fail('forbidden', 'Phone control is not enabled'); await next(); });
    app.get('/', c => c.json({ ok: true, value: { enabled: true } }));
    app.post('/results', async c => {
      const person = deps.person(personOf(c))!;
      await phoneDirs(person);
      const stored = await storeResult(person, await c.req.json().catch(() => null));
      if (!stored.ok) return fail(stored.error.code === 'not_found' ? 'not_found' : 'invalid_input', stored.error.message);
      return c.json({ ok: true, value: null });
    });
    app.post('/ended', async c => {
      const body = await c.req.json().catch(() => null) as { sessionId?: unknown; reason?: unknown } | null;
      if (typeof body?.sessionId !== 'string' || !PHONE_END_REASONS.includes(body.reason as PhoneEndReason)) return fail('invalid_input', `sessionId and reason (${PHONE_END_REASONS.join(', ')})`);
      const person = deps.person(personOf(c))!;
      await phoneDirs(person);
      return c.json({ ok: true, value: { ended: await phoneEnded(person, body.sessionId, body.reason as PhoneEndReason, deps.now()) } });
    });
  },
  async start(deps) {
    const people = deps.config.people.filter(p => p.extensions.includes('phone'));
    const deliver = (person: PersonConfig) => deliverPending(person, deps).catch(e => deps.store.logError('phone_control', `deliver for ${person.id}: ${String(e)}`));
    for (const person of people) {
      await phoneDirs(person);
      watchers.push(watch(path(person, 'outbox'), (_event, name) => { if (name?.endsWith('.json')) void deliver(person); }));
    }
    releaseListener = onControllablePhone(id => { const person = people.find(p => p.id === id); if (person) void deliver(person); });
  },
  async stop() {
    for (const w of watchers.splice(0)) w.close();
    releaseListener?.(); releaseListener = null;
    for (const t of idleTimers.values()) clearTimeout(t);
    idleTimers.clear();
  },
  tool: ({ person, deps }) => ({
    name: 'phone', files: 'none', records: 'none', label: 'Phone',
    description: `See and operate ${person.name}'s own Android phone through the Kenan app's accessibility service, which she turned on herself. action "start" begins a session (her phone shows "Kenan is using your phone · Stop"); every other action needs an active one, and a session ends on "end", when she taps Stop, or after ${IDLE_MS / 60_000} minutes without a command (then start again); calls run one at a time in the order you make them, and an ended session's error says what ended it (agent end, idle timeout, Stop tapped, notification dismissed, accessibility service off, or the app restarted/killed), so never assume she stopped it. "screenshot" returns the screen as an image; "ui" returns the visible elements (text, description, id, bounds, clickable/editable/scrollable) with node indexes. Coordinates are screenshot pixels (the long side is at most 1568). "tap": x, y, or node (an index from the latest ui); long: true long-presses. "swipe": x, y to x2, y2, durationMs (50–5000, 300 when omitted). "scroll": direction up|down|left|right (the way the content moves into view), optionally on node. "type" sets the focused field's text: text for ordinary text, or secret {item, field} to type a vault field (her Business items through Business-pass) without it passing through you; plain text into a password field is refused. "key": back, home, recents, notifications, enter. "open": an app by package name. "say": text (≤ ${SAY_MAX} characters) shows her a speech bubble over whatever app is open, for steps she must do herself ("Tap the blue CFP 6 link, 2nd line"); it stays until she taps it, the next say replaces it or the session ends; place top|bottom (top when omitted), and x, y (screenshot pixels) ring the spot to tap, the bubble then going to the other half of the screen unless place is given. Bubbles never appear in screenshots or ui (ui's "bubble" is the text still showing, null once she has closed it). On "end" her phone shows "Kenan is done with your phone" for a few seconds. It never sends texts: the default SMS app can be looked at but not operated. Errors: phone_not_connected (app not running or accessibility off), phone_no_session, phone_timeout, and the phone's own codes.`,
    parameters: Type.Object({
      action: Type.Union(['start', 'screenshot', 'ui', 'tap', 'swipe', 'scroll', 'type', 'key', 'open', 'say', 'end'].map(a => Type.Literal(a))),
      x: Type.Optional(Type.Integer({ minimum: 0 })), y: Type.Optional(Type.Integer({ minimum: 0 })),
      x2: Type.Optional(Type.Integer({ minimum: 0 })), y2: Type.Optional(Type.Integer({ minimum: 0 })),
      node: Type.Optional(Type.Integer({ minimum: 0 })), long: Type.Optional(Type.Boolean()),
      durationMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 5000 })),
      direction: Type.Optional(Type.Union(DIRECTIONS.map(d => Type.Literal(d)))),
      text: Type.Optional(Type.String({ maxLength: 5000 })),
      secret: Type.Optional(Type.Object({ item: Type.String({ minLength: 1 }), field: Type.String({ minLength: 1 }) })),
      key: Type.Optional(Type.Union(KEYS.map(k => Type.Literal(k)))),
      package: Type.Optional(Type.String({ minLength: 3 })),
      place: Type.Optional(Type.Union(PLACES.map(p => Type.Literal(p)))),
    }),
    execute: (_id, raw: unknown, signal) => runPhone({ person, deps }, BusinessVault(deps), raw as Args, signal),
  }),
};
