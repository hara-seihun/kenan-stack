import { pageParameters, pageSize, pageKey, finishPage, type PageRequest } from '../tools/pagination.js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Type } from 'typebox';
import type { Extension } from '../types.js';
import { personOf } from '../http/app.js';
import { fail } from '../db/errors.js';
import { expand, instantOf, occurrenceAt, occurrenceExists, parseRule, pointInstant, type Series } from './recurrence.js';
import { validZone, zoneOrHome } from '../../shared/zone.js';

/** One occurrence's own times, display fields, reminder preference, attendance and acknowledgement. */
export type OccurrenceEdit = Pick<CalendarEvent, 'start' | 'end'> & Partial<Pick<CalendarEvent, 'title' | 'notes' | 'location' | 'color' | 'allDay' | 'remind' | 'attending' | 'declined' | 'acknowledged'>>;
export interface CalendarEvent {
  id: string; title: string; start: string; end: string; zone?: string;
  notes?: string; location?: string; allDay?: boolean; deleted?: boolean; color?: string | null;
  remind?: 'none' | 'gentle' | 'full'; attending?: boolean; declined?: boolean; acknowledged?: boolean;
  subscriptionId?: string | null; createdAt?: number; updatedAt?: number;
  recurrence?: string | null; recurrenceEnd?: string | null; exceptions?: string[]; overrides?: Record<string, OccurrenceEdit>; type?: string; source?: string;
}
export type CalendarItem = CalendarEvent & ({ seriesId?: undefined } | { seriesId: string; occurrence: string });
/** Occurrences start in [from, to); with `endsAfter`, only those still running or upcoming then (end after it). */
type Window = { from: number; to: number | null; after?: [number, string]; max: number; endsAfter?: number };

const instantOrFail = (label: string, value: string | null | undefined): number | null => {
  if (value === undefined || value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : fail('invalid_input', `${label} must be an ISO date or time`);
};
const seriesOf = (event: CalendarEvent): Series => event.zone
  ? { start: event.start, end: event.end, zone: event.zone, allDay: Boolean(event.allDay), rule: event.recurrence!, until: event.recurrenceEnd ?? null, exceptions: [...(event.exceptions ?? []), ...Object.keys(event.overrides ?? {})] }
  : fail('invalid_input', `Recurring event ${event.id} has no time zone`);
const splitOccurrenceId = (id: string) => { const at = id.indexOf('@'); return at < 0 ? null : { seriesId: id.slice(0, at), key: id.slice(at + 1) }; };
const withoutOverrides = ({ overrides: _overrides, ...event }: CalendarEvent) => event;
const occurrenceItem = (event: CalendarEvent, key: string, fields: Partial<CalendarEvent>): CalendarItem =>
  ({ ...withoutOverrides(event), ...fields, id: `${event.id}@${key}`, seriesId: event.id, occurrence: key });
const checkSpan = (start: string, end: string, zone: string | undefined) => {
  if (!Number.isFinite(pointInstant(start, zone)) || !Number.isFinite(pointInstant(end, zone)) || pointInstant(end, zone) < pointInstant(start, zone)) fail('invalid_input', 'start and end are required, with end at or after start');
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** When an event or occurrence is over: its end instant; an all-day one at local midnight after its last day (in its
 *  zone), a zero-length all-day one at the end of its day. */
export function endInstant(item: Pick<CalendarEvent, 'start' | 'end' | 'zone' | 'allDay'>): number {
  const date = item.allDay ? DATE_ONLY.exec(item.end) : null;
  if (!date) return pointInstant(item.end, item.zone);
  const midnight = (value: string) => { const [y, m, d] = value.split('-').map(Number) as [number, number, number]; return instantOf({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, item.zone ?? 'UTC'); };
  const start = DATE_ONLY.test(item.start) ? midnight(item.start) : pointInstant(item.start, item.zone);
  return Math.max(midnight(item.end), start + 86_400_000);
}

export function expandEvents(events: CalendarEvent[], window: Window): CalendarItem[] {
  const after = (at: number, id: string) => !window.after || at > window.after[0] || at === window.after[0] && id > window.after[1];
  const inWindow = (at: number) => at >= window.from && (window.to === null || at < window.to);
  const running = (item: CalendarItem) => window.endsAfter === undefined || endInstant(item) > window.endsAfter;
  const items: { at: number; item: CalendarItem }[] = [];
  for (const event of events) {
    if (!event.recurrence) {
      const at = pointInstant(event.start, event.zone);
      if (Number.isFinite(at) && inWindow(at) && after(at, event.id) && running(event)) items.push({ at, item: event });
      continue;
    }
    // Skip expanding occurrences that are surely over (started more than the series' length plus a DST hour ago), so
    // `max` counts only ones that can still show.
    const length = endInstant(event) - pointInstant(event.start, event.zone);
    const from = window.endsAfter === undefined ? window.from : Math.max(window.from, window.endsAfter - length - 3_600_000);
    const occurrences = expand(seriesOf(event), { from, to: window.to, after: window.after ? window.after[0] - 1 : undefined, max: window.max });
    if (!occurrences.ok) fail('invalid_input', `Recurring event ${event.id}: ${occurrences.error.message}`);
    else for (const occurrence of occurrences.value) {
      const id = `${event.id}@${occurrence.key}`;
      const item = occurrenceItem(event, occurrence.key, { start: occurrence.start, end: occurrence.end });
      if (after(occurrence.at, id) && running(item)) items.push({ at: occurrence.at, item });
    }
    for (const [key, edit] of Object.entries(event.overrides ?? {})) {
      const at = pointInstant(edit.start, event.zone), id = `${event.id}@${key}`;
      const item = occurrenceItem(event, key, edit);
      if (Number.isFinite(at) && inWindow(at) && after(at, id) && running(item)) items.push({ at, item });
    }
  }
  return items.sort((a, b) => a.at - b.at || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)).slice(0, window.max).map(entry => entry.item);
}

/** How far back an upcoming list looks for events still running now (a multi-day trip that began earlier). */
const UPCOMING_LOOKBACK_MS = 62 * 86_400_000;

/** Turn the booking form into a compact meeting brief, without Cal.com's internal fields. */
export function calcomNotes(p: Record<string, any>): string {
  const attendees = Array.isArray(p.attendees) ? p.attendees.map((a: any) => {
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    const email = typeof a.email === 'string' ? a.email.trim() : '';
    return name && email ? `${name} <${email}>` : name || email;
  }).filter(Boolean).join(', ') : '';
  const lines: string[] = attendees ? [`Attendees: ${attendees}`] : [];
  const seen = new Set<string>();
  const add = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).join(', ') : '';
    if (!text || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    lines.push(`${label}: ${text}`);
  };
  const skipped = new Set(['name', 'email', 'attendeephonenumber', 'location', 'title', 'guests', 'reschedulereason']);
  for (const obj of [p.responses, p.userFieldsResponses]) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, raw] of Object.entries(obj)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (skipped.has(normalized)) continue;
      const field = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (field?.isHidden === true) continue;
      const value = field ? field.value : raw;
      const label = normalized === 'company' ? 'Company' : normalized === 'reason' || normalized === 'purpose' ? 'Purpose' : normalized === 'notes' || normalized === 'additionalnotes' ? 'Notes' : typeof field?.label === 'string' && field.label.trim() ? field.label.trim() : key;
      add(label, value);
    }
  }
  add('Notes', p.additionalNotes);
  if (typeof p.metadata?.videoCallUrl === 'string') add('Video', p.metadata.videoCallUrl);
  return lines.join('\n');
}

export function createCalendarExtension(): Extension {
  let pool: pg.Pool | undefined;
  const database = () => { if (!pool) throw new Error('Calendar is not started'); return pool; };
  const rows = async (owner: string) => {
    const result = await database().query(`SELECT data FROM kenan_calendar WHERE owner_id=$1
      AND coalesce(data->>'type','') <> 'subscription' AND coalesce(data->>'deleted','false') <> 'true'`, [owner]);
    return result.rows.map(row => row.data as CalendarEvent);
  };
  const window = async (owner: string, from: string, to: string) => {
    const start = instantOrFail('from', from)!, end = instantOrFail('to', to)!;
    if (end < start) fail('invalid_input', 'to must be at or after from');
    return expandEvents(await rows(owner), { from: start, to: end, max: 5000 });
  };
  /** One page of events by start. Without `from`, the upcoming ones: still running or yet to come at `now` (an event
   *  stays until its end has passed); past events stay stored and are listed when `from` is given. */
  const page = async (owner: string, args: PageRequest & { from?: string; to?: string }, now: number) => {
    const upcoming = args.from === undefined, to = args.to ?? null;
    const start = upcoming ? now - UPCOMING_LOOKBACK_MS : instantOrFail('from', args.from)!, end = instantOrFail('to', to);
    if (end !== null && end < start) throw new Error('Valid from/to dates are required');
    const scope = JSON.stringify(['calendar',owner,upcoming ? 'upcoming' : args.from,to]), limit = pageSize(args.limit), key = pageKey(args.cursor,scope);
    if (key && (key.length!==2 || typeof key[0]!=='number' || typeof key[1]!=='string')) throw new Error('Invalid calendar cursor');
    const items = expandEvents(await rows(owner), { from: start, to: end, after: key ? [key[0] as number, key[1] as string] : undefined, max: limit + 1, endsAfter: upcoming ? now : undefined });
    return finishPage(items, limit, scope, item => [pointInstant(item.start, item.zone), item.id]);
  };
  const colorOf = (raw: unknown): string | null => raw === undefined || raw === null ? null : typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : fail('invalid_input', 'color must be #RRGGBB');
  const reminderFields = (raw: Partial<CalendarEvent>): Partial<Pick<CalendarEvent, 'remind' | 'attending' | 'declined' | 'acknowledged'>> => {
    const fields: Partial<Pick<CalendarEvent, 'remind' | 'attending' | 'declined' | 'acknowledged'>> = {};
    if (raw.remind !== undefined) {
      if (!['none', 'gentle', 'full'].includes(raw.remind)) fail('invalid_input', 'remind must be none, gentle or full');
      fields.remind = raw.remind;
    }
    for (const key of ['attending', 'declined', 'acknowledged'] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'boolean') fail('invalid_input', `${key} must be a boolean`);
      fields[key] = raw[key];
    }
    return fields;
  };
  const create = async (owner: string, raw: Partial<CalendarEvent>) => {
    if (!raw.title?.trim() || typeof raw.start !== 'string' || typeof raw.end !== 'string' || !Number.isFinite(pointInstant(raw.start, raw.zone)) || !Number.isFinite(pointInstant(raw.end, raw.zone)) || pointInstant(raw.end, raw.zone) < pointInstant(raw.start, raw.zone)) fail('invalid_input', 'title, start and end are required, with end at or after start');
    if (raw.zone !== undefined && !validZone(raw.zone)) fail('invalid_input', `Unknown time zone ${raw.zone}`);
    const event: CalendarEvent = { id: randomUUID(), title: raw.title!.trim(), start: raw.start!, end: raw.end!, zone: raw.zone, notes: raw.notes ?? '', location: raw.location ?? '', allDay: Boolean(raw.allDay), color: colorOf(raw.color), ...reminderFields(raw), createdAt: Date.now(), updatedAt: Date.now() };
    if (raw.recurrence) {
      const rule = parseRule(raw.recurrence);
      if (!rule.ok) fail('invalid_input', rule.error.message);
      else if (!raw.zone) fail('invalid_input', 'A repeating event needs zone (an IANA time zone) so occurrences keep their local time across daylight saving');
      else {
        instantOrFail('recurrenceEnd', raw.recurrenceEnd);
        Object.assign(event, { recurrence: rule.value, recurrenceEnd: raw.recurrenceEnd ?? null, exceptions: [] });
        const probe = expand(seriesOf(event), { from: -8.64e15, to: null, max: 1 });
        if (!probe.ok) fail('invalid_input', probe.error.message);
      }
    } else if (raw.recurrenceEnd) fail('invalid_input', 'recurrenceEnd needs recurrence');
    await database().query('INSERT INTO kenan_calendar(owner_id,id,data) VALUES($1,$2,$3)', [owner,event.id,event]);
    return event;
  };
  const remove = async (owner: string, id: string): Promise<'series' | 'occurrence'> => {
    const occurrence = splitOccurrenceId(id);
    if (occurrence) {
      const client = await database().connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT data FROM kenan_calendar WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, occurrence.seriesId]);
        const event = found.rows[0]?.data as CalendarEvent | undefined;
        if (!event || event.deleted || !event.recurrence) fail('not_found', 'Repeating calendar event not found');
        if (!occurrenceExists(seriesOf(event!), occurrence.key)) fail('not_found', `${occurrence.key} is not an occurrence of this series`);
        const exceptions = [...new Set([...(event!.exceptions ?? []), occurrence.key])].sort();
        const { [occurrence.key]: _edit, ...overrides } = event!.overrides ?? {};
        await client.query('UPDATE kenan_calendar SET data=$3 WHERE owner_id=$1 AND id=$2', [owner, occurrence.seriesId, { ...event, exceptions, overrides, updatedAt: Date.now() }]);
        await client.query('COMMIT');
        return 'occurrence';
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const result = await database().query(`UPDATE kenan_calendar SET data = data || jsonb_build_object('deleted', true, 'updatedAt', $3::bigint) WHERE owner_id=$1 AND id=$2 AND coalesce(data->>'deleted','false') <> 'true' RETURNING id`, [owner, id, Date.now()]);
    if (!result.rowCount) fail('not_found','Calendar event not found');
    return 'series';
  };
  /** Undo a delete: a deleted event comes back; a cancelled occurrence of a series is scheduled again. */
  const restore = async (owner: string, id: string): Promise<CalendarEvent> => {
    const occurrence = splitOccurrenceId(id), seriesId = occurrence?.seriesId ?? id;
    const found = await database().query('SELECT data FROM kenan_calendar WHERE owner_id=$1 AND id=$2', [owner, seriesId]);
    const event = found.rows[0]?.data as CalendarEvent | undefined;
    if (!event || event.type === 'subscription') return fail('not_found', 'Calendar event not found');
    const next: CalendarEvent = occurrence ? { ...event, exceptions: (event.exceptions ?? []).filter(key => key !== occurrence.key), updatedAt: Date.now() } : { ...event, deleted: false, updatedAt: Date.now() };
    await database().query('UPDATE kenan_calendar SET data=$3 WHERE owner_id=$1 AND id=$2', [owner, seriesId, next]);
    return next;
  };
  const patchOf = (raw: Partial<CalendarEvent>): Partial<CalendarEvent> => {
    const text = (key: 'notes' | 'location') => raw[key] === undefined ? undefined : typeof raw[key] === 'string' ? raw[key] : fail('invalid_input', `${key} must be text`);
    const title = raw.title === undefined ? undefined : typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fail('invalid_input', 'title must be text and not empty');
    const patch = { ...reminderFields(raw), title, notes: text('notes'), location: text('location'), start: raw.start, end: raw.end, zone: raw.zone,
      allDay: raw.allDay === undefined ? undefined : Boolean(raw.allDay), color: raw.color === undefined ? undefined : colorOf(raw.color) };
    return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<CalendarEvent>;
  };
  /** Edit one occurrence of a series: it keeps its id and gets its own times and fields (an override). */
  const editOccurrence = async (owner: string, { seriesId, key }: { seriesId: string; key: string }, raw: Partial<CalendarEvent>): Promise<CalendarItem> => {
    if (raw.zone !== undefined || raw.recurrence !== undefined || raw.recurrenceEnd !== undefined) fail('invalid_input', 'The time zone and repeat rule belong to the whole series: edit the series id');
    const client = await database().connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT data FROM kenan_calendar WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, seriesId]);
      const event = found.rows[0]?.data as CalendarEvent | undefined;
      if (!event || event.deleted || !event.recurrence) fail('not_found', 'Repeating calendar event not found');
      if (event!.exceptions?.includes(key)) fail('not_found', 'That occurrence was cancelled');
      const base = occurrenceAt(seriesOf(event!), key) ?? fail('not_found', `${key} is not an occurrence of this series`);
      const current: OccurrenceEdit = event!.overrides?.[key] ?? { start: base.start, end: base.end };
      const next: OccurrenceEdit = { ...current, ...patchOf(raw) };
      checkSpan(next.start, next.end, event!.zone);
      await client.query('UPDATE kenan_calendar SET data=$3 WHERE owner_id=$1 AND id=$2', [owner, seriesId, { ...event, overrides: { ...event!.overrides, [key]: next }, updatedAt: Date.now() }]);
      await client.query('COMMIT');
      return occurrenceItem(event!, key, next);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  /** Edit an event, or a whole repeating series (its times, zone and repeat rule included) when given the series id, or one occurrence when given an occurrence id. */
  const update = async (owner: string, id: string, raw: Partial<CalendarEvent>): Promise<CalendarEvent | CalendarItem> => {
    const occurrence = splitOccurrenceId(id);
    if (occurrence) return editOccurrence(owner, { seriesId: occurrence.seriesId, key: occurrence.key }, raw);
    const found = await database().query('SELECT data FROM kenan_calendar WHERE owner_id=$1 AND id=$2', [owner, id]);
    const event = found.rows[0]?.data as CalendarEvent | undefined;
    if (!event || event.deleted || event.type === 'subscription') return fail('not_found', 'Calendar event not found');
    if (!event.recurrence && (raw.recurrence !== undefined || raw.recurrenceEnd !== undefined)) fail('invalid_input', 'Only a repeating event has a repeat rule; create a repeating event instead');
    const next: CalendarEvent = { ...event, ...patchOf(raw), updatedAt: Date.now() };
    if (next.zone !== undefined && !validZone(next.zone)) fail('invalid_input', `Unknown time zone ${next.zone}`);
    checkSpan(next.start, next.end, next.zone);
    if (event.recurrence) {
      if (typeof raw.recurrence === 'string') { const rule = parseRule(raw.recurrence); next.recurrence = rule.ok ? rule.value : fail('invalid_input', rule.error.message); }
      else if (raw.recurrence !== undefined) fail('invalid_input', 'recurrence must be an RRULE');
      if (raw.recurrenceEnd !== undefined) { instantOrFail('recurrenceEnd', raw.recurrenceEnd); next.recurrenceEnd = raw.recurrenceEnd; }
      const probe = expand(seriesOf(next), { from: -8.64e15, to: null, max: 1 });
      if (!probe.ok) fail('invalid_input', probe.error.message);
      // Occurrence edits stay only where their occurrence still exists; a moved zone reads the old instants, so it drops them all.
      const series = seriesOf(next);
      next.overrides = next.zone === event.zone ? Object.fromEntries(Object.entries(event.overrides ?? {}).filter(([key]) => occurrenceExists(series, key))) : {};
    }
    await database().query('UPDATE kenan_calendar SET data=$3 WHERE owner_id=$1 AND id=$2', [owner, id, next]);
    return next;
  };
  return { id: 'calendar', name: 'Calendar',
    promptSnippet: 'Calendar reminders are automatic for Alice: a phone alert and your chat reminder 30 minutes before each timed event, then both again 5 minutes before if unacknowledged. Do not schedule manual wakes for these. All-day, Option:, declined and attending:false events are skipped. remind:none disables reminders; remind:gentle sends one optional chat line without a push; remind:full sends both alerts. Dessert nights and dinners default to gentle. Set attending:false for events she does not attend, and remind:gentle for optional recurring social events. When Alice acknowledges an event reminder, update that event (the occurrence id for a series) with acknowledged:true; do not acknowledge a whole series for one occurrence. Acknowledgement suppresses only the five-minute follow-up. When rescheduling an acknowledged event, set acknowledged:false if she needs fresh follow-up.',
    async start(deps) { pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2 }); await pool.query('CREATE TABLE IF NOT EXISTS kenan_calendar(owner_id text NOT NULL,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(owner_id,id))'); },
    async stop() { await pool?.end(); pool = undefined; },
    hooks(app, deps) {
      const config = async () => {
        try {
          const raw = JSON.parse(await readFile(process.env.KENAN_CALCOM_CONFIG ?? '/etc/kenan/calcom.json', 'utf8')) as { owner?: string; busyToken?: string; webhookSecret?: string };
          return raw.owner && raw.busyToken && raw.webhookSecret && deps.person(raw.owner)?.extensions.includes('calendar') ? raw : null;
        } catch { return null; }
      };
      const equal = (a: string, b: string) => {
        const x = Buffer.from(a), y = Buffer.from(b);
        return x.length === y.length && timingSafeEqual(x, y);
      };
      app.get('/calcom/busy/:token', async c => {
        const settings = await config();
        if (!settings || !equal(c.req.param('token'), `${settings.busyToken}.ics`)) return c.notFound();
        const now = Date.now(), from = now - UPCOMING_LOOKBACK_MS, to = now + 730 * 86_400_000;
        const events = expandEvents(await rows(settings.owner!), { from, to, max: 100000, endsAfter: now });
        const stamp = (time: number) => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kenan//Busy calendar//EN', 'CALSCALE:GREGORIAN'];
        for (const e of events) {
          const start = pointInstant(e.start, e.zone), end = endInstant(e);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
          const uid = createHash('sha256').update(e.id).digest('hex');
          lines.push('BEGIN:VEVENT', `UID:${uid}@kenan`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, 'SUMMARY:Busy', 'TRANSP:OPAQUE', 'END:VEVENT');
        }
        lines.push('END:VCALENDAR', '');
        c.header('Cache-Control', 'no-store');
        return c.body(lines.join('\r\n'), 200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      });
      app.post('/calcom/webhook', async c => {
        const settings = await config();
        if (!settings) return c.notFound();
        const body = Buffer.from(await c.req.arrayBuffer());
        if (body.length > 262144) return c.text('Payload too large', 413);
        const signature = c.req.header('x-cal-signature-256') ?? '';
        if (!equal(signature, createHmac('sha256', settings.webhookSecret!).update(body).digest('hex'))) return c.text('Unauthorized', 401);
        let input: { triggerEvent?: string; createdAt?: string; payload?: Record<string, any> };
        try { input = JSON.parse(body.toString('utf8')); } catch { return c.text('Invalid JSON', 400); }
        const p = input.payload, trigger = input.triggerEvent, at = Date.parse(input.createdAt ?? '');
        if (!p || !['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'].includes(trigger ?? '') || typeof p.uid !== 'string' || !p.uid || !Number.isFinite(at)) return c.text('Invalid booking', 400);
        if (trigger !== 'BOOKING_CANCELLED' && (typeof p.startTime !== 'string' || typeof p.endTime !== 'string' || !Number.isFinite(Date.parse(p.startTime)) || !Number.isFinite(Date.parse(p.endTime)) || Date.parse(p.endTime) <= Date.parse(p.startTime))) return c.text('Invalid booking times', 400);
        const idOf = (uid: string) => 'calcom-' + createHash('sha256').update(uid).digest('hex');
        const id = idOf(p.uid), deleted = trigger === 'BOOKING_CANCELLED';
        const video = typeof p.metadata?.videoCallUrl === 'string' ? p.metadata.videoCallUrl : '';
        const notes = calcomNotes(p);
        const zone = zoneOrHome(await deps.store.zoneOf(settings.owner!));
        const event = { id, title: typeof p.title === 'string' && p.title.trim() ? p.title : 'Meeting', start: p.startTime ?? new Date(at).toISOString(), end: p.endTime ?? new Date(at).toISOString(), zone, notes, location: video || (typeof p.location === 'string' ? p.location : ''), source: 'calcom', deleted, createdAt: at, updatedAt: Date.now(), calcomAt: at, calcomCancelled: deleted };
        const client = await database().connect();
        try {
          await client.query('BEGIN');
          const save = async (entry: typeof event) => client.query(`INSERT INTO kenan_calendar(owner_id,id,data) VALUES($1,$2,$3)
            ON CONFLICT(owner_id,id) DO UPDATE SET data=EXCLUDED.data ||
              (SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(kenan_calendar.data)
               WHERE key IN ('remind','attending','declined','acknowledged'))
            WHERE coalesce((kenan_calendar.data->>'calcomAt')::bigint,0) < $4
              OR (coalesce((kenan_calendar.data->>'calcomAt')::bigint,0) = $4 AND $5 AND coalesce((kenan_calendar.data->>'calcomCancelled')::boolean,false) = false)`, [settings.owner, entry.id, entry, at, entry.deleted]);
          if (trigger === 'BOOKING_RESCHEDULED' && typeof p.rescheduleUid === 'string' && p.rescheduleUid !== p.uid) await save({ ...event, id: idOf(p.rescheduleUid), deleted: true, calcomCancelled: true });
          await save(event);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return c.json({ ok: true });
      });
    },
    routes(app, deps) {
      app.use('*', async (c,next) => { if (!deps.person(personOf(c))?.extensions.includes('calendar')) fail('forbidden','Calendar is not enabled'); await next(); });
      app.get('/', async c => { const from = c.req.query('from'), to = c.req.query('to'); if (!from || !to) fail('invalid_input', 'from and to are required'); return c.json({ ok: true, value: await window(personOf(c), from!, to!) }); });
      app.post('/', async c => c.json({ ok: true, value: await create(personOf(c),await c.req.json()) }));
      app.patch('/:id', async c => c.json({ ok: true, value: await update(personOf(c), c.req.param('id'), await c.req.json()) }));
      app.delete('/:id', async c => c.json({ ok:true,value:await remove(personOf(c),c.req.param('id')) }));
      app.post('/:id/restore', async c => c.json({ ok: true, value: await restore(personOf(c), c.req.param('id')) }));
    },
    tool: ctx => ({ name: 'calendar', files: 'none', records: 'none', label:'Calendar',description:'List, create, edit, move, delete or restore events (the same calendar the app shows and she drags around). List returns {items,nextCursor}, 20 per page (max 50), upcoming first: by default only events not over yet (their end is after now; past ones stay stored, give from to list them), with repeating events expanded into occurrences (id "<seriesId>@<occurrence>", plus seriesId and occurrence). Optional from/to ISO dates (to exclusive); keep these filters when using cursor. Create a repeating series with recurrence (an RRULE such as FREQ=WEEKLY;BYDAY=TU), a zone, and optionally recurrenceEnd; start/end are the first occurrence (a local time like 2026-10-20T18:30 is read in zone). A new event without zone gets her current time zone and keeps it, so it stays at that instant when she travels. Delete with an occurrence id cancels just that occurrence; delete with a series id removes the whole series. update: id + any of title, start, end, zone, allDay, notes, location, color, remind, attending, declined, acknowledged; an occurrence id changes only that occurrence, and a series id changes the whole series (its repeat rule and recurrenceEnd too). restore: id undoes a delete (an occurrence id puts that occurrence back). color is #RRGGBB or null. remind selects none, gentle or full reminders. attending:false or declined:true skips reminders. acknowledged:true records her explicit acknowledgement and suppresses follow-up reminders for that event or occurrence; use an occurrence id to acknowledge only that occurrence.',
      parameters: Type.Object({ ...pageParameters, from:Type.Optional(Type.String()),to:Type.Optional(Type.String()), action: Type.Union(['list','create','update','delete','restore'].map(value => Type.Literal(value))), color:Type.Optional(Type.Union([Type.String(),Type.Null()])), id:Type.Optional(Type.String()), title:Type.Optional(Type.String()),start:Type.Optional(Type.String()),end:Type.Optional(Type.String()),zone:Type.Optional(Type.String()),notes:Type.Optional(Type.String()),location:Type.Optional(Type.String()),allDay:Type.Optional(Type.Boolean()), remind:Type.Optional(Type.Union(['none','gentle','full'].map(value => Type.Literal(value)), {description:'Reminder level: none, gentle or full'})), attending:Type.Optional(Type.Boolean({description:'False skips reminders for this event or occurrence'})), declined:Type.Optional(Type.Boolean({description:'True skips reminders for this event or occurrence'})), acknowledged:Type.Optional(Type.Boolean({description:'Her explicit acknowledgement of the reminder; true suppresses follow-up for this event or occurrence'})), recurrence:Type.Optional(Type.String({description:'RRULE, e.g. FREQ=WEEKLY;BYDAY=TU'})), recurrenceEnd:Type.Optional(Type.String({description:'ISO time of the last allowed occurrence start'})) }),
      execute: async (_id,raw:unknown) => { const args=raw as Partial<CalendarEvent> & PageRequest & {action:string;from?:string;to?:string}; let value:unknown; const zone = async () => zoneOrHome(await ctx.deps.store.zoneOf(ctx.person.id)); if(args.action==='list') value=await page(ctx.person.id, args, Date.now()); else if(args.action==='create') value=await create(ctx.person.id,{ ...args, zone: args.zone ?? await zone() }); else if(args.action==='update') { const { action:_a, id, cursor:_c, limit:_l, from:_f, to:_t, ...patch } = args; value=await update(ctx.person.id, id ?? fail('invalid_input','update needs id'), patch); } else if(args.action==='restore') value=await restore(ctx.person.id, args.id ?? fail('invalid_input','restore needs id')); else { if(!args.id) throw new Error('id required'); value=(await remove(ctx.person.id,args.id))==='occurrence'?'Cancelled that occurrence':'Deleted'; } return { content:[{type:'text',text:JSON.stringify(value)}],details:{} }; },
    }),
  };
}
export const calendarExtension = createCalendarExtension();
