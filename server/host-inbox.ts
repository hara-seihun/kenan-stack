// Durable host inboxes: one directory per person (owned by their unix user, mode 0700) under a root such as
// /var/lib/kenan/notify or /var/lib/kenan/events. A host process writes a JSON file there atomically (a dot-named temp
// file renamed to NAME.json); the channel hosting the person's manager takes each file in name order and deletes it.
// Files written while no channel runs wait on disk and are taken when one starts, so nothing is lost to a restart.
import { chmod, chown, lstat, mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { hostedManager, type PersonConfig } from './config.js';
import type { Deps } from './types.js';

export type InboxOutcome = { kind: 'taken' } | { kind: 'rejected'; error: string } | { kind: 'held'; error: string };
/** Takes one parsed file: `taken` deletes it, `rejected` sets it aside as NAME.invalid, `held` keeps it and stops the drain. */
export type InboxTake = (person: PersonConfig, raw: unknown) => Promise<InboxOutcome>;
const RETRY_MS = 30_000;

async function take(person: PersonConfig, path: string, handle: InboxTake): Promise<InboxOutcome> {
  const stat = await lstat(path);
  if (!stat.isFile()) return { kind: 'rejected', error: 'not a regular file' };
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); } catch { return { kind: 'rejected', error: 'not JSON' }; }
  return handle(person, raw);
}

/** Takes every queued NAME.json in name order. Invalid files become NAME.invalid; a held file stops the drain. */
export async function drainInbox(deps: Deps, scope: string, person: PersonConfig, dir: string, handle: InboxTake): Promise<void> {
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const path = join(dir, name);
    const outcome = await take(person, path, handle).catch((e: unknown): InboxOutcome => ({ kind: 'held', error: String(e) }));
    switch (outcome.kind) {
      case 'taken': await unlink(path); break;
      case 'rejected':
        await rename(path, path.replace(/\.json$/, '.invalid'));
        await deps.store.logError(scope, `${person.id}/${name} rejected: ${outcome.error}`);
        break;
      case 'held':
        await deps.store.logError(scope, `${person.id}/${name} held: ${outcome.error}`);
        return;
    }
  }
}

function inbox(deps: Deps, scope: string, person: PersonConfig, dir: string, handle: InboxTake): () => void {
  let running: Promise<void> | null = null, again = false;
  const run = () => {
    if (running) { again = true; return; }
    running = drainInbox(deps, scope, person, dir, handle)
      .catch(e => deps.store.logError(scope, `${person.id}: ${String(e)}`))
      .finally(() => { running = null; if (again) { again = false; run(); } });
  };
  const watcher: FSWatcher = watch(dir, run);
  const timer = setInterval(run, RETRY_MS);
  run();
  return () => { watcher.close(); clearInterval(timer); };
}

/** Drains `root`/PERSON for each person whose manager runs on this channel; returns a closer. */
export async function startHostInboxes(deps: Deps, root: string, scope: string, handle: InboxTake): Promise<() => void> {
  await mkdir(root, { recursive: true, mode: 0o755 });
  const stops = await Promise.all(deps.config.people.filter(p => hostedManager(p)).map(async p => {
    const dir = join(root, p.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chown(dir, p.uid, p.gid);
    await chmod(dir, 0o700);
    return inbox(deps, scope, p, dir, handle);
  }));
  return () => { for (const stop of stops) stop(); };
}
