// The morning to-do check of the Organized layout: on for everyone on the layout at MORNING_AT until they change it
// (todos action `morning`), sent at most once a day. Table organized_morning in schema.sql.
import pg from 'pg';
import { minuteIn, todayIn, zoneOrHome } from '../../../shared/zone.js';
import { fail } from '../../../server/db/errors.js';
import type { Deps, Store } from '../../../server/types.js';
import { routeBackground, routesByChat } from '../../../server/agents/origin.js';
import { organizedPeople } from './people.js';

/** The morning to-do check: on for everyone on the Organized layout at MORNING_AT until they change it, sent at most once a day,
 *  only within MORNING_WINDOW_MIN after its time (a server that was down all morning skips that day rather than sending it at night). */
export const MORNING_AT = 8 * 60 + 30;
export const MORNING_WINDOW_MIN = 4 * 60;
export interface MorningCheck { enabled: boolean; atMinute: number; lastDay: string; sentAt: number | null }
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const atMinute = (v: unknown): number => {
  const m = typeof v === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : fail('invalid_input', 'at must be HH:MM (24-hour)');
};
/** The shortest time between two checks: a zone change can start a new local day hours after one was sent (Los Angeles
 *  to Auckland), and that day's check waits until this has passed. */
export const MORNING_MIN_GAP_MS = 12 * 3600_000;
/** Whether the check is due now in the person's current zone: on, not yet sent on this local day, inside the day's window,
 *  and not within MORNING_MIN_GAP_MS of the last one. */
export function morningDue(c: MorningCheck, now: number, zone: string): boolean {
  const minute = minuteIn(now, zone);
  return c.enabled && c.lastDay < todayIn(now, zone) && minute >= c.atMinute && minute < c.atMinute + MORNING_WINDOW_MIN
    && (c.sentAt === null || now - c.sentAt >= MORNING_MIN_GAP_MS);
}
export const MORNING_TEXT = 'Daily morning to-do check (built in for the Organized layout). Read the to-do list (todos list) and today\'s calendar, then tidy it quietly: '
  + 'delete to-dos that are done or have become obsolete, and re-order by priority (a ❗ at the start of the text keeps a to-do first in its section; todos move sends one to the end of a level). Suggest no Soon items and write no plan. '
  + 'Write one short message only when something truly needs them today (a deadline, a dated item, a decision); if you deleted anything, list each briefly with its reason (they can Undo). '
  + 'Otherwise NO_REPLY. They can turn this off or move it by telling you (todos action morning).';

export function morningStore(pool: pg.Pool) {
  const toCheck = (r: Record<string, unknown>): MorningCheck => ({ enabled: r.enabled as boolean, atMinute: Number(r.at_minute), lastDay: r.last_day as string, sentAt: r.sent_at === null ? null : Number(r.sent_at) });
  return {
    /** The person's check, made (on, at MORNING_AT, first sent the next day in `zone`) the first time it is read. */
    async get(owner: string, now: number, zone: string): Promise<MorningCheck> {
      await pool.query('INSERT INTO morning_check (owner_id, enabled, at_minute, last_day) VALUES ($1, true, $2, $3) ON CONFLICT (owner_id) DO NOTHING', [owner, MORNING_AT, todayIn(now, zone)]);
      return toCheck((await pool.query('SELECT * FROM morning_check WHERE owner_id = $1', [owner])).rows[0]);
    },
    async set(owner: string, patch: { enabled?: boolean; atMinute?: number }, now: number, zone: string): Promise<MorningCheck> {
      const current = await this.get(owner, now, zone);
      const r = await pool.query('UPDATE morning_check SET enabled = $2, at_minute = $3 WHERE owner_id = $1 RETURNING *', [owner, patch.enabled ?? current.enabled, patch.atMinute ?? current.atMinute]);
      return toCheck(r.rows[0]);
    },
    /** Claims the check for the local day it is in `zone`; false when another pass (or a restart) already sent it. */
    async claim(owner: string, now: number, zone: string): Promise<boolean> {
      return !!(await pool.query('UPDATE morning_check SET last_day = $2, sent_at = $3 WHERE owner_id = $1 AND enabled AND last_day < $2 AND (sent_at IS NULL OR sent_at <= $4)',
        [owner, todayIn(now, zone), now, now - MORNING_MIN_GAP_MS])).rowCount;
    },
  };
}
const morningView = (c: MorningCheck, zone: string) => ({ enabled: c.enabled, at: hhmm(c.atMinute), zone });
const zoneOf = async (store: Store, person: string) => zoneOrHome(await store.zoneOf(person));
/** One pass: every person on the Organized layout whose manager runs on this channel and whose check is due gets it in their own chat. */
export async function runMorningChecks(deps: Pick<Deps, 'config' | 'store' | 'runtime' | 'person' | 'now'>, pool: pg.Pool): Promise<string[]> {
  const sent: string[] = [], store = morningStore(pool), now = deps.now();
  for (const person of organizedPeople(deps.config)) {
    const manager = deps.runtime.managerFor(person.id);
    if (!manager || !(await routesByChat(deps, person))) continue;
    const zone = await zoneOf(deps.store, person.id);
    if (!morningDue(await store.get(person.id, now, zone), now, zone) || !(await store.claim(person.id, now, zone))) continue;
    const agent = await deps.store.getAgent(manager);
    if (!agent) continue;
    deps.runtime.deliver({ agentId: manager, kind: 'wake', text: MORNING_TEXT, fromId: 'system', ...await routeBackground(deps, agent, null) });
    sent.push(person.id);
  }
  return sent;
}

const bool = (v: unknown, name: string): boolean => typeof v === 'boolean' ? v : fail('invalid_input', `${name} must be boolean`);
export const MORNING_DESCRIPTION = 'morning: the built-in daily morning check; no other fields shows it, enabled (false turns it off) and/or at (HH:MM, her local time wherever she is) change it when they ask.\nonHome (add, update): true puts the item on her Home in "Waiting on you" whatever its level; use it when she asks for something to be on her Home. Home shows Today plus items with onHome; a project page lists the items linked to it.';
/** The todos tool's `morning` action. */
export async function morningAction(pool: pg.Pool, store: Store, owner: string, rest: Record<string, unknown>, now: number): Promise<unknown> {
  const morning = morningStore(pool);
  const patch = { ...(rest.enabled !== undefined ? { enabled: bool(rest.enabled, 'enabled') } : {}), ...(rest.at !== undefined ? { atMinute: atMinute(rest.at) } : {}) };
  const zone = await zoneOf(store, owner);
  return morningView(Object.keys(patch).length ? await morning.set(owner, patch, now, zone) : await morning.get(owner, now, zone), zone);
}
