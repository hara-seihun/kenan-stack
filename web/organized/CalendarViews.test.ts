import { describe, expect, it } from 'vitest';
import { MAX_HOUR_PX, MIN_HOUR_PX, clampZoom, rangeOf } from './CalendarViews.js';

describe('calendar views', () => {
  it('weeks start on Monday and a month shows whole weeks around it', () => {
    const week = rangeOf('week', new Date(2026, 9, 21));
    expect([week.from.getDay(), week.from.getDate(), week.to.getDate()]).toEqual([1, 19, 26]);
    const month = rangeOf('month', new Date(2026, 9, 21));
    expect([month.from.toDateString(), month.to.toDateString()]).toEqual([new Date(2026, 8, 28).toDateString(), new Date(2026, 10, 2).toDateString()]);
  });
  it('pinch zoom stays within the hour scale limits', () => {
    expect([clampZoom(1), clampZoom(500), clampZoom(60)]).toEqual([MIN_HOUR_PX, MAX_HOUR_PX, 60]);
  });
});
