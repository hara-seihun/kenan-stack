import { createReadStream } from 'node:fs';
import { link, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';

/**
 * Pi loads a session's whole file into memory and keeps it there while the agent lives, though after a compaction the model
 * only ever sees the latest compaction and what follows it. Alice's Kenaznia had written 270 MB in a week (70 compactions), and
 * with the other long-lived sessions it held most of Beta's 2 GiB heap, whose garbage collection stalled every agent
 * (2026-10-31). A session file past TRIM_BYTES is therefore rewritten, before Pi opens it, to what Pi still uses: its header,
 * the latest compaction with the entries it keeps and everything after, the session's first user message (a worker's pinned
 * task, context-budget.ts) and the last model and thinking-level settings before the cut. The full file stays readable as
 * `transcripts/<name>.<time>.jsonl` under the channel's data directory, a hard link to the original bytes.
 */
export const TRIM_BYTES = 16 * 2 ** 20;

type Entry = { type: string; id: string; parentId: string | null; firstKeptEntryId?: string; message?: { role?: string } };

/** The entries a trimmed session keeps, re-chained in order; null when trimming would drop nothing or the file isn't one Pi writes now. */
export function trimEntries(header: { type: string; version?: number }, entries: Entry[]): Entry[] | null {
  if (header.type !== 'session' || header.version !== CURRENT_SESSION_VERSION || !entries.length) return null;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const path: Entry[] = [];
  for (let current: Entry | undefined = entries[entries.length - 1]; current; current = current.parentId ? byId.get(current.parentId) : undefined) path.push(current);
  path.reverse();
  let compaction = -1;
  for (let i = path.length - 1; i >= 0; i--) if (path[i]!.type === 'compaction') { compaction = i; break; }
  if (compaction < 0) return null;
  const firstKept = path.findIndex(entry => entry.id === path[compaction]!.firstKeptEntryId);
  const start = firstKept >= 0 && firstKept < compaction ? firstKept : compaction;
  if (start === 0) return null;
  const dropped = path.slice(0, start);
  const lastOf = (type: string) => dropped.findLast(entry => entry.type === type);
  const firstUser = entries.find(entry => entry.type === 'message' && entry.message?.role === 'user');
  const kept = path.slice(start);
  const prefix = [firstUser && !kept.includes(firstUser) ? firstUser : undefined, lastOf('model_change'), lastOf('thinking_level_change')].filter((entry): entry is Entry => entry !== undefined);
  if (dropped.every(entry => prefix.includes(entry))) return null;
  let parentId: string | null = null;
  return [...prefix, ...kept].map(entry => { const chained = { ...entry, parentId }; parentId = entry.id; return chained; });
}

/** Rewrites an oversized session file to what Pi still uses (see above). Returns the transcript path when it trimmed. */
export async function trimSessionFile(path: string, dataDir: string, minBytes = TRIM_BYTES, now = new Date()): Promise<string | null> {
  const size = await stat(path).then(s => s.size, () => 0);
  if (size <= minBytes) return null;
  let header: { type: string; version?: number } | null = null;
  const entries: Entry[] = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let parsed: Entry;
    try { parsed = JSON.parse(line) as Entry; } catch { continue; }
    if (header === null) { header = parsed; continue; }
    entries.push(parsed);
  }
  const kept = header && trimEntries(header, entries);
  if (!kept) return null;
  const transcript = join(dataDir, 'transcripts', `${basename(path, '.jsonl')}.${now.toISOString().replace(/[:.]/g, '-')}.jsonl`);
  await mkdir(dirname(transcript), { recursive: true });
  const temp = `${path}.trim-${process.pid}`;
  await writeFile(temp, [header, ...kept].map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: (await stat(path)).mode & 0o777 });
  try { await link(path, transcript); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
  console.log(JSON.stringify({ type: 'session_trimmed', path, transcript, bytesBefore: size, entriesBefore: entries.length, entriesAfter: kept.length }));
  return transcript;
}
