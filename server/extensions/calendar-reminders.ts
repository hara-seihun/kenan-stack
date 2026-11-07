// Calendar changes, including external sync writes, replace one timer per event/series. No calendar polling.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hostedManager } from '../config.js';
import type { Deps } from '../types.js';
import type { PhoneNotification } from '../../shared/contract.js';
import { quietHoursStatus } from '../quiet-hours.js';
import { deliverNotification } from '../notifications.js';
import { expandEvents, type CalendarEvent, type CalendarItem } from './calendar.js';
import { pointInstant } from './recurrence.js';

const OWNER = 'alice';
const CHAT = '24c1a319-39e6-425c-ac8e-d7833e99d13d';
const MINUTE = 60_000;
const VIDEO = /https?:\/\/(?:[\w.-]*zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|doxy\.me|whereby\.com|[\w.-]*webex\.com)\/[^\s<>"()]+/i;
export function reminderMode(e: CalendarEvent): 'none' | 'gentle' | 'full' {
  if (e.deleted || e.allDay || e.attending === false || e.declined || /^\s*Option:/i.test(e.title) || /\bdeclined\b/i.test(e.title) || /Your response:\s*declined/i.test(e.notes ?? '')) return 'none';
  if (/\b(?:Robin|Carol|Erin) opens? (?:the )?house\b/i.test(e.title) || /\b(?:Alice|Alice) (?:does not attend|not attending|isn't attending)\b/i.test(e.notes ?? '')) return 'none';
  if (e.remind) return e.remind;
  if (VIDEO.test(`${e.location ?? ''}\n${e.notes ?? ''}`)) return 'full';
  if (/dessert|\bdinners?\b/i.test(e.title)) return 'gentle';
  return 'full';
}
const meeting = (e: CalendarEvent) => VIDEO.test(`${e.location}\n${e.notes}`) || /\b(call|meeting|intro|sync|check.in|interview)\b/i.test(e.title) || e.source === 'ACME-work';
export function reminderText(e: CalendarItem, stage: number, zone: string, now = Date.now()) {
  const start = pointInstant(e.start, e.zone);
  const format = (z: string) => new Intl.DateTimeFormat('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(start);
  const time = format(zone) + (meeting(e) && zone !== 'America/Toronto' ? ` / ${format('America/Toronto')}` : '');
  const link = VIDEO.exec(`${e.location ?? ''}\n${e.notes ?? ''}`)?.[0];
  const details = [...new Set([link, e.location?.trim()].filter(Boolean))].join('\n');
  const gentle = reminderMode(e) === 'gentle';
  const minutes = Math.max(1, Math.ceil((start - now) / MINUTE));
  const heading = gentle ? `If you feel like it: ${e.title} at ${time}.` : `${e.title} starts in ${Math.min(stage, minutes)} minutes — ${time}.`;
  const text = gentle ? [heading, details.replaceAll('\n', ' · ')].filter(Boolean).join(' ') : [heading, details, e.notes?.trim()].filter(Boolean).join('\n\n');
  return { title: `${e.title} — ${time}`.slice(0, 120), body: [heading, details, e.notes?.trim()].filter(Boolean).join('\n').slice(0, 2000), text };
}

/** A persisted delivery includes its message and notification, committed together. Restart resends the same phone id. */
export async function startCalendarReminders(deps: Deps): Promise<() => Promise<void>> {
  const person = deps.person(OWNER);
  if (!person || !hostedManager(person) || !person.extensions.includes('calendar')) return async () => {};
  const pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2 });
  await pool.query(`CREATE TABLE IF NOT EXISTS kenan_calendar_reminder (
    owner_id text NOT NULL, series_id text NOT NULL, occurrence_id text NOT NULL, start_at bigint NOT NULL,
    stage integer NOT NULL, message_id uuid NOT NULL, notification jsonb, delivered boolean NOT NULL DEFAULT false,
    PRIMARY KEY(owner_id, occurrence_id, start_at, stage));
    CREATE OR REPLACE FUNCTION kenan_calendar_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('kenan_calendar_changed', json_build_object('owner', OLD.owner_id, 'id', OLD.id)::text);
      ELSIF TG_OP = 'INSERT' OR NEW.data IS DISTINCT FROM OLD.data THEN
        PERFORM pg_notify('kenan_calendar_changed', json_build_object('owner', NEW.owner_id, 'id', NEW.id)::text);
      END IF;
      RETURN NULL;
    END $$;
    DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgname='kenan_calendar_changed' AND tgrelid='public.kenan_calendar'::regclass) THEN
      CREATE TRIGGER kenan_calendar_changed AFTER INSERT OR UPDATE OR DELETE ON public.kenan_calendar FOR EACH ROW EXECUTE FUNCTION kenan_calendar_changed();
    END IF; END $$;`);
  let stopped = false, listener: pg.Client | undefined, reconnect: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<void>>();
  const log = async (error: unknown) => { await deps.store.logError('calendar_reminder', String(error)); };
  const enqueue = (id: string) => {
    const next = (running.get(id) ?? Promise.resolve()).then(() => schedule(id)).catch(async error => {
      await log(error);
      if (!stopped) timers.set(id, setTimeout(() => enqueue(id), 5000));
    });
    running.set(id, next);
    void next.finally(() => { if (running.get(id) === next) running.delete(id); });
  };
  async function send(id: string, item: CalendarItem, stage: number) {
    // Read the event under a lock so a concurrent move/delete wins before delivery, not after an old timer fires.
    const client = await pool.connect();
    let messageId: string | undefined, notification: PhoneNotification | null = null;
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT data FROM public.kenan_calendar WHERE owner_id=$1 AND id=$2 FOR SHARE', [OWNER, id]);
      const event = found.rows[0]?.data as CalendarEvent | undefined;
      const now = deps.now();
      const fresh = event && !event.deleted ? expandEvents([event], { from: now, to: null, max: 64 }).find(e => e.id === item.id && pointInstant(e.start, e.zone) === pointInstant(item.start, item.zone)) : undefined;
      if (!fresh || reminderMode(fresh) === 'none' || stage === 5 && (fresh.acknowledged || reminderMode(fresh) !== 'full')) { await client.query('ROLLBACK'); return; }
      const start = pointInstant(fresh.start, fresh.zone);
      const exists = await client.query('SELECT * FROM kenan_calendar_reminder WHERE owner_id=$1 AND occurrence_id=$2 AND start_at=$3 AND stage=$4', [OWNER, fresh.id, start, stage]);
      if (exists.rows[0]) { await client.query('ROLLBACK'); return; }
      const manager = await deps.store.getAgent(`manager:${OWNER}`);
      if (!manager) throw new Error('Calendar reminder has no manager');
      const zone = await deps.store.zoneOf(OWNER) ?? 'America/Los_Angeles';
      const words = reminderText(fresh, stage, zone, now);
      messageId = randomUUID();
      const saved = await client.query(`WITH c AS (UPDATE conversation SET last_seq=last_seq+1, updated_at=$4 WHERE id=$1 RETURNING last_seq)
        INSERT INTO message(id, conversation_id, seq, author_id, role, display, text, parts, state, created_at, updated_at)
        SELECT $2,$1,c.last_seq,$3,'assistant','shown',$5,$6,'done',$4,$4 FROM c`,
      [CHAT, messageId, manager.id, now, words.text, JSON.stringify([{ type: 'text', text: words.text }])]);
      if (saved.rowCount !== 1) throw new Error('Calendar reminder chat not found');
      if (reminderMode(fresh) === 'full') {
        const quietHeld = (await quietHoursStatus(deps, OWNER)).active;
        const n = (await client.query(`INSERT INTO notification(person_id,agent_id,conversation_id,title,body,level,created_at,quiet_held)
          VALUES($1,$2,$3,$4,$5,'normal',$6,$7) RETURNING *`, [OWNER, manager.id, CHAT, words.title, words.body, now, quietHeld])).rows[0];
        notification = { quietHeld: n.quiet_held, id: Number(n.id), agentId: n.agent_id, conversationId: n.conversation_id, title: n.title, body: n.body, level: n.level, createdAt: Number(n.created_at), imageFileId: null };
      }
      await client.query('INSERT INTO kenan_calendar_reminder(owner_id,series_id,occurrence_id,start_at,stage,message_id,notification) VALUES($1,$2,$3,$4,$5,$6,$7)', [OWNER,id,fresh.id,start,stage,messageId,notification]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (messageId) await publish(messageId, notification);
  }
  async function publish(messageId: string, notification: PhoneNotification | null) {
    const message = await deps.store.getMessage(CHAT, messageId);
    if (message) deps.bus.toConversation(CHAT, { type: 'message', message });
    if (notification) {
      await deliverNotification(deps, OWNER, notification);
    }
    await pool.query('UPDATE kenan_calendar_reminder SET delivered=true WHERE message_id=$1', [messageId]);
  }
  async function schedule(id: string) {
    const old = timers.get(id); if (old) clearTimeout(old); timers.delete(id);
    if (stopped) return;
    const rows = await pool.query('SELECT data FROM public.kenan_calendar WHERE owner_id=$1 AND id=$2', [OWNER,id]);
    const event = rows.rows[0]?.data as CalendarEvent | undefined;
    if (!event || event.deleted || event.type === 'subscription') return;
    const now = deps.now();
    const items = expandEvents([event], { from: now + 1, to: null, max: 64 });
    const done = (await pool.query('SELECT occurrence_id,start_at,stage FROM kenan_calendar_reminder WHERE owner_id=$1 AND series_id=$2', [OWNER,id])).rows;
    let next: { at: number; item: CalendarItem; stage: number } | undefined;
    for (const item of items) {
      const mode = reminderMode(item); if (mode === 'none') continue;
      const start = pointInstant(item.start, item.zone);
      for (const stage of mode === 'gentle' || item.acknowledged ? [30] : [30,5]) {
        if (stage === 30 && mode === 'full' && now >= start - 5 * MINUTE) continue;
        if (done.some(r => r.occurrence_id === item.id && Number(r.start_at) === start && r.stage === stage)) continue;
        const at = Math.max(now, start - stage * MINUTE);
        if (!next || at < next.at) next = { at, item, stage };
      }
    }
    // A long series of excluded occurrences can still have a later occurrence override with reminders enabled.
    if (!next && event.recurrence && items.length === 64) {
      const at = pointInstant(items.at(-1)!.start, event.zone) + 1;
      timers.set(id, setTimeout(() => enqueue(id), Math.min(at - now, 2_147_483_647)));
    } else if (next) {
      const due = next;
      timers.set(id, setTimeout(() => {
        if (deps.now() < due.at) { enqueue(id); return; } // Node timers have a 24.8-day maximum.
        const work = (running.get(id) ?? Promise.resolve()).then(() => send(id,due.item,due.stage));
        running.set(id, work.catch(log));
        void work.finally(() => enqueue(id)).catch(log);
      }, Math.min(Math.max(1, due.at-now), 2_147_483_647)));
    }
  }
  const reload = async () => {
    const rows = await pool.query('SELECT id FROM public.kenan_calendar WHERE owner_id=$1', [OWNER]);
    for (const row of rows.rows) enqueue(row.id);
    for (const pending of (await pool.query('SELECT message_id,notification FROM kenan_calendar_reminder WHERE owner_id=$1 AND NOT delivered', [OWNER])).rows) await publish(pending.message_id, pending.notification);
  };
  const connect = async () => {
    if (stopped) return;
    const client = new pg.Client({ connectionString: deps.config.databaseUrl }); listener = client;
    let lost = false;
    const retry = () => {
      if (lost || stopped) return; lost = true;
      void client.end().catch(log);
      reconnect = setTimeout(() => { void connect().catch(log); }, 1000);
    };
    client.on('error', error => { void log(error); retry(); });
    client.on('end', retry);
    client.on('notification', message => {
      try { const data = JSON.parse(message.payload ?? '{}'); if (data.owner === OWNER && typeof data.id === 'string') enqueue(data.id); } catch (error) { void log(error); }
    });
    try { await client.connect(); await client.query('LISTEN kenan_calendar_changed'); await reload(); } catch (error) { retry(); throw error; }
  };
  await connect().catch(log);
  return async () => {
    stopped = true; if (reconnect) clearTimeout(reconnect);
    for (const timer of timers.values()) clearTimeout(timer);
    await listener?.end(); await Promise.all(running.values()); await pool.end();
  };
}
