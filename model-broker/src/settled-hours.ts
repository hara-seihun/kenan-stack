import type { Store } from "./store.js";

const HOUR = 3_600_000;
/** A lease records its tokens in the hour it ends, so an hour's usage rows stop changing once that hour is over; two hours leaves margin. */
export const SETTLED_AFTER_MS = 2 * HOUR;
/** Settled hours older than this are dropped from memory; older windows are read straight from the ledger. */
const KEEP_MS = 9 * 24 * HOUR;

type Cache = { from: number; to: number; hours: Map<number, unknown[]> };
const caches = new WeakMap<Store, Map<string, Cache>>();

/**
 * Rows of an hour-bucketed ledger query over the buckets that start in [since, until).
 *
 * The usage scans behind /v1/usage read a week of per-request rows (1.3 million on 2026-10-30) and took 30–90 s
 * on a busy disk. Settled hours never change, so each process reads them once and keeps them; later calls read
 * only the last few hours. `read(from, to)` returns the rows for buckets in [from, to), each carrying its `hour`.
 */
export function hourlyRows<T extends { hour: number }>(store: Store, key: string, read: (from: number, to: number) => T[],
  since: number, until: number, now: number): T[] {
  const start = Math.ceil(since / HOUR) * HOUR;
  const settled = Math.min(Math.ceil(until / HOUR) * HOUR, Math.floor(now / HOUR) * HOUR - SETTLED_AFTER_MS);
  if (settled <= start || start < now - KEEP_MS) return read(since, until);
  let byKey = caches.get(store);
  if (!byKey) caches.set(store, byKey = new Map());
  let cache = byKey.get(key);
  if (!cache || start > cache.to) byKey.set(key, cache = { from: start, to: start, hours: new Map() });
  const fill = (from: number, to: number) => {
    for (let hour = from; hour < to; hour += HOUR) cache!.hours.set(hour, []);
    for (const row of read(from, to)) cache!.hours.get(row.hour)?.push(row);
  };
  if (start < cache.from) { fill(start, cache.from); cache.from = start; }
  if (cache.to < settled) { fill(cache.to, settled); cache.to = settled; }
  const cutoff = Math.min(Math.ceil((now - KEEP_MS) / HOUR) * HOUR, cache.to);
  for (; cache.from < cutoff; cache.from += HOUR) cache.hours.delete(cache.from);
  const rows: T[] = [];
  for (let hour = start; hour < settled; hour += HOUR) for (const row of cache.hours.get(hour)! as T[]) rows.push(row);
  if (until > settled) for (const row of read(settled, until)) rows.push(row);
  return rows;
}
