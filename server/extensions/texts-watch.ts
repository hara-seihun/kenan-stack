// Raises a host alert when the phone's texts feed can't be working: the Android app reports a missing permission, or the
// app is connected yet nothing has been forwarded for 12 hours. The app reports its texts state in the network
// diagnostics (NetworkDiag.kt); the newest report is kept in texts-report.json beside network.jsonl.
import { mkdir, readFile, rename, rm, writeFile, chown } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonConfig } from '../config.js';
import type { Deps } from '../types.js';

const CONNECTED_MS = 10 * 60_000;
const CHECK_MS = 5 * 60_000;
export const ALERT_FILE = 'phone-texts-feed.md';

export interface TextsReport { received: number; texts: { server: string; smsPermission: boolean; notificationAccess: boolean; queue: number; lastUpload: { at: number; result: string; sent: number } | null } }
export const reportFile = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/phone-settings/texts-report.json');

/** Why the feed is not working, one line each; empty when it is fine. A report that says the server keeps no texts for this person raises nothing. */
export function feedProblems(report: TextsReport | null, now: number): string[] {
  if (report === null || now - report.received > CONNECTED_MS || report.texts.server === 'Disabled') return [];
  const t = report.texts, problems: string[] = [];
  if (!t.smsPermission) problems.push('The app reports SMS permission is missing.');
  if (!t.notificationAccess) problems.push('The app reports Notification access is missing.');
  if (t.queue > 0 && t.lastUpload && t.lastUpload.result !== 'http 200') problems.push(`${t.queue} texts are queued on the phone; the last upload result was "${t.lastUpload.result}".`);
  return problems;
}

export async function saveReport(person: PersonConfig, entries: unknown[], at: number) {
  const latest = [...entries].reverse().find(e => typeof (e as { texts?: unknown }).texts === 'object' && (e as { texts?: unknown }).texts !== null) as { texts: TextsReport['texts'] } | undefined;
  if (!latest) return;
  const file = reportFile(person), temp = `${file}.tmp`;
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(temp, JSON.stringify({ received: at, texts: latest.texts }), { mode: 0o600 });
  await chown(temp, person.uid, person.gid);
  await rename(temp, file);
}

const readReport = (person: PersonConfig) => readFile(reportFile(person), 'utf8').then(t => JSON.parse(t) as TextsReport, (e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? null : Promise.reject(e));

export async function checkFeed(person: PersonConfig, now: number) {
  if (!person.alertDir) return;
  const problems = feedProblems(await readReport(person), now);
  const file = join(person.alertDir, ALERT_FILE);
  if (!problems.length) { await rm(file, { force: true }); return; }
  await writeFile(file, `# Texts from ${person.name}'s phone aren't arriving\n\n${problems.map(p => `- ${p}`).join('\n')}\n\nThe Kenan app's notification Texts setup prompt shows on the phone while a permission is missing; re-granting is one tap and one toggle. If the app is old, install the latest APK. Owner: server/extensions/texts-watch.ts. This file clears itself when the feed recovers.\n`);
}

let timer: ReturnType<typeof setInterval> | undefined;
export async function startWatch(deps: Deps) {
  const run = () => { for (const p of deps.config.people) if (p.extensions.includes('texts') && p.extensions.includes('phone-settings')) checkFeed(p, deps.now()).catch(e => deps.store.logError(`texts-watch:${p.id}`, String(e))); };
  timer = setInterval(run, CHECK_MS); timer.unref?.(); run();
}
export async function stopWatch() { if (timer) clearInterval(timer); timer = undefined; }
