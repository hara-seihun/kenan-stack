import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideHeartbeat, HEARTBEAT_FLOOR_MS, heartbeatState, readHostAlerts, renderStatus } from './heartbeat.js';
import type { AgentInfo, Goal } from '../../shared/contract.js';

const goal = (id: string, updatedAt: number): Goal => ({ id, ownerId: 'alice', title: `Goal ${id}`, detail: 'long detail '.repeat(200), status: 'open', priority: 1, workerIds: [], notes: 'long notes '.repeat(200), createdAt: 1, updatedAt });
const worker = (id: string, goalId: string, state: AgentInfo['state']) => ({ id, name: id, role: 'worker', goalId, state, archived: false, lastReport: null } as unknown as AgentInfo);
const accounts = [
  { accountId: 'anthropic', percentLeft: 0, readingAt: 1, resetAt: Date.parse('2026-10-21T07:00:00Z'), drain: { state: 'stale' as const, readingAt: Date.parse('2026-10-18T13:51:00Z') }, projectedExhaustionAt: null },
  { accountId: 'anthropic-2', percentLeft: 100, readingAt: 1, resetAt: Date.parse('2026-10-23T18:00:00Z'), drain: { state: 'measured' as const, percentPerHour: 2.5 }, projectedExhaustionAt: Date.parse('2026-10-19T18:00:00Z') },
];
const plan = (metric: string) => ({ provider: 'anthropic' as const, metric, percentLeft: 50, projection: { state: 'projected' as const, drainPercentPerHour: 1.25, exhaustionAt: null, unknownDrain: [] }, accounts });
const usage = { observedAt: 1, plans: [plan('weekly'), plan('fable')], spend: { lastHourUsd: 1, lastDayUsd: 2, byAgent: [] }, swarms: [] };
const empty = { p50: null, p90: null, p99: null, max: null };
const latency = { windowMs: 1, count: 0, intervals: { receiveToAdmit: empty, admitToModelRequest: empty, admitToFirstToken: empty, admitToFirstText: empty, clientToAdmit: empty } };

it('lists goals compactly, marks only what moved since the previous heartbeat, and carries the error cursor', () => {
  const previous = { at: 1, checkedAt: 1, errorId: 4, goals: { a: 10, b: 20 }, workers: { w: 'running' }, alerts: [], checklist: null };
  const { text, state } = renderStatus({
    goals: [goal('a', 10), goal('b', 25)], agents: [worker('w', 'a', 'idle')], usage, latency,
    errors: [{ id: 9, scope: 'agent:w', message: 'boom', at: 2 }], hostAlerts: { kind: 'unconfigured' }, wakes: [], droppedWakes: [], previous, reasons: ['goals moved'], checklist: null, now: 3_600_000,
  });
  expect(text).not.toContain('long detail');
  expect(text).not.toContain('long notes');
  expect(text).toMatch(/^ a P1 .*workers: w idle\*/m);
  expect(text).toMatch(/^\*b P1 .*⚠ no worker and no held trigger/m);
  expect(text).toMatch(/^⚠ Goals with no worker and no held trigger \(1\): .*b Goal b/m);
  expect(text).toContain('agent:w: boom');
  expect(text).toContain('- anthropic weekly/fable: pool 50% −1.3%/h | anthropic 0% stale since 2026-10-18T13:51Z ↻2026-10-21T07:00Z; anthropic-2 100% −2.5%/h out 2026-10-19T18:00Z ↻2026-10-23T18:00Z');
  expect(text).toContain('Why now: goals moved.');
  expect(state).toEqual({ at: 3_600_000, checkedAt: 3_600_000, errorId: 9, goals: { a: 10, b: 25 }, workers: { w: 'idle' }, alerts: [], checklist: null });
});

it('lists each host alert file by name and heading, and reports an unreadable inbox instead of hiding it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alerts-'));
  await writeFile(join(dir, 'kenan-wal-archive.md'), '# WAL archiving stalled\n\ndetail');
  await writeFile(join(dir, 'notes.txt'), 'ignored');
  const render = async (hostAlerts: Awaited<ReturnType<typeof readHostAlerts>>) => renderStatus({ goals: [], agents: [], usage, latency, errors: [], hostAlerts, wakes: [], droppedWakes: [], previous: null, reasons: ['goals moved'], checklist: null, now: Date.now() }).text;
  expect(await render(await readHostAlerts(dir))).toMatch(/^Open host alerts \(1\).*\n- kenan-wal-archive\.md \(0m old\): WAL archiving stalled$/m);
  expect(await render(await readHostAlerts(join(dir, 'missing')))).toMatch(/^Host alerts unreadable \(.*missing\): .*ENOENT/m);
  expect(await render(await readHostAlerts(null))).not.toContain('host alerts');
});

it('wakes the manager only when something moved since the last delivered heartbeat, or at the floor when work or a checklist is kept', () => {
  const quiet = { goals: [], agents: [], errors: [], hostAlerts: { kind: 'unconfigured' as const }, checklist: null, droppedWakes: [] };
  expect(decideHeartbeat(quiet, null, 1)).toEqual([]);
  const idle = heartbeatState(quiet, null, 1);
  expect(decideHeartbeat(quiet, idle, 1 + 7 * 24 * 3600_000)).toEqual([]);

  const busy = { ...quiet, goals: [goal('a', 10)], agents: [worker('w', 'a', 'running')], checklist: 'c1' };
  expect(decideHeartbeat(busy, idle, 2)).toEqual(['goals moved', 'workers changed', 'HEARTBEAT.md changed']);
  const seen = heartbeatState(busy, idle, 2);
  expect(decideHeartbeat(busy, { ...seen, checkedAt: 2 + HEARTBEAT_FLOOR_MS - 1 }, 2 + HEARTBEAT_FLOOR_MS - 1)).toEqual([]);
  expect(decideHeartbeat(busy, seen, 2 + HEARTBEAT_FLOOR_MS)).toHaveLength(1);
  expect(decideHeartbeat({ ...busy, agents: [worker('w', 'a', 'idle')] }, seen, 3)).toEqual(['workers changed']);
  expect(decideHeartbeat({ ...busy, errors: [{ id: 9, scope: 'usage', message: 'x', at: 3 }] }, seen, 3)).toEqual(['new errors']);
  expect(decideHeartbeat({ ...busy, hostAlerts: { kind: 'read', dir: '/a', alerts: [{ name: 'x.md', title: 'X', changedAt: 3 }] } }, seen, 3)).toEqual(['host alerts changed']);
});

it('shows held triggers under their goal, lists the goals waiting on one, and marks a waiting worker as a warning', () => {
  const held = { id: 'h1', agentId: 'manager:alice', ownerId: 'alice', message: 'offer', createdAt: 1, at: null, event: { source: 'text', query: 'offer' }, listen: { kind: 'addressed' }, status: 'pending', held: { goalId: 'a', workerId: 'w0', handoff: 'see REPORT.md' } } as const;
  const own = { ...held, id: 'o1', agentId: 'w', held: null, at: 7_200_000, event: null } as const;
  const { text } = renderStatus({ goals: [goal('a', 10), goal('b', 10)], agents: [worker('w', 'b', 'idle')], usage, latency, errors: [], hostAlerts: { kind: 'unconfigured' }, wakes: [held, own], droppedWakes: [], previous: null, reasons: ['goals moved'], checklist: null, now: 3_600_000 });
  expect(text).toMatch(/^ a P1 .*\| held trigger: on text containing "offer", or on anything addressed to worker w0 or goal a$/m);
  expect(text).toMatch(/^ b P1 .*workers: w idle ⚠ waiting 1h /m);
  expect(text).toContain('Goals waiting on a trigger you hold (1');
  expect(text).toContain('⚠ Workers still waiting (1)');
  expect(text).not.toContain('Goals with no worker');
});
