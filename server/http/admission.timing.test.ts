// A wall-clock bound: vitest.config.ts runs *.timing.test.ts files alone, after every other suite, so CPU contention can't skew them.
//
// The bound is on the app's own work between receiving a message and admitting it. Its database sessions commit
// without waiting for the WAL flush (synchronous_commit=off): that flush is the disk's fdatasync of the WAL the whole
// cluster shares (both channels, every concurrent test run), and on a loaded host with a network disk it alone made the
// tail (Acme 2026-10-21, load 42 on 16 cores: admission p99 36–71 ms with durable commits, 8–15 ms without, the same
// with or without this test's own writers). What the app controls about that flush is how many it waits for, and that
// is pinned exactly: a human message is admitted by one statement, so production waits for one durable commit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Message } from '../../shared/contract.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { startTestApp, type TestApp } from './test-app.js';

const WARM_UP = 20, MEASURED = 200;

describe.skipIf(!testDatabaseUrl)('human message admission latency', () => {
  let fx: TestApp;
  beforeAll(async () => { fx = await startTestApp('t_admit', { synchronous_commit: 'off' }); });
  afterAll(async () => { await fx?.close(); });

  const send = (i: number) => fx.call<Message>('POST', `/api/conversations/${fx.managerConversationId}/messages`, { clientId: `timing-${i}`, text: `ping ${i}`, fileIds: [], clientSentAt: Date.now() });

  it('admits a human message with one database statement', async () => {
    const statements: string[] = [];
    const query = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      if (typeof args[0] === 'string') statements.push(args[0]);
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof query;
    try { expect((await send(-1)).status).toBe(200); }
    finally { pg.Client.prototype.query = query; }
    expect(statements.filter(s => !s.startsWith('INSERT INTO latency'))).toHaveLength(1);
  });

  it('admits a human message (receive → admit) in under 10 ms, also while other writers commit', async () => {
    for (let i = 0; i < WARM_UP; i++) expect((await send(i)).status).toBe(200);
    const durations: number[] = [];
    // Other durable writers (agent turns, tool records, wakes) commit all the time; admission must not queue behind them.
    let loading = true;
    const writers = Array.from({ length: 4 }, async () => { while (loading) await fx.store.logError('admission-load', 'concurrent durable commit'); });
    await new Promise(r => setTimeout(r, 10));   // the warm-up's latency rows land and fall outside the measured window
    const measuredFrom = Date.now();
    for (let i = WARM_UP; i < WARM_UP + MEASURED; i++) {
      const t0 = performance.now();
      const r = await send(i);
      durations.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    loading = false; await Promise.all(writers);
    await new Promise(r => setTimeout(r, 50));
    const sorted = durations.sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    const report = await fx.store.latencyReport(Date.now() - measuredFrom + 2);
    expect(report.count).toBe(MEASURED);
    console.log(`send round trip (in-process) p50=${pct(0.5).toFixed(2)}ms p90=${pct(0.9).toFixed(2)}ms p99=${pct(0.99).toFixed(2)}ms; ` +
      `recorded receive→admit p50=${report.intervals.receiveToAdmit.p50}ms p99=${report.intervals.receiveToAdmit.p99}ms max=${report.intervals.receiveToAdmit.max}ms`);
    expect(pct(0.5)).toBeLessThan(10);
    expect(report.intervals.receiveToAdmit.p50!).toBeLessThan(10);
    expect(report.intervals.receiveToAdmit.p99!).toBeLessThan(50);
  });
});
