import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonConfig } from './config.js';

type Streak = { kind: 'none' | 'low' | 'unobservable'; count: number };
const empty = (): Streak => ({ kind: 'none', count: 0 });
const pending = new Map<string, Promise<void>>();

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readStreak(path: string): Promise<Streak> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
  try {
    const state: unknown = JSON.parse(text);
    if (state && typeof state === 'object' && 'kind' in state && 'count' in state &&
        (state.kind === 'none' || state.kind === 'low' || state.kind === 'unobservable') &&
        typeof state.count === 'number' && Number.isInteger(state.count) && state.count >= 0 && state.count <= 3) {
      return { kind: state.kind, count: state.count };
    }
  } catch { /* Invalid saved state is treated like a new streak, with a warning below. */ }
  console.warn('Antigravity cache health: invalid saved streak; starting a new streak');
  return empty();
}

/** Records one Antigravity prompt's cache usage. Input excludes cacheRead, as in Pi usage. */
export async function recordGoogleCacheHealth(owner: PersonConfig | undefined, threadKey: string | undefined, usage: { input: number; cacheRead: number }, stateDir: string): Promise<void> {
  if (!owner?.alertDir) return;
  try {
    // The worker id is the thread key; hash it for filenames and to keep names within the supplied directories.
    const key = createHash('sha256').update(JSON.stringify([owner.id, threadKey ?? null])).digest('hex').slice(0, 32);
    const statePath = join(stateDir, `google-cache-${key}.json`);
    const alertPath = join(owner.alertDir, `google-cli-cache-${key}.md`);
    const worker = threadKey && /^[a-zA-Z0-9_-]{1,64}$/.test(threadKey) ? threadKey : `unknown (${key.slice(0, 12)})`;

    // Calls for the same worker can overlap during a reload. Serialize just their tiny read/update/write sections.
    const before = pending.get(statePath) ?? Promise.resolve();
    const current = before.catch(() => {}).then(async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const previous = await readStreak(statePath);
      const { input, cacheRead } = usage;
      const total = input + cacheRead;
      const observable = Number.isFinite(input) && input >= 0 && Number.isFinite(cacheRead) && cacheRead >= 0 && Number.isFinite(total) && total > 0;
      const recovered = observable && cacheRead / total >= 0.05;
      const kind: Streak['kind'] = !observable ? 'unobservable' : !recovered && total >= 4096 ? 'low' : 'none';
      const next: Streak = kind === 'none' ? empty() : { kind, count: Math.min(3, previous.kind === kind ? previous.count + 1 : 1) };
      await atomicWrite(statePath, JSON.stringify(next) + '\n', 0o600);

      if (recovered) {
        await rm(alertPath, { force: true });
      } else if (next.count === 3) {
        await mkdir(owner.alertDir!, { recursive: true });
        const detail = kind === 'low'
          ? `# Antigravity prompt cache is below 5% for worker ${worker}\n\nThe last three measured prompts each had at least 4,096 input tokens and less than 5% cached. The latest had ${cacheRead} cached out of ${total} input tokens.`
          : `# Antigravity prompt cache is unobservable for worker ${worker}\n\nThe last three calls had missing or unusable input/cache usage, so their cache hit rate cannot be measured.`;
        await atomicWrite(alertPath, `${detail}\n\nCheck Antigravity usage reporting and prompt caching. This alert clears when a reported cache share reaches 5%.\n`, 0o644);
      }
    });
    pending.set(statePath, current);
    try { await current; } finally { if (pending.get(statePath) === current) pending.delete(statePath); }
  } catch (error) {
    // Cache monitoring must never interrupt the model response.
    console.warn('Antigravity cache health:', error instanceof Error ? error.message : String(error));
  }
}
