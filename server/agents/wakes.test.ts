import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { ADDRESSED_QUIET_MS, ROUTINE_QUIET_MS, addressedSettled, EVENT_BATCH, OUTAGE_REPORT_AFTER_MS, Outages, SHORT_WAIT_MS, WakeScheduler, fireOnInput, parseTrigger, readSignal, readSignalOnce, matchSignal, wakeTool } from './wakes.js';
import type { AgentInput, Deps, SignalChat } from '../types.js';
import type { PersonConfig } from '../config.js';

describe.skipIf(!testDatabaseUrl)('self-scheduled wakes', () => {
  let store: PgStore, url: string, home: string, person: PersonConfig, clock = 1_000_000;
  const delivered: AgentInput[] = [];
  const deps = () => ({ store, now: () => clock, person: () => person, bus: { toPerson: vi.fn() }, runtime: { deliver: (input: AgentInput) => delivered.push(input) } } as unknown as Deps);
  beforeAll(async () => {
    url = await freshSchema('t_wakes'); store = createStore(url); await store.migrate();
    home = await mkdtemp(join(tmpdir(), 'wakes-'));
    await mkdir(join(home, '.local/share/kenan'), { recursive: true });
    const signalStore = join(home, 'receive.sqlite3');
    const db = new DatabaseSync(signalStore);
    db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, payload TEXT NOT NULL)'); db.close();
    person = { id: 'owner', home, extensions: ['texts', 'mail'], signalStore } as unknown as PersonConfig;
    await store.upsertPerson({ id: 'owner', name: 'Owner', kind: 'human' });
    for (const id of ['w1', 'w2'])
      await store.createAgent({ id, ownerId: 'owner', role: 'worker', name: id, goalId: null, model: 'fixture', sessionPath: `/tmp/${id}`, conversationTitle: id });
  });
  afterAll(async () => { await store?.close(); });

  it('fires time and event wakes once across scheduler restarts, drops wakes of archived runs, and keeps cancelled ones quiet', async () => {
    const at = await store.createWake({ agentId: 'w1', ownerId: 'owner', message: 'call the borough', trigger: { at: clock + 120_000, event: null, listen: { kind: 'clock', reason: 'test' } } });
    const text = await store.createWake({ agentId: 'w1', ownerId: 'owner', message: 'enter the code', trigger: { at: null, event: { source: 'text', query: 'verification' }, listen: { kind: 'addressed' } } });
    const signal = await store.createWake({ agentId: 'w1', ownerId: 'owner', message: 'Frank answered', trigger: { at: null, event: { source: 'signal', from: 'frank', chat: { kind: 'direct' }, query: null }, listen: { kind: 'addressed' } } });
    const cancelled = await store.createWake({ agentId: 'w1', ownerId: 'owner', message: 'never', trigger: { at: clock, event: null, listen: { kind: 'clock', reason: 'test' } } });
    await store.settleWake(cancelled.id, { status: 'cancelled', reason: 'cancelled', detail: 'test' });
    const orphan = await store.createWake({ agentId: 'w2', ownerId: 'owner', message: 'gone', trigger: { at: clock, event: null, listen: { kind: 'clock', reason: 'test' } } });
    await store.updateAgent('w2', { archived: true, state: 'stopped' });

    let scheduler = new WakeScheduler(deps());
    await scheduler.tick();
    expect(delivered).toEqual([]);
    expect((await store.settledWakes('owner', 0, 10)).find(w => w.id === orphan.id)).toMatchObject({ status: 'dropped', reason: 'agent_archived' });

    const created = (id: string) => store.pendingWakes('owner').then(wakes => wakes.find(w => w.id === id)!.createdAt);
    const createdAt = await created(text.id), signalCreatedAt = await created(signal.id);
    await writeFile(join(home, '.local/share/kenan/texts.jsonl'), JSON.stringify({ id: 't', source: 'sms', app: 'sms', sender: '12345', body: 'Your verification code is 991', at: 1, storedAt: createdAt + 5 }) + '\n');
    const db = new DatabaseSync(person.signalStore!);
    db.prepare('INSERT INTO events VALUES (?,?,?)').run('e', signalCreatedAt + 5, JSON.stringify({ envelope: { sourceName: 'Frank', sourceNumber: null, sourceUuid: 'u', dataMessage: { message: 'yes, Monday works' } } }));
    db.close();
    clock += 120_000;
    scheduler = new WakeScheduler(deps());
    await scheduler.tick(); await scheduler.tick();
    await scheduler.stop();

    expect(delivered.map(input => [input.agentId, input.kind])).toEqual([['w1', 'wake'], ['w1', 'wake'], ['w1', 'wake']]);
    const texts = delivered.map(input => input.text).join('\n');
    expect(texts).toContain('call the borough');
    expect(texts).toContain('verification code is 991');
    expect(texts).toContain('yes, Monday works');
    expect(texts).not.toContain('never');
    expect(await store.pendingWakes('owner')).toEqual([]);
    expect((await store.settledWakes('owner', 0, 10)).filter(w => [at.id, text.id, signal.id].includes(w.id)).map(w => w.status)).toEqual(['fired', 'fired', 'fired']);
  });

  it('a report that arrives while host events are batching carries them in its wake; events are carried only in a delivered wake text, at most EVENT_BATCH at a time', async () => {
    const w4 = 'b4f0c1d2-0000-4000-8000-000000000004';
    await store.createAgent({ id: w4, ownerId: 'owner', role: 'worker', name: 'w4', goalId: null, model: 'fixture', sessionPath: '/tmp/w4', conversationTitle: 'w4' });
    delivered.length = 0;
    const saved = clock; clock = Date.now();
    const scheduler = new WakeScheduler(deps());
    const deadline = Date.now() + 3_600_000;
    const first = await store.createWake({ agentId: w4, ownerId: 'owner', message: 'watch the release', trigger: { at: deadline, event: null, listen: { kind: 'addressed' } } });
    await store.recordHostEvent({ ownerId: 'owner', id: 'inbox-1', topic: `acme:${w4}`, body: { kind: 'inbox', file: 'a.json' } });
    await store.recordHostEvent({ ownerId: 'owner', id: 'inbox-2', topic: 'acme:b4f0c1d2', body: { kind: 'inbox', file: 'b.json' } });
    await scheduler.tick();
    expect(delivered).toEqual([]);
    await fireOnInput(deps(), { agentId: w4, kind: 'report', fromId: 'child-1', conversationId: 'c', text: 'Worker child-1 reports done' });
    expect(delivered.map(d => [d.agentId, d.kind])).toEqual([[w4, 'wake']]);
    expect(delivered[0]!.text).toContain('a report from child-1 arrived');
    expect(delivered[0]!.text).toContain('"file":"a.json"');
    expect(delivered[0]!.text).toContain('"file":"b.json"');
    expect((await store.settledWakes('owner', 0, 10, w4)).find(w => w.id === first.id)).toMatchObject({ status: 'fired' });

    // The next wake gets only what came after, and an event that arrived before it was scheduled still fires it.
    await store.recordHostEvent({ ownerId: 'owner', id: 'inbox-3', topic: `acme:${w4}`, body: { kind: 'inbox', file: 'c.json' } });
    await store.createWake({ agentId: w4, ownerId: 'owner', message: 'keep watching', trigger: { at: deadline, event: null, listen: { kind: 'addressed' } } });
    clock = Date.now() + ADDRESSED_QUIET_MS;
    await scheduler.tick();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.text).toContain('"file":"c.json"');
    expect(delivered[1]!.text).not.toContain('a.json');

    // A clock wake fires on its time with the burst still settling: it carries the oldest EVENT_BATCH in full and leaves the rest.
    for (let i = 0; i < EVENT_BATCH + 2; i++) await store.recordHostEvent({ ownerId: 'owner', id: `burst-${i}`, topic: `contention:${w4}`, body: { n: i } });
    await store.createWake({ agentId: w4, ownerId: 'owner', message: 'decide now', trigger: { at: clock, event: null, listen: { kind: 'clock', reason: 'decision time' } } });
    await scheduler.tick();
    expect(delivered).toHaveLength(3);
    expect(delivered[2]!.text).toContain('due ');
    for (let i = 0; i < EVENT_BATCH; i++) expect(delivered[2]!.text).toContain(`"n":${i}}`);
    expect(delivered[2]!.text).toContain('2 more host events addressed to you did not fit');
    await store.createWake({ agentId: w4, ownerId: 'owner', message: 'the rest', trigger: { at: deadline, event: null, listen: { kind: 'addressed' } } });
    clock = Date.now() + ADDRESSED_QUIET_MS;
    await scheduler.tick();
    expect(delivered).toHaveLength(4);
    expect(delivered[3]!.text).toContain(`"n":${EVENT_BATCH}}`);
    expect(delivered[3]!.text).toContain(`"n":${EVENT_BATCH + 1}}`);
    expect(delivered[3]!.text).not.toContain('"n":0}');
    expect(await store.addressedEventsFor('owner', { ids: [w4], goals: [] }, 0, 100)).toEqual([]);
    await scheduler.stop();
    clock = saved;
  });

  it('rejects ambiguous or unavailable triggers instead of guessing', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(parseTrigger({ at: '2026-10-18T15:00' }, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ at: '2026-10-17T15:00:00Z' }, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({}, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ on: 'signal', from: 'x', chat: 'direct' }, now, { ...person, signalStore: null }, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ on: 'signal', from: 'robin' }, now, person, 'w1')).toMatchObject({ ok: false, error: expect.stringContaining('chat') });
    expect(parseTrigger({ on: 'signal', from: 'robin', chat: 'group' }, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ on: 'signal', from: 'robin', chat: 'direct', group: 'Bookclub' }, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ on: 'signal', from: 'robin', chat: 'group', group: ' Bookclub ' }, now, person, 'w1')).toEqual({ ok: true, value: { at: null, event: { source: 'signal', from: 'robin', chat: { kind: 'group', group: 'Bookclub' }, query: null }, listen: { kind: 'addressed' } } });
    expect(parseTrigger({ at: '2026-10-18T09:00:00-04:00', on: 'text', query: 'code' }, now, person, 'w1')).toEqual({ ok: true, value: { at: Date.parse('2026-10-18T13:00:00Z'), event: { source: 'text', query: 'code' }, listen: { kind: 'addressed' } } });
  });

  it('refuses a time alone without a clock reason, and every other wake fires early on events and inputs addressed to its agent', async () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    const timeAlone = parseTrigger({ inMinutes: 30 }, now, person, 'w1');
    expect(timeAlone).toMatchObject({ ok: false, error: expect.stringMatching(/^wake_needs_event: .*acme:w1.*gpujob:w1:\*/) });
    expect(parseTrigger({ inMinutes: 30, clock: '  ' }, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ inMinutes: 30, on: 'text', query: 'x', clock: 'decision time' }, now, person, 'w1')).toMatchObject({ ok: false });
    expect(parseTrigger({ inMinutes: 30, clock: 'Thu 17:00 decision time' }, now, person, 'w1')).toEqual({ ok: true, value: { at: now + 1_800_000, event: null, listen: { kind: 'clock', reason: 'Thu 17:00 decision time' } } });
    expect(parseTrigger({ on: 'any' }, now, person, 'w1')).toEqual({ ok: true, value: { at: null, event: null, listen: { kind: 'addressed' } } });

    const goal = await store.createGoal({ ownerId: 'owner', title: 'g', detail: '' });
    await store.createAgent({ id: 'a3f0c1d2-0000-4000-8000-000000000003', ownerId: 'owner', role: 'worker', name: 'w3', goalId: goal.id, model: 'fixture', sessionPath: '/tmp/w3', conversationTitle: 'w3' });
    const w3 = 'a3f0c1d2-0000-4000-8000-000000000003';
    delivered.length = 0;
    const saved = clock; clock = Date.now();
    const scheduler = new WakeScheduler(deps());
    const deadline = Date.now() + 3_600_000;
    const waiting = await store.createWake({ agentId: w3, ownerId: 'owner', message: 'check the merge verdict', trigger: { at: deadline, event: null, listen: { kind: 'addressed' } } });
    const decision = await store.createWake({ agentId: w3, ownerId: 'owner', message: 'decide at 17:00', trigger: { at: deadline, event: null, listen: { kind: 'clock', reason: 'decision time' } } });
    await store.recordHostEvent({ ownerId: 'owner', id: 'other', topic: 'acme:someone-else', body: { kind: 'deploy' } });
    await scheduler.tick();
    expect(delivered).toEqual([]);
    // The producer used the 8-character prefix; the verdict arrives long before the deadline. A burst settles first:
    // the wake fires once the agent's events have been quiet a minute, carrying both in one turn.
    await store.recordHostEvent({ ownerId: 'owner', id: 'q', topic: 'acme:a3f0c1d2', body: { kind: 'qualify', verdict: 'merged' } });
    await store.recordHostEvent({ ownerId: 'owner', id: 'q2', topic: 'gpujob:a3f0c1d2-0000-4000-8000-000000000003:j', body: { event: 'RUNNING' } });
    clock = Date.now() + ADDRESSED_QUIET_MS / 2;
    await scheduler.tick();
    expect(delivered).toEqual([]);
    clock = Date.now() + ADDRESSED_QUIET_MS;
    await scheduler.tick();
    expect(delivered.map(d => [d.agentId, d.kind])).toEqual([[w3, 'wake']]);
    expect(delivered[0]!.text).toContain('"verdict":"merged"');
    expect(delivered[0]!.text).toContain('"event":"RUNNING"');
    expect(delivered[0]!.text).toContain('fired before its time');
    expect((await store.pendingWakes('owner')).filter(w => w.agentId === w3).map(w => w.id)).toEqual([decision.id]);
    expect((await store.settledWakes('owner', 0, 10, w3)).find(w => w.id === waiting.id)).toMatchObject({ status: 'fired', reason: 'event' });

    // A goal alert and a report from a child are addressed too; the clock wake stays for its time.
    const goalWake = await store.createWake({ agentId: w3, ownerId: 'owner', message: 'goal alert', trigger: { at: null, event: { source: 'text', query: 'nothing' }, listen: { kind: 'addressed' } } });
    await store.recordHostEvent({ ownerId: 'owner', id: 'g', topic: `goal-${goal.id.slice(0, 8)}:alert`, body: { subject: 'helper 5xx' } });
    clock = Date.now() + ADDRESSED_QUIET_MS;
    await scheduler.tick();
    expect(delivered.at(-1)!.text).toContain('helper 5xx');
    await store.createWake({ agentId: w3, ownerId: 'owner', message: 'wait for the sub-agent', trigger: { at: deadline, event: null, listen: { kind: 'addressed' } } });
    await fireOnInput(deps(), { agentId: w3, kind: 'report', fromId: 'sub-1', conversationId: 'c', text: 'Worker sub-1 reports done: built it' });
    await fireOnInput(deps(), { agentId: w3, kind: 'human', fromId: 'owner', conversationId: 'c', text: 'hello' });
    expect(delivered.at(-1)).toMatchObject({ agentId: w3, kind: 'wake', text: expect.stringContaining('a report from sub-1 arrived') });
    expect(delivered.at(-1)!.text).toContain('wait for the sub-agent');
    expect((await store.pendingWakes('owner')).filter(w => w.agentId === w3).map(w => w.id)).toEqual([decision.id]);
    expect(goalWake.listen).toMatchObject({ kind: 'addressed' });
    // A manager gets reports all day; they leave its wakes waiting for what they wait on.
    await store.createAgent({ id: 'manager:owner', ownerId: 'owner', role: 'manager', name: 'K', goalId: null, model: 'fixture', sessionPath: '/tmp/m', conversationTitle: 'K' });
    const managerWake = await store.createWake({ agentId: 'manager:owner', ownerId: 'owner', message: 'Dave on Signal', trigger: { at: null, event: { source: 'text', query: 'tailscale' }, listen: { kind: 'addressed' } } });
    await fireOnInput(deps(), { agentId: 'manager:owner', kind: 'report', fromId: w3, conversationId: 'c', text: 'done' });
    expect((await store.pendingWakes('owner')).map(w => w.id)).toContain(managerWake.id);
    await store.settleWake(managerWake.id, { status: 'cancelled', reason: 'cancelled', detail: 'test' });
    await scheduler.stop();
    clock = saved;
  });

  it('a worker keeps a short wait; a long one moves to its manager with the handoff, archives the worker at turn end, and fires to the manager on what was addressed to the worker', async () => {
    await store.upsertPerson({ id: 'holder', name: 'Holder', kind: 'human' });
    const holder = { ...person, id: 'holder' } as PersonConfig;
    await store.createAgent({ id: 'manager:holder', ownerId: 'holder', role: 'manager', name: 'K', goalId: null, model: 'fixture', sessionPath: '/tmp/mh', conversationTitle: 'K' });
    const goal = await store.createGoal({ ownerId: 'holder', title: 'House sale' });
    const id = 'b5f0c1d2-0000-4000-8000-000000000005';
    const worker = await store.createAgent({ id, ownerId: 'holder', parentAgentId: 'manager:holder', role: 'worker', name: 'house', goalId: goal.id, model: 'fixture', sessionPath: '/tmp/w5', conversationTitle: 'house' });
    const sub = await store.createAgent({ id: 'b5-sub', ownerId: 'holder', parentAgentId: id, role: 'worker', name: 'sub', goalId: goal.id, model: 'fixture', sessionPath: '/tmp/w5s', conversationTitle: 'sub' });
    delivered.length = 0;
    const saved = clock; clock = Date.now();
    const toolDeps = { ...deps(), person: () => holder, runtime: { deliver: (input: AgentInput) => delivered.push(input), managerFor: () => 'manager:holder' } } as unknown as Deps;
    const run = (agent: typeof worker, args: object) => wakeTool({ deps: toolDeps, person: holder, agent } as never).execute('call', args as never, undefined as never, undefined as never, undefined as never);
    const text = (r: Awaited<ReturnType<typeof run>>) => JSON.parse((r.content[0] as { text: string }).text);

    // A coordinator with an active sub-agent keeps its wakes; a sub-agent is refused a long wait.
    expect(text(await run(worker, { action: 'schedule', message: 'sub-agent reports', on: 'any', inMinutes: 120 })).scheduled).toBeTruthy();
    await expect(run(sub, { action: 'schedule', message: 'later', on: 'any', inMinutes: 120 })).rejects.toThrow(/^long_wait_sub_agent/);
    await store.updateAgent(sub.id, { archived: true, state: 'stopped' });
    for (const w of await store.pendingWakes('holder')) await store.settleWake(w.id, { status: 'cancelled', reason: 'cancelled', detail: 'test' });

    expect(text(await run(worker, { action: 'schedule', message: 'build done', on: 'any', inMinutes: SHORT_WAIT_MS / 60_000 })).scheduled).toMatchObject({ status: 'pending' });
    await expect(run(worker, { action: 'schedule', message: 'offer', on: 'any' })).rejects.toThrow(/^wake_needs_handoff/);
    const handed = text(await run(worker, { action: 'schedule', message: 'Read the offer, apply the price rule.', on: 'any', inMinutes: 600, handoff: 'Offers due Thursday 17:00; REPORT.md has the buyers.' }));
    expect(handed).toMatchObject({ heldBy: 'manager:holder', handedOff: { goalId: goal.id, handedOffBy: id } });
    expect((await store.getAgent(id))!.lastReport).toMatchObject({ status: 'handed_off' });
    expect((await store.getGoal('holder', goal.id))!.notes).toContain('Offers due Thursday 17:00; REPORT.md has the buyers.');
    const managerList = text(await run((await store.getAgent('manager:holder'))!, { action: 'list' }));
    expect(managerList.held).toEqual([expect.objectContaining({ goalId: goal.id, goalTitle: 'House sale', handoff: 'Offers due Thursday 17:00; REPORT.md has the buyers.' })]);
    expect(managerList.waitingWorkers).toEqual([expect.objectContaining({ id, warning: expect.stringMatching(/^waiting \d+m /) })]);

    // The worker is archived at turn end (runtime); its own short wake drops with it. An event addressed to it fires the held trigger to the manager.
    await store.updateAgent(id, { archived: true, state: 'stopped' });
    const scheduler = new WakeScheduler(toolDeps);
    await store.recordHostEvent({ ownerId: 'holder', id: 'offer-1', topic: 'acme:b5f0c1d2', body: { offer: 410000 } });
    clock = Date.now() + ADDRESSED_QUIET_MS;
    await scheduler.tick();
    expect(delivered.map(d => [d.agentId, d.kind])).toEqual([['manager:holder', 'wake']]);
    expect(delivered[0]!.text).toMatch(/^Held trigger .* for goal "House sale"/);
    expect(delivered[0]!.text).toContain('"offer":410000');
    expect(delivered[0]!.text).toContain(`workers spawn goalId ${goal.id}`);
    expect(delivered[0]!.text).toContain('Offers due Thursday 17:00');
    expect((await store.settledWakes('holder', 0, 10)).filter(w => w.status === 'dropped').map(w => w.message)).toEqual(['build done']);
    await scheduler.stop();
    clock = saved;
  });

  it('matches Signal by contact name, number or UUID, ignoring messages before the wake', async () => {
    const read = await readSignal(person.signalStore!, 0);
    if (!read.ok) throw new Error(read.error);
    const messages = read.value;
    expect(matchSignal({ source: 'signal', from: 'FRANK', chat: { kind: 'direct' }, query: 'monday' }, 0, messages)).toMatchObject({ ok: true });
    expect(matchSignal({ source: 'signal', from: 'frank', chat: { kind: 'direct' }, query: null }, Number.MAX_SAFE_INTEGER, messages)).toEqual({ ok: false });
  });

  it('scopes Signal wakes to the named conversation: a group message never fires a direct wake', async () => {
    const wake = (chat: SignalChat) => store.createWake({ agentId: 'w1', ownerId: 'owner', message: `robin ${chat.kind}`, trigger: { at: null, event: { source: 'signal', from: 'robn', chat, query: 'visit' }, listen: { kind: 'addressed' } } });
    const direct = await wake({ kind: 'direct' }), bookclub = await wake({ kind: 'group', group: 'bookclub' }), other = await wake({ kind: 'group', group: 'Release notes' }), any = await wake({ kind: 'any' });
    const createdAt = Math.max(...(await store.pendingWakes('owner')).filter(w => [direct.id, bookclub.id, other.id, any.id].includes(w.id)).map(w => w.createdAt));
    const robn = (id: string, at: number, dataMessage: object) => {
      const db = new DatabaseSync(person.signalStore!);
      db.prepare('INSERT INTO events VALUES (?,?,?)').run(id, at, JSON.stringify({ envelope: { sourceName: 'robn', sourceNumber: '+15555550199', sourceUuid: '00000000-test', dataMessage } }));
      db.close();
    };
    robn('g1', createdAt + 10, { message: 'the visit plan in Bookclub chat', groupInfo: { groupId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', groupName: 'Bookclub', revision: 4, type: 'DELIVER' } });
    const before = delivered.length;
    const scheduler = new WakeScheduler(deps());
    await scheduler.tick();
    const fired = () => store.settledWakes('owner', 0, 100).then(ws => new Map(ws.map(w => [w.id, w])));
    let settled = await fired();
    expect(settled.get(bookclub.id)).toMatchObject({ status: 'fired', detail: expect.stringContaining('in group "Bookclub"') });
    expect(settled.get(any.id)).toMatchObject({ status: 'fired' });
    expect(settled.has(direct.id)).toBe(false);
    expect(settled.has(other.id)).toBe(false);
    expect(delivered.slice(before).map(input => input.text).join('\n')).toContain('robin group');

    robn('d1', createdAt + 20, { message: 'visit Wednesday works' });
    await scheduler.tick();
    await scheduler.stop();
    settled = await fired();
    expect(settled.get(direct.id)).toMatchObject({ status: 'fired', detail: expect.stringContaining('(direct)') });
    expect(settled.has(other.id)).toBe(false);
    await store.settleWake(other.id, { status: 'cancelled', reason: 'cancelled', detail: 'test' });
  });

  it.each(['transient', 'outlasts poll'] as const)('receiver lock %s: preserves the original wake and delivers the committed message exactly once', async hold => {
    const wake = await store.createWake({ agentId: 'w1', ownerId: 'owner', message: 'Robin answered', trigger: { at: null, event: { source: 'signal', from: 'robin', chat: { kind: 'direct' }, query: null }, listen: { kind: 'addressed' } } });
    const createdAt = (await store.pendingWakes('owner')).find(w => w.id === wake.id)!.createdAt;
    const payload = JSON.stringify({ envelope: { sourceName: 'Robin', sourceNumber: null, sourceUuid: 's', dataMessage: { message: 'offer attached' } } });
    // IPC, not elapsed CPU time, owns the transaction. The old busy-spin writer could outlast the
    // bounded read budget under contention: a pending wake was incorrectly asserted to have fired.
    const writer = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
      db.exec('BEGIN EXCLUSIVE');
      db.prepare('INSERT INTO events VALUES (?,?,?)').run(process.argv[2], Number(process.argv[3]), process.argv[4]);
      process.on('message', () => {
        db.exec('COMMIT'); db.close();
        process.send('committed', () => process.disconnect());
      });
      process.send('locked');`, person.signalStore!, wake.id, String(createdAt + 5), payload], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(writer, 'exit');
    const errors = vi.spyOn(store, 'logError');
    const before = delivered.length;
    let scheduler = new WakeScheduler(deps());
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await once(writer, 'message'))[0]).toBe('locked');
      // Proves real SQLite contention on every execution, including a heavily loaded host.
      expect(() => readSignalOnce(person.signalStore!, createdAt)).toThrow(/locked/);
      const committed = once(writer, 'message');
      const poll = scheduler.tick();
      if (hold === 'transient') release = setTimeout(() => writer.send('commit'), 400);
      await poll;
      if (hold === 'outlasts poll') {
        expect(delivered.slice(before)).toEqual([]);
        expect((await store.pendingWakes('owner')).map(w => w.id)).toContain(wake.id);
        expect((await store.settledWakes('owner', 0, 100)).some(w => w.id === wake.id)).toBe(false);
        writer.send('commit');
      }
      expect((await committed)[0]).toBe('committed');
      await exited;
      if (hold === 'transient') expect(delivered.slice(before)).toHaveLength(1);
      // A failed poll never advances a cursor or settles a wake. Restart re-reads from its creation.
      await scheduler.stop();
      scheduler = new WakeScheduler(deps());
      await scheduler.tick(); await scheduler.tick();
      const inputs = delivered.slice(before);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ agentId: 'w1', kind: 'wake', fromId: 'system' });
      expect(inputs[0]!.text).toContain(wake.id);
      expect(inputs[0]!.text).toContain('offer attached');
      expect((await store.pendingWakes('owner')).some(w => w.id === wake.id)).toBe(false);
      expect((await store.settledWakes('owner', 0, 100)).filter(w => w.id === wake.id)).toMatchObject([{ id: wake.id, status: 'fired', reason: 'event' }]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      clearTimeout(release);
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
      await exited;
      await scheduler.stop();
      errors.mockRestore();
    }
  });
});

it('a passing trigger-source failure is not reported; one that lasts is reported once until a success ends it', async () => {
  let now = 0;
  const reports: string[] = [];
  const outages = new Outages(() => now, async (key, minutes, error) => { reports.push(`${key} ${minutes} ${error}`); });
  await outages.failed('mail', 'mail-search exited 130'); now += 60_000;
  outages.succeeded('mail'); now += 60_000;
  await outages.failed('mail', 'mail-search exited 130'); now += OUTAGE_REPORT_AFTER_MS - 60_000;
  expect(reports).toEqual([]);
  expect(await outages.failed('mail', 'timeout')).toBe(OUTAGE_REPORT_AFTER_MS - 60_000); now += 60_000;
  await outages.failed('mail', 'timeout'); now += 60_000;
  await outages.failed('mail', 'timeout');
  expect(reports).toEqual(['mail 5 timeout']);
});

describe('addressed event bursts', () => {
  const at = (arrivedAt: number, routine: boolean) => ({ id: String(arrivedAt), topic: 'acme:w', body: routine ? { kind: 'deploy', outcome: 'live', routine: true } : { kind: 'deploy', outcome: 'refused' }, arrivedAt, consumedAt: null });
  it('routine successes wait longer to settle; any other event settles the burst on the normal clock', () => {
    expect(addressedSettled([at(0, true)], ADDRESSED_QUIET_MS)).toBe(false);
    expect(addressedSettled([at(0, true)], ROUTINE_QUIET_MS)).toBe(true);
    expect(addressedSettled([at(0, true), at(1, false)], ADDRESSED_QUIET_MS + 1)).toBe(true);
    expect(addressedSettled([], ROUTINE_QUIET_MS)).toBe(false);
  });
});
