import { describe, expect, it } from 'vitest';
import type { UsagePlan } from '../shared/contract.js';
import { metricName, nextRefill, planSummary } from './usageSummary.js';

const plan = (percentLeft: number | null, resets: (number | null)[]): UsagePlan => ({
  provider: 'anthropic', metric: 'weekly', percentLeft, projection: { state: 'unmeasured' },
  accounts: resets.map((resetAt, i) => ({ accountId: `a${i}`, resetAt } as unknown as UsagePlan['accounts'][number])),
});

describe('usage summary', () => {
  it('names metrics plainly', () => { expect(metricName('five-hour')).toBe('5-hour'); expect(metricName('weekly')).toBe('Weekly'); });
  it('finds the soonest future reset', () => { expect(nextRefill(plan(17, [500, 200, 50, null]), 100)).toBe(200); });
  it('says what is left and when the next account refills', () => {
    expect(planSummary(plan(16.8, [300]), 100, t => `T${t}`)).toBe('17% left · next account refills T300');
    expect(planSummary(plan(null, []), 100, String)).toBe('Unknown');
  });
});
