import { describe, expect, it } from 'vitest';
import { expandEvents, type CalendarEvent } from './calendar.js';
import { occurrenceExists, parseRule } from './recurrence.js';

const tuesday: CalendarEvent = { id: 'seq', title: 'Sequences', start: '2026-10-20T18:30', end: '2026-10-20T21:30', zone: 'America/Los_Angeles', recurrence: 'FREQ=WEEKLY;BYDAY=TU', recurrenceEnd: null, exceptions: ['2026-10-27T18:30:00'] };
const single: CalendarEvent = { id: 'one', title: 'One-off', start: '2026-11-03T10:00:00-08:00', end: '2026-11-03T11:00:00-08:00' };
const window = { from: Date.parse('2026-10-19T00:00:00Z'), to: Date.parse('2026-11-20T00:00:00Z'), max: 50 };

describe('calendar recurrence', () => {
  it('keeps local time across daylight saving, skips cancelled occurrences, and merges with single events', () => {
    const items = expandEvents([tuesday, single], window);
    expect(items.map(item => item.start)).toEqual(['2026-10-20T18:30:00-07:00', '2026-11-03T10:00:00-08:00', '2026-11-03T18:30:00-08:00', '2026-11-10T18:30:00-08:00', '2026-11-17T18:30:00-08:00']);
    expect(items[2]).toMatchObject({ id: 'seq@2026-11-03T18:30:00', seriesId: 'seq', end: '2026-11-03T21:30:00-08:00' });
  });
  it('pages through occurrences after a cursor without repeats', () => {
    const first = expandEvents([tuesday, single], { ...window, max: 2 });
    const last = first[first.length - 1]!;
    const rest = expandEvents([tuesday, single], { ...window, after: [Date.parse(last.start), last.id], max: 50 });
    expect([...first, ...rest].map(item => item.id)).toEqual(expandEvents([tuesday, single], window).map(item => item.id));
  });
  it('rejects unknown rules and recognises real occurrences only', () => {
    expect(parseRule('BYDAY=TU').ok).toBe(false);
    expect(parseRule('FREQ=SOMETIMES').ok).toBe(false);
    const series = { start: tuesday.start, end: tuesday.end, zone: tuesday.zone!, allDay: false, rule: tuesday.recurrence!, until: null, exceptions: [] };
    expect(occurrenceExists(series, '2026-10-27T18:30:00')).toBe(true);
    expect(occurrenceExists(series, '2026-10-28T18:30:00')).toBe(false);
  });
});
