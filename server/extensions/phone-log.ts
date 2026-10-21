// Each call's timing events (setup steps, hops, turns, delegation replies, hang-up) as JSON lines in
// DATADIR/call-logs/CALL.jsonl, written by both the bridge and the server. The journal keeps only hours of the busy
// system log, so call 714bd84f's bridge log was gone the next day; these files keep 30 days.
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DAYS = 30;

/** The call-log directory, created if missing, with logs older than LOG_DAYS removed. */
export function callLogDirectory(dataDir: string, nowMs: number): string {
  const dir = join(dataDir, 'call-logs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (nowMs - statSync(path).mtimeMs > LOG_DAYS * 86_400_000) unlinkSync(path);
  }
  return dir;
}

/** Writes one event line to stdout (the journal) and appends it to the call's log; `at` is wall-clock ms. */
export function callEvent(dir: string, callId: string, event: string, detail: Record<string, unknown>): void {
  const line = JSON.stringify({ event, call: callId, at: Date.now(), ...detail });
  console.log(line);
  try { appendFileSync(join(dir, `${callId}.jsonl`), `${line}\n`, { mode: 0o600 }); }
  catch (e) { console.log(JSON.stringify({ event: 'call-log-error', call: callId, error: String(e) })); }
}
