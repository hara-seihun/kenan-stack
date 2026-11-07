/**
 * A Browser Use Cloud browser (US residential egress) for Kenan's own Meet notetaker, through the host's cloud-browser
 * client and its root broker (deploy/cloud-browser). Google refuses a session moved off its residential network and
 * challenges a datacenter sign-in, so a signed-in notetaker on a cloud VM runs its Chrome there and drives it over CDP.
 * The CDP endpoint is a secret: it is read from the owner-only config cloud-browser writes, never logged.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const CLOUD_BROWSER = '/usr/local/bin/cloud-browser';
export interface CloudBrowser { session: string; cdp: string }

/** Lifetime to ask for: until the hard cap plus a margin, within Browser Use's 1..240 minutes. */
export const cloudMinutes = (capAt: number, now: number) => Math.min(240, Math.max(5, Math.ceil((capAt - now) / 60_000) + 5));

export async function startCloudBrowser(profile: string, minutes: number, runDir?: string, executable = CLOUD_BROWSER): Promise<CloudBrowser> {
  const env = { ...process.env, ...(runDir ? { CLOUD_BROWSER_RUN_DIR: runDir } : {}) };
  let stdout: string;
  try { ({ stdout } = await run(executable, ['start', profile, '--minutes', String(minutes)], { env, timeout: 120_000 })); }
  catch (error) { throw new Error(`cloud browser did not start: ${String((error as { stderr?: string }).stderr ?? (error as Error).message).trim().slice(0, 300)}`); }
  const started = JSON.parse(stdout.trim().split('\n').at(-1)!) as { session_id?: string; config_path?: string };
  if (!started.session_id || !started.config_path) throw new Error('cloud browser started without a session id or config');
  const config = JSON.parse(await readFile(started.config_path, 'utf8')) as { cdp?: string };
  if (!config.cdp) { await stopCloudBrowser(started.session_id, runDir, executable).catch(() => {}); throw new Error('cloud browser config has no CDP endpoint'); }
  return { session: started.session_id, cdp: config.cdp };
}

export async function stopCloudBrowser(session: string, runDir?: string, executable = CLOUD_BROWSER): Promise<void> {
  const env = { ...process.env, ...(runDir ? { CLOUD_BROWSER_RUN_DIR: runDir } : {}) };
  await run(executable, ['stop', session], { env, timeout: 60_000 });
}

/** Free cloud browser sessions on the account (its concurrency limit minus active sessions), or null when unknown. */
export async function cloudBrowserFreeSessions(executable = CLOUD_BROWSER): Promise<number | null> {
  try {
    const { stdout } = await run(executable, ['balance'], { timeout: 20_000 });
    const b = JSON.parse(stdout.trim().split('\n').at(-1)!) as { activeSessionCount?: unknown; concurrentSessionLimit?: unknown };
    return typeof b.activeSessionCount === 'number' && typeof b.concurrentSessionLimit === 'number' ? Math.max(0, b.concurrentSessionLimit - b.activeSessionCount) : null;
  } catch { return null; }
}
