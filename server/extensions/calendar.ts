import { pageParameters, pageSize, pageKey, finishPage, type PageRequest } from '../tools/pagination.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Type } from 'typebox';
import type { Extension } from '../types.js';
import { personOf } from '../http/app.js';
import { fail } from '../db/errors.js';
import { expand, occurrenceExists, parseRule, pointInstant, validZone, type Series } from './recurrence.js';

export interface CalendarEvent {
  id: string; title: string; start: string; end: string; zone?: string;
  notes?: string; location?: string; allDay?: boolean; deleted?: boolean;
  subscriptionId?: string | null; createdAt?: number; updatedAt?: number;
  recurrence?: string | null; recurrenceEnd?: string | null; exceptions?: string[]; type?: string; source?: string;
}
export type CalendarItem = CalendarEvent & ({ seriesId?: undefined } | { seriesId: string; occurrence: string });
type Window = { from: number; to: number | null; after?: [number, string]; max: number };

const instantOrFail = (label: string, value: string | null | undefined): number | null => {
  if (value === undefined || value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : fail('invalid_input', `${label} must be an ISO date or time`);
};
const seriesOf = (event: CalendarEvent): Series => event.zone
  ? { start: event.start, end: event.end, zone: event.zone, allDay: Boolean(event.allDay), rule: event.recurrence!, until: event.recurrenceEnd ?? null, exceptions: event.exceptions ?? [] }
  : fail('invalid_input', `Recurring event ${event.id} has no time zone`);
const splitOccurrenceId = (id: string) => { const at = id.indexOf('@'); return at < 0 ? null : { seriesId: id.slice(0, at), key: id.slice(at + 1) }; };

export function expandEvents(events: CalendarEvent[], window: Window): CalendarItem[] {
  const after = (at: number, id: string) => !window.after || at > window.after[0] || at === window.after[0] && id > window.after[1];
  const inWindow = (at: number) => at >= window.from && (window.to === null || at < window.to);
  const items: { at: number; item: CalendarItem }[] = [];
  for (const event of events) {
    if (!event.recurrence) {
      const at = pointInstant(event.start, event.zone);
      if (Number.isFinite(at) && inWindow(at) && after(at, event.id)) items.push({ at, item: event });
      continue;
    }
    const occurrences = expand(seriesOf(event), { from: window.from, to: window.to, after: window.after ? window.after[0] - 1 : undefined, max: window.max });
    if (!occurrences.ok) fail('invalid_input', `Recurring event ${event.id}: ${occurrences.error.message}`);
    else for (const occurrence of occurrences.value) {
      const id = `${event.id}@${occurrence.key}`;
      if (after(occurrence.at, id)) items.push({ at: occurrence.at, item: { ...event, id, seriesId: event.id, occurrence: occurrence.key, start: occurrence.start, end: occurrence.end } });
    }
  }
  return items.sort((a, b) => a.at - b.at || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)).slice(0, window.max).map(entry => entry.item);
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
  const page = async (owner: string, args: PageRequest & { from?: string; to?: string }) => {
    const from = args.from ?? new Date().toISOString().slice(0,10), to = args.to ?? null;
    const start = instantOrFail('from', from)!, end = instantOrFail('to', to);
    if (end !== null && end < start) throw new Error('Valid from/to dates are required');
    const scope = JSON.stringify(['calendar',owner,from,to]), limit = pageSize(args.limit), key = pageKey(args.cursor,scope);
    if (key && (key.length!==2 || typeof key[0]!=='number' || typeof key[1]!=='string')) throw new Error('Invalid calendar cursor');
    const items = expandEvents(await rows(owner), { from: start, to: end, after: key ? [key[0] as number, key[1] as string] : undefined, max: limit + 1 });
    return finishPage(items, limit, scope, item => [pointInstant(item.start, item.zone), item.id]);
  };
  const create = async (owner: string, raw: Partial<CalendarEvent>) => {
    if (!raw.title?.trim() || typeof raw.start !== 'string' || typeof raw.end !== 'string' || !Number.isFinite(pointInstant(raw.start, raw.zone)) || !Number.isFinite(pointInstant(raw.end, raw.zone)) || pointInstant(raw.end, raw.zone) < pointInstant(raw.start, raw.zone)) fail('invalid_input', 'title, start and end are required, with end at or after start');
    if (raw.zone !== undefined && !validZone(raw.zone)) fail('invalid_input', `Unknown time zone ${raw.zone}`);
    const event: CalendarEvent = { id: randomUUID(), title: raw.title!.trim(), start: raw.start!, end: raw.end!, zone: raw.zone, notes: raw.notes ?? '', location: raw.location ?? '', allDay: Boolean(raw.allDay), createdAt: Date.now(), updatedAt: Date.now() };
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
        await client.query('UPDATE kenan_calendar SET data = data || $3::jsonb WHERE owner_id=$1 AND id=$2', [owner, occurrence.seriesId, JSON.stringify({ exceptions, updatedAt: Date.now() })]);
        await client.query('COMMIT');
        return 'occurrence';
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const result = await database().query('DELETE FROM kenan_calendar WHERE owner_id=$1 AND id=$2 RETURNING id', [owner,id]);
    if (!result.rowCount) fail('not_found','Calendar event not found');
    return 'series';
  };
  return { id: 'calendar', name: 'Calendar',
    async start(deps) { pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2 }); await pool.query('CREATE TABLE IF NOT EXISTS kenan_calendar(owner_id text NOT NULL,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(owner_id,id))'); },
    async stop() { await pool?.end(); pool = undefined; },
    routes(app, deps) {
      app.use('*', async (c,next) => { if (!deps.person(personOf(c))?.extensions.includes('calendar')) fail('forbidden','Calendar is not enabled'); await next(); });
      app.get('/', async c => { const from = c.req.query('from'), to = c.req.query('to'); if (!from || !to) fail('invalid_input', 'from and to are required'); return c.json({ ok: true, value: await window(personOf(c), from!, to!) }); });
      app.post('/', async c => c.json({ ok: true, value: await create(personOf(c),await c.req.json()) }));
      app.delete('/:id', async c => c.json({ ok:true,value:await remove(personOf(c),c.req.param('id')) }));
    },
    tool: ctx => ({ name: 'calendar', files: 'none', label:'Calendar',description:'List, create or delete events. List returns {items,nextCursor}, 20 per page (max 50), upcoming first from today, with repeating events expanded into occurrences (id "<seriesId>@<occurrence>", plus seriesId and occurrence). Optional from/to ISO dates (to exclusive); keep these filters when using cursor. Create a repeating series with recurrence (an RRULE such as FREQ=WEEKLY;BYDAY=TU), a zone, and optionally recurrenceEnd; start/end are the first occurrence (a local time like 2026-10-20T18:30 is read in zone). Delete with an occurrence id cancels just that occurrence; delete with a series id removes the whole series.',
      parameters: Type.Object({ ...pageParameters, from:Type.Optional(Type.String()),to:Type.Optional(Type.String()), action: Type.Union(['list','create','delete'].map(value => Type.Literal(value))), id:Type.Optional(Type.String()), title:Type.Optional(Type.String()),start:Type.Optional(Type.String()),end:Type.Optional(Type.String()),zone:Type.Optional(Type.String()),notes:Type.Optional(Type.String()),location:Type.Optional(Type.String()),allDay:Type.Optional(Type.Boolean()), recurrence:Type.Optional(Type.String({description:'RRULE, e.g. FREQ=WEEKLY;BYDAY=TU'})), recurrenceEnd:Type.Optional(Type.String({description:'ISO time of the last allowed occurrence start'})) }),
      execute: async (_id,raw:unknown) => { const args=raw as Partial<CalendarEvent> & PageRequest & {action:string;from?:string;to?:string}; let value:unknown; if(args.action==='list') value=await page(ctx.person.id,args); else if(args.action==='create') value=await create(ctx.person.id,args); else { if(!args.id) throw new Error('id required'); value=(await remove(ctx.person.id,args.id))==='occurrence'?'Cancelled that occurrence':'Deleted'; } return { content:[{type:'text',text:JSON.stringify(value)}],details:{} }; },
    }),
  };
}
export const calendarExtension = createCalendarExtension();
