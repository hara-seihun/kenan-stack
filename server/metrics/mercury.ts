import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MercuryReport } from '../../shared/contract.js';
import type { Deps } from '../types.js';

/** ResearchCo's Mercury balances: the cache `mercury-balance` (~/tools/mercury) refreshes every 10 minutes. Alice only. */
const RECORD = '.local/state/mercury/summary.json';
const STALE_MS = 30 * 60_000;

export async function mercuryReport(deps: Deps, personId: string): Promise<MercuryReport | { unavailable: string }> {
  const person = deps.person(personId);
  if (personId !== 'alice' || !person || person.unixUser !== 'kenan') return { unavailable: 'Mercury is shown to Alice only.' };
  let record: Omit<MercuryReport, 'problem'>;
  try { record = JSON.parse(await readFile(join(person.home, RECORD), 'utf8')) as Omit<MercuryReport, 'problem'>; }
  catch { return { unavailable: 'The Mercury record has not been written yet: mercury-balance.timer is not running.' }; }
  const age = deps.now() - record.observedAt;
  return { ...record, problem: age > STALE_MS ? `The Mercury record is ${Math.round(age / 60_000)} minutes old: mercury-balance.timer has stopped refreshing it.` : null };
}
