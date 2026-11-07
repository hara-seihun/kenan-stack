// Durable host inboxes: one directory per person (owned by their unix user, mode 0700) under a root such as
// /var/lib/kenan/notify or /var/lib/kenan/events. A host process writes a JSON file there atomically (a dot-named temp
// file renamed to NAME.json); the channel hosting the person's manager takes each file in name order and deletes it.
// Files written while no channel runs wait on disk and are taken when one starts, so nothing is lost to a restart.
import { appendFile, chmod, chown, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostedManager, type PersonConfig } from './config.js';
import type { Deps } from './types.js';

export type InboxOutcome = { kind: 'taken' } | { kind: 'rejected'; error: string; senderTold?: true } | { kind: 'held'; error: string };
/** Takes one parsed file: `taken` deletes it, `rejected` sets it aside as NAME.invalid, `held` keeps it and retries it on a later pass. */
export type InboxTake = (person: PersonConfig, raw: unknown) => Promise<InboxOutcome>;
const RETRY_MS = 30_000;
/** A file held this many passes, while another file was taken in the same pass, can't be stored: quarantine it. */
const QUARANTINE_AFTER = 3;

/** Postgres rejects NUL in text and jsonb, and unpaired surrogates in jsonb: drop them from every string and key. */
export function storable<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '') as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k), storable(v)])) as T;
  return value;
}

async function take(person: PersonConfig, path: string, handle: InboxTake): Promise<InboxOutcome> {
  const stat = await lstat(path);
  if (!stat.isFile()) return { kind: 'rejected', error: 'not a regular file' };
  let raw: unknown;
  try { raw = storable(JSON.parse(await readFile(path, 'utf8'))); } catch { return { kind: 'rejected', error: 'not JSON' }; }
  return handle(person, raw);
}

const heldCounts = new Map<string, number>();

/** Sets a file that can't be stored aside in dir/quarantine with its error, and raises one host alert line for it. */
async function quarantine(deps: Deps, scope: string, person: PersonConfig, dir: string, name: string, error: string): Promise<void> {
  const q = join(dir, 'quarantine');
  await mkdir(q, { recursive: true, mode: 0o700 });
  const owner = await lstat(dir);
  await chown(q, owner.uid, owner.gid).catch(() => undefined);
  await writeFile(join(q, name.replace(/\.json$/, '.reason')), `${error}\n`, { mode: 0o600 });
  await rename(join(dir, name), join(q, name));
  await deps.store.logError(scope, `${person.id}/${name} quarantined: ${error}`);
  if (person.alertDir) await appendFile(join(person.alertDir, `host-inbox-quarantine-${scope}-${person.id}.md`), `${scope}: ${join(q, name)} could not be stored and was set aside (${error.slice(0, 300)}). Delete this file once looked at.\n`).catch(() => undefined);
}

/** Takes every queued NAME.json in name order. Invalid files become NAME.invalid. A held file is retried on later passes
 *  and never stops the rest; once one has been held QUARANTINE_AFTER passes while others were taken, it is quarantined. */
export async function drainInbox(deps: Deps, scope: string, person: PersonConfig, dir: string, handle: InboxTake): Promise<void> {
  const held: { name: string; error: string }[] = [];
  let taken = 0;
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const path = join(dir, name);
    const outcome = await take(person, path, handle).catch((e: unknown): InboxOutcome => ({ kind: 'held', error: String(e) }));
    switch (outcome.kind) {
      case 'taken': await unlink(path); heldCounts.delete(path); taken++; break;
      case 'rejected':
        // The rename comes last: once NAME.json is gone, its reason and log line exist (a reader, or a test that stops
        // the store when the queue is empty, saw NAME.invalid without its reason and a log write after the pool ended).
        await writeFile(path.replace(/\.json$/, '.invalid.reason'), `${outcome.error}\n`, { mode: 0o600 });
        await lstat(dir).then(d => chown(path.replace(/\.json$/, '.invalid.reason'), d.uid, d.gid)).catch(() => undefined);
        if (!outcome.senderTold) await deps.store.logError(scope, `${person.id}/${name} rejected: ${outcome.error}`);
        await rename(path, path.replace(/\.json$/, '.invalid'));
        heldCounts.delete(path);
        break;
      case 'held':
        heldCounts.set(path, (heldCounts.get(path) ?? 0) + 1);
        held.push({ name, error: outcome.error });
        await deps.store.logError(scope, `${person.id}/${name} held: ${outcome.error}`);
        break;
    }
  }
  for (const { name, error } of held) {
    const path = join(dir, name);
    if (taken > 0 && (heldCounts.get(path) ?? 0) >= QUARANTINE_AFTER) { await quarantine(deps, scope, person, dir, name, error); heldCounts.delete(path); }
  }
}

const personInboxStops = new Map<string, Set<() => Promise<void>>>();
export async function stopPersonInboxes(personId: string): Promise<void> {
  await Promise.all([...(personInboxStops.get(personId) ?? [])].map(stop => stop()));
}

function inbox(deps: Deps, scope: string, person: PersonConfig, dir: string, handle: InboxTake, retryMs = RETRY_MS): () => void {
  let running: Promise<void> | null = null, again = false;
  const run = () => {
    if (running) { again = true; return; }
    running = drainInbox(deps, scope, person, dir, handle)
      .catch(e => deps.store.logError(scope, `${person.id}: ${String(e)}`))
      .finally(() => { running = null; if (again) { again = false; run(); } });
  };
  const watcher: FSWatcher = watch(dir, run);
  const timer = setInterval(run, retryMs);
  run();
  const stop = async () => { watcher.close(); clearInterval(timer); again = false; await running; personInboxStops.get(person.id)?.delete(stop); };
  const personStops = personInboxStops.get(person.id) ?? new Set();
  personStops.add(stop); personInboxStops.set(person.id, personStops);
  return () => { void stop(); };
}

/** One inbox: the directory `name` under the root, owned by the unix user whose processes write it, drained for `person`. */
export type InboxPlace = { person: PersonConfig; name: string; uid: number; gid: number };
export async function startInboxPlaces(deps: Deps, root: string, scope: string, places: InboxPlace[], handle: InboxTake, retryMs = RETRY_MS): Promise<() => void> {
  await mkdir(root, { recursive: true, mode: 0o755 });
  const stops = await Promise.all(places.map(async place => {
    const dir = join(root, place.name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chown(dir, place.uid, place.gid);
    await chmod(dir, 0o700);
    return inbox(deps, scope, place.person, dir, handle, retryMs);
  }));
  return () => { for (const stop of stops) stop(); };
}
/** Drains `root`/PERSON for each person whose manager runs on this channel; returns a closer. */
export function startHostInboxes(deps: Deps, root: string, scope: string, handle: InboxTake): Promise<() => void> {
  return startInboxPlaces(deps, root, scope, deps.config.people.filter(p => hostedManager(p)).map(p => ({ person: p, name: p.id, uid: p.uid, gid: p.gid })), handle);
}

/** Queues one JSON file for `person` under `root` (their directory is created on first use, owned by them, mode 0700), atomically. */
export async function queueInboxFile(root: string, person: { id: string; uid: number; gid: number }, value: unknown): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o755 });
  const dir = join(root, person.id), name = `${process.hrtime.bigint()}-${randomUUID()}`;
  if (await mkdir(dir, { mode: 0o700 }).then(() => true, e => { if (e.code === 'EEXIST') return false; throw e; })) await chown(dir, person.uid, person.gid);
  await writeFile(join(dir, `.${name}`), JSON.stringify(value), { mode: 0o600, flush: true });
  await rename(join(dir, `.${name}`), join(dir, `${name}.json`));
  for (const path of [dir, root]) {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
