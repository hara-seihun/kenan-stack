import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo, GpuFleetReport, GpuMachine, GpuOwner } from '../../shared/contract.js';
import type { Deps } from '../types.js';

/**
 * The GPUs screen reads the one fleet record `kenan-gpus` writes every minute (~/tools/kenan-gpus): every provider,
 * one row per machine. Here it only gains worker names, goal titles and run states, and flags boxes whose renter is gone.
 */
const FLEET = '.local/state/kenan-gpus/fleet.json';
const STALE_MS = 3 * 60_000;

type RawOwner = { kind: 'worker'; id: string } | { kind: 'service'; name: string } | { kind: 'shared'; match: string; label: string };
type RawMachine = Omit<GpuMachine, 'owner'> & { owner: RawOwner | null };
type RawFleet = Omit<GpuFleetReport, 'available' | 'problem' | 'machines'> & { machines: RawMachine[] };

const empty = (now: number, available: boolean, problem: string | null): GpuFleetReport => ({
  available, observedAt: now, problem, machines: [], pools: [], providers: [],
  totals: { machines: 0, gpus: 0, usdPerHour: 0, creditUsdPerHour: 0, moneyUsdPerHour: 0, todayUsd: 0, idle: 0 },
});

export async function gpuUsageReport(deps: Deps, personId: string): Promise<GpuFleetReport> {
  const person = deps.person(personId);
  if (personId !== 'alice' || !person || person.unixUser !== 'kenan') return empty(deps.now(), false, null);
  let fleet: RawFleet;
  try { fleet = JSON.parse(await readFile(join(person.home, FLEET), 'utf8')) as RawFleet; }
  catch { return empty(deps.now(), true, 'The GPU record has not been written yet: kenan-gpus.timer is not running.'); }

  const active = await deps.store.listAgents(personId);
  const byId = new Map<string, AgentInfo>(active.map(a => [a.id, a]));
  const missing = fleet.machines.some(m => m.owner?.kind === 'worker' && !byId.has(m.owner.id));
  if (missing) for (const a of await deps.store.listAgents(personId, { includeArchived: true })) byId.set(a.id, a);
  const goals = new Map((await deps.store.listGoals(personId, 'open')).map(g => [g.id, g.title]));
  const live = (a: AgentInfo) => !a.archived && a.state !== 'stopped' && a.role === 'worker';

  const machines = fleet.machines.map((m): GpuMachine => {
    let owner: GpuOwner | null = null;
    let idle = m.idle;
    const o = m.owner;
    if (o?.kind === 'worker') {
      const a = byId.get(o.id);
      owner = { kind: 'worker', id: o.id, name: a?.name ?? null, goal: a?.goalId ? goals.get(a.goalId) ?? null : null, state: a ? (a.archived ? 'archived' : a.state) : null };
      const charging = (m.usdPerHour ?? 0) > 0;
      if (charging && !a) idle = idle ?? 'Renter is not a known agent';
      else if (charging && a && (a.archived || a.state === 'stopped')) idle = `Renter ${a.archived ? 'archived' : 'stopped'}${idle ? ` · ${idle}` : ''}`;
    } else if (o?.kind === 'shared') {
      const pattern = new RegExp(o.match, 'i');
      const workers = active.filter(a => live(a) && (pattern.test(a.name) || pattern.test(goals.get(a.goalId ?? '') ?? '')));
      owner = { kind: 'shared', label: o.label, workers: workers.map(a => ({ id: a.id, name: a.name })) };
    } else if (o?.kind === 'service') owner = o;
    return { ...m, owner, idle };
  });
  const age = deps.now() - fleet.observedAt;
  return {
    ...fleet, machines, available: true,
    problem: age > STALE_MS ? `The GPU record is ${Math.round(age / 60_000)} minutes old: kenan-gpus.timer has stopped refreshing it.` : null,
    totals: { ...fleet.totals, idle: machines.filter(m => m.idle).length },
  };
}
