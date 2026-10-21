import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { NOTICE_DISPLAY, unread, type NoticeKind } from '../../shared/contract.js';
import type { Store } from '../types.js';
import { createStore, type PgStore } from './store.js';
import { freshSchema, testDatabaseUrl } from './test-db.js';

describe.skipIf(!testDatabaseUrl)('pg store', () => {
  let store: PgStore;
  let url: string;
  beforeAll(async () => {
    url = await freshSchema('t_store');
    store = createStore(url);
    await store.migrate();
    await store.migrate();   // idempotent
    await store.upsertPerson({ id: 'alice', name: 'Alice', kind: 'human' });
    await store.upsertPerson({ id: 'robin', name: 'Robin', kind: 'human' });
  });
  afterAll(() => store?.close());

  it('persists explicit worker thinking across store restart while leaving existing defaults null',async()=>{
    await store.upsertPerson({id:'profiles',name:'Profiles',kind:'human'});
    const old=await store.createAgent({id:'profile-old',name:'Old',ownerId:'profiles',role:'worker',goalId:null,model:'fixture',sessionPath:'/tmp/old',conversationTitle:'Old'});
    expect(old.thinking).toBeNull();
    await store.createAgent({id:'profile-exact',name:'Exact',ownerId:'profiles',role:'worker',goalId:null,model:'gpt-6-astra',thinking:'high',sessionPath:'/tmp/exact',conversationTitle:'Exact'});
    const restarted=createStore(url);try{await restarted.migrate();expect(await restarted.getAgent('profile-exact')).toMatchObject({model:'gpt-6-astra',thinking:'high'});expect((await restarted.getAgent('profile-old'))!.thinking).toBeNull();}finally{await restarted.close();}
  });
  it('a worker hands off a long wait: the manager holds it for the goal with the handoff, the goal notes keep it, the worker reports handed off; waiting for a reply ends with a finished answer', async () => {
    await store.upsertPerson({ id: 'parker', name: 'Parker', kind: 'human' });
    await store.createAgent({ id: 'park-manager', name: 'M', ownerId: 'parker', role: 'manager', goalId: null, model: 'm', sessionPath: '/tmp/pm', conversationTitle: 'M' });
    const goal = await store.createGoal({ ownerId: 'parker', title: 'Sell the house' });
    await store.updateGoal(goal.id, { notes: { kind: 'prepend', entry: '2026-10-20 09:00Z — listed' } });
    const worker = await store.createAgent({ id: 'park-worker', name: 'W', ownerId: 'parker', parentAgentId: 'park-manager', role: 'worker', goalId: goal.id, model: 'm', sessionPath: '/tmp/pw', conversationTitle: 'W' });
    const own = await store.createWake({ agentId: worker.id, ownerId: 'parker', message: 'build', trigger: { at: Date.now() + 600_000, event: null, listen: { kind: 'addressed' } } });
    expect(own.held).toBeNull();
    expect((await store.listWorkersPage('parker', {})).items.map(w => w.id)).toEqual([worker.id]);
    const { wake, goal: noted, worker: handed } = await store.handOff({ worker: { ...worker, goalId: goal.id }, managerId: 'park-manager', message: 'offer arrived', trigger: { at: null, event: { source: 'text', query: 'offer' }, listen: { kind: 'addressed' } }, handoff: 'Offers due Thursday; see REPORT.md.', summary: 'on a text' });
    expect(wake).toMatchObject({ agentId: 'park-manager', status: 'pending', held: { goalId: goal.id, workerId: worker.id, handoff: 'Offers due Thursday; see REPORT.md.' } });
    expect(noted.notes).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z — Handoff from worker park-wor .*\nOffers due Thursday; see REPORT.md.\n2026-10-20 09:00Z — listed$/s);
    expect(handed.lastReport).toMatchObject({ status: 'handed_off' });
    expect((await store.getAgent('park-manager'))!.wakes).toEqual([expect.objectContaining({ at: null, on: 'text', goalId: goal.id })]);
    expect((await store.getAgent(worker.id))!.wakes).toEqual([expect.objectContaining({ goalId: null, since: own.createdAt })]);
    await expect(store.createWake({ agentId: 'park-manager', ownerId: 'parker', message: 'x', trigger: { at: Date.now() + 1, event: null, listen: { kind: 'clock', reason: 'r' } }, held: { goalId: goal.id, workerId: null, handoff: ' ' } })).rejects.toThrow(/wake_held/);

    const chat = (await store.getAgent('park-manager'))!.conversationId;
    expect(await store.awaitingReply(chat)).toBe(false);
    await store.appendMessage({ conversationId: chat, authorId: 'parker', role: 'human', text: 'question' });
    expect(await store.awaitingReply(chat)).toBe(true);
    await store.appendMessage({ conversationId: chat, authorId: 'park-manager', role: 'assistant', text: 'partial', state: 'stopped', display: 'shown' });
    await store.appendMessage({ conversationId: chat, authorId: 'park-manager', role: 'notice', notice: 'system', text: 'restarted' });
    expect(await store.awaitingReply(chat)).toBe(true);
    await store.appendMessage({ conversationId: chat, authorId: 'park-manager', role: 'assistant', text: 'answer', display: 'shown' });
    expect(await store.awaitingReply(chat)).toBe(false);
  });
  it('creates an agent with its person row and own conversation in one go', async () => {
    const agent = await store.createAgent({ id: 'kenaznia-alice', name: 'Kenaznia', ownerId: 'alice', role: 'manager', goalId: null, model: 'claude-opus-5-5', sessionPath: '/tmp/s.jsonl', conversationTitle: 'Kenaznia' });
    expect(agent).toMatchObject({ id: 'kenaznia-alice', kind: 'agent', ownerId: 'alice', role: 'manager', state: 'idle', lastReport: null });
    expect(await store.getPerson('kenaznia-alice')).toEqual({ id: 'kenaznia-alice', name: 'Kenaznia', kind: 'agent' });
    const conv = await store.getConversation(agent.conversationId, 'alice');
    expect(conv).toMatchObject({ ownerId: 'alice', agentId: 'kenaznia-alice', memberIds: ['alice', 'kenaznia-alice'], lastSeq: 0, readThrough: 0, lastMessage: null });
    expect(await store.agentSessionPath(agent.id)).toBe('/tmp/s.jsonl');

    const goal = await store.createGoal({ ownerId: 'alice', title: 'Ship it' });
    const worker = await store.createAgent({ id: 'w1', name: 'Worker 1', ownerId: 'alice', role: 'worker', goalId: goal.id, model: 'm', sessionPath: '/tmp/w1', conversationTitle: 'W1' });
    expect((await store.listGoals('alice', 'open'))[0]).toMatchObject({ id: goal.id, workerIds: ['w1'], priority: 100 });
    expect(await store.getGoal('alice', goal.id)).toMatchObject({ id: goal.id, workerIds: ['w1'] });
    expect(await store.getGoal('someone-else', goal.id)).toBeNull();
    expect(await store.getGoal('alice', 'not-a-uuid')).toBeNull();
    const report = { status: 'done' as const, text: 'ok', at: 5 };
    expect(await store.updateAgent(worker.id, { state: 'running', lastReport: report, name: 'Renamed' })).toMatchObject({ state: 'running', lastReport: report, name: 'Renamed' });
    expect(await store.markRunningInterrupted()).toEqual(['w1']);
    expect((await store.listAgents('alice')).map(a => [a.id, a.state])).toEqual([['kenaznia-alice', 'idle'], ['w1', 'interrupted']]);
    expect((await store.updateGoal(goal.id, { status: 'done', notes: { kind: 'replace', text: '2026-10-20 10:00Z — n' } })).status).toBe('done');
    expect((await store.updateGoal(goal.id, { notes: { kind: 'prepend', entry: 'moved' } })).notes).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z — moved\n2026-10-20 10:00Z — n$/);
    await expect(store.updateAgent('nobody', { state: 'idle' })).rejects.toMatchObject({ code: 'not_found' });

    const later = await store.createWake({ agentId: 'w1', ownerId: 'alice', message: 'later', trigger: { at: 9_000, event: null, listen: { kind: 'clock', reason: 'test' } } });
    await store.createWake({ agentId: 'w1', ownerId: 'alice', message: 'mail', trigger: { at: null, event: { source: 'mail', folder: 'INBOX', criteria: 'ALL', seen: [] }, listen: { kind: 'addressed' } } });
    await store.createWake({ agentId: 'w1', ownerId: 'alice', message: 'sooner', trigger: { at: 7_000, event: { source: 'text', query: 'code' }, listen: { kind: 'addressed' } } });
    const shown = (wakes: { at: number | null; on: string | null }[]) => wakes.map(({ at, on }) => ({ at, on }));
    expect(shown((await store.getAgent('w1'))!.wakes)).toEqual([{ at: 7_000, on: 'text' }, { at: 9_000, on: null }, { at: null, on: 'mail' }]);
    await store.settleWake(later.id, { status: 'cancelled', reason: 'cancelled', detail: 'test' });
    expect(shown((await store.listAgents('alice')).find(a => a.id === 'w1')!.wakes)).toEqual([{ at: 7_000, on: 'text' }, { at: null, on: 'mail' }]);
  });

  it('rooms: summaries carry members, readThrough per person and a last-message preview', async () => {
    const room = await store.createConversation({ title: 'Room', ownerId: 'alice', memberIds: ['robin'] });
    expect(room.memberIds).toEqual(['alice', 'robin']);
    await store.appendMessage({ conversationId: room.id, authorId: 'robin', role: 'human', text: 'x'.repeat(300) });
    const updated = await store.updateConversation(room.id, 'alice', { readThrough: 1, title: 'Renamed', color: '#f00', addMemberIds: ['kenaznia-alice'] });
    expect(updated).toMatchObject({ title: 'Renamed', color: '#f00', readThrough: 1, lastSeq: 1, memberIds: ['alice', 'kenaznia-alice', 'robin'] });
    expect(updated.lastMessage).toMatchObject({ authorId: 'robin', preview: 'x'.repeat(140) });
    expect((await store.getConversation(room.id, 'robin'))!.readThrough).toBe(0);
    await store.updateConversation(room.id, 'alice', { removeMemberIds: ['kenaznia-alice'], archived: true });
    expect(await store.conversationMembers(room.id)).toEqual(['alice', 'robin']);
    expect((await store.listConversations('robin')).some(c => c.id === room.id)).toBe(false);
    expect((await store.listConversations('robin', { archived: true })).map(c => c.id)).toEqual([room.id]);
  });

  it('files: a person sees what they own and what is shown in their conversations, nothing else', async () => {
    const room = await store.createConversation({ title: 'Pictures', ownerId: 'alice', memberIds: ['robin'] });
    const { id } = await store.createFile({ ownerId: 'alice', name: 'plot.png', mime: 'image/png', size: 3, path: '/tmp/plot' });
    expect((await store.visibleFile('alice', id))?.name).toBe('plot.png');
    expect(await store.visibleFile('robin', id)).toBeNull();
    const shown = await store.appendMessage({ conversationId: room.id, authorId: 'alice', role: 'assistant', display: 'shown', text: '', state: 'streaming' });
    await store.updateMessage(shown.id, { parts: [{ type: 'image', fileId: id, mime: 'image/png' }], state: 'done' });
    expect((await store.visibleFile('robin', id))?.id).toBe(id);
    await store.upsertPerson({ id: 'erin', name: 'Erin', kind: 'human' });
    expect(await store.visibleFile('erin', id)).toBeNull();
    const other = await store.createFile({ ownerId: 'alice', name: 'a.txt', mime: 'text/plain', size: 1, path: '/tmp/a' });
    await store.appendMessage({ conversationId: room.id, authorId: 'alice', role: 'human', text: '', parts: [{ type: 'file', fileId: other.id, name: 'a.txt', mime: 'text/plain', size: 1 }] });
    expect((await store.visibleFile('robin', other.id))?.id).toBe(other.id);
    await expect(store.appendMessage({ conversationId: room.id, authorId: 'alice', role: 'human', text: '', parts: [{ type: 'image', fileId: '00000000-0000-0000-0000-000000000000', mime: 'image/png' }] })).rejects.toMatchObject({ code: '23503' });
  });

  it('notices carry their kind and role/kind mismatches are refused', async () => {
    const manager = await store.createAgent({ id: 'notice-manager', name: 'Kenaznia', ownerId: 'alice', role: 'manager', goalId: null, model: 'm', sessionPath: '/tmp/nm', conversationTitle: 'Kenaznia' });
    const at = manager.conversationId;
    for (const notice of Object.keys(NOTICE_DISPLAY) as NoticeKind[])
      expect(await store.appendMessage({ conversationId: at, authorId: manager.id, role: 'notice', notice, text: notice })).toMatchObject({ role: 'notice', notice });
    const human = await store.appendMessage({ conversationId: at, authorId: 'alice', role: 'human', text: 'hi' });
    expect(human).toMatchObject({ notice: null });
    const raw = new pg.Pool({ connectionString: url });
    await expect(raw.query(
      `INSERT INTO message (id, conversation_id, seq, author_id, role, display, text, created_at, updated_at) VALUES (gen_random_uuid(), $1, (SELECT max(seq) + 1 FROM message WHERE conversation_id = $1), $2, 'notice', 'background', 'x', 1, 1)`,
      [at, manager.id])).rejects.toThrow(/message_notice/);
    await expect(raw.query(`UPDATE message SET notice = 'worker_note' WHERE id = $1`, [human.id])).rejects.toThrow(/message_notice/);
    await expect(raw.query(`UPDATE message SET notice = 'whatever' WHERE conversation_id = $1 AND role = 'notice'`, [at])).rejects.toThrow(/message_notice/);
    await raw.end();
  });

  it('display: notices by kind, agent messages by turn; previews and unread skip what is not shown', async () => {
    const manager = await store.createAgent({ id: 'display-manager', name: 'Kenaznia', ownerId: 'alice', role: 'manager', goalId: null, model: 'm', sessionPath: '/tmp/dm', conversationTitle: 'Kenaznia' });
    const at = manager.conversationId;
    const add = (m: Parameters<Store['appendMessage']>[0]) => store.appendMessage(m);
    const human = await add({ conversationId: at, authorId: 'alice', role: 'human', text: 'hi' });
    const reply = await add({ conversationId: at, authorId: manager.id, role: 'assistant', display: 'shown', text: 'hello' });
    const report = await add({ conversationId: at, authorId: 'w', role: 'notice', notice: 'worker_report', text: 'done' });
    const tool = await add({ conversationId: at, authorId: manager.id, role: 'tool', display: 'background', text: 'bash' });
    const quiet = await add({ conversationId: at, authorId: manager.id, role: 'assistant', display: 'silent', text: 'NO_REPLY' });
    expect([human, reply, report, tool, quiet].map(m => m.display)).toEqual(['shown', 'shown', 'background', 'background', 'silent']);
    await store.updateConversation(at, 'alice', { readThrough: reply.seq });
    const summary = (await store.getConversation(at, 'alice'))!;
    expect([summary.lastMessage, summary.lastSeq, unread(summary)]).toEqual([{ authorId: manager.id, preview: 'hello', at: reply.createdAt, seq: reply.seq }, quiet.seq, false]);
    expect((await store.updateMessage(tool.id, { display: 'shown' })).display).toBe('shown');
    await expect(add({ conversationId: at, authorId: manager.id, role: 'assistant', display: 'loud' as never, text: 'x' })).rejects.toThrow(/message_display/);
  });

  it('assigns seq atomically and gap-free under concurrent appends', async () => {
    const conv = await store.createConversation({ title: 'Busy', ownerId: 'alice', memberIds: [] });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      store.appendMessage({ conversationId: conv.id, authorId: 'alice', role: 'human', text: `m${i}` })));
    expect(results.map(m => m.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect((await store.getConversation(conv.id, 'alice'))!.lastSeq).toBe(60);
    const page = await store.listMessages(conv.id, { kind: 'latest' }, 25);
    expect([page.hasOlder, page.hasNewer]).toEqual([true, false]);
    expect(page.messages.map(m => m.seq)).toEqual(Array.from({ length: 25 }, (_, i) => 36 + i));
    const older = await store.listMessages(conv.id, { kind: 'before', seq: 36 }, 50);
    expect([older.hasOlder, older.hasNewer, older.messages.length, older.messages[0]!.seq]).toEqual([false, true, 35, 1]);
    const middle = await store.listMessages(conv.id, { kind: 'after', seq: 10 }, 5);
    expect([middle.hasOlder, middle.hasNewer, middle.messages.map(m => m.seq)]).toEqual([true, true, [11, 12, 13, 14, 15]]);
    const newest = await store.listMessages(conv.id, { kind: 'after', seq: 55 }, 50);
    expect([newest.hasOlder, newest.hasNewer, newest.messages.map(m => m.seq)]).toEqual([true, false, [56, 57, 58, 59, 60]]);
    expect(await store.getMessage(conv.id, newest.messages[0]!.id)).toEqual(newest.messages[0]);
    expect(await store.getMessage(conv.id, '00000000-0000-0000-0000-000000000000')).toBeNull();
    await expect(store.appendMessage({ conversationId: '00000000-0000-0000-0000-000000000000', authorId: 'alice', role: 'human', text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('clientId is unique: a duplicate append is rejected without consuming a seq', async () => {
    const conv = await store.createConversation({ title: 'Idem', ownerId: 'alice', memberIds: [] });
    const first = await store.appendMessage({ conversationId: conv.id, authorId: 'alice', role: 'human', text: 'hi', clientId: 'c-1' });
    await expect(store.appendMessage({ conversationId: conv.id, authorId: 'alice', role: 'human', text: 'hi', clientId: 'c-1' })).rejects.toMatchObject({ code: '23505' });
    expect(await store.getMessageByClientId('c-1')).toEqual(first);
    const next = await store.appendMessage({ conversationId: conv.id, authorId: 'kenaznia-alice', role: 'assistant', display: 'shown', text: '', state: 'streaming' });
    expect(next.seq).toBe(2);
    const done = await store.updateMessage(next.id, { text: 'hello', state: 'done', parts: [{ type: 'text', text: 'hello' }] });
    expect(done).toMatchObject({ text: 'hello', state: 'done', parts: [{ type: 'text', text: 'hello' }] });
  });

  it('latency report: percentile_cont over each interval, nulls ignored, window respected', async () => {
    const now = Date.now();
    const conv = '00000000-0000-0000-0000-000000000001';
    for (let i = 1; i <= 10; i++) {
      const id = `00000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`;
      await store.recordLatency({ messageId: id, conversationId: conv, clientSentAt: now - 100, receivedAt: now - 10 * i, admittedAt: now });
      if (i <= 4) await store.markLatency(id, 'first_token_at', now + 1000 * i);
    }
    // Only sets once.
    await store.markLatency('00000000-0000-0000-0000-000000000101', 'first_token_at', now + 99_999);
    // Outside the window.
    await store.recordLatency({ messageId: '00000000-0000-0000-0000-000000000999', conversationId: conv, clientSentAt: null, receivedAt: now - 7200_000 - 5000, admittedAt: now - 7200_000 });
    const r = await store.latencyReport(3600_000);
    expect(r.count).toBe(10);
    // receive→admit = 10..100 ms: p50 = 55, p90 = 91, p99 = 99.1, max = 100.
    expect(r.intervals.receiveToAdmit.p50).toBeCloseTo(55);
    expect(r.intervals.receiveToAdmit.p90).toBeCloseTo(91);
    expect(r.intervals.receiveToAdmit.p99).toBeCloseTo(99.1);
    expect(r.intervals.receiveToAdmit.max).toBe(100);
    // admit→first token = 1000..4000: p50 = 2500.
    expect(r.intervals.admitToFirstToken).toMatchObject({ p50: 2500, max: 4000 });
    expect(r.intervals.admitToFirstText).toEqual({ p50: null, p90: null, p99: null, max: null });
    expect(r.intervals.clientToAdmit.p50).toBe(100);
  });

  it('spend, usage samples, errors, files and sessions', async () => {
    const now = Date.now();
    await store.recordModelCall({ agentId: 'w1', model: 'm', inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.25, at: now });
    await store.recordModelCall({ agentId: 'w1', model: 'm', inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.5, at: now });
    await store.recordModelCall({ agentId: 'kenaznia-alice', model: 'm', inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0, costUsd: 1, at: now - 7200_000 });
    expect(await store.spend(now - 3600_000)).toEqual({ totalUsd: 0.75, byAgent: [{ agentId: 'w1', usd: 0.75 }] });
    const sample = (account: string, at: number) => ({ provider: 'anthropic', metric: 'weekly', account, percentLeft: 40.5, resetAt: null, windowHours: 168, readingAt: at - 5, at });
    await store.recordUsageSamples('broker:1', [sample('anthropic', now - 2000), sample('anthropic-2', now - 2000)], 0);
    await store.recordUsageSamples('broker:2', [sample('anthropic', now)], 0);
    await store.recordUsageSamples('broker:1', [sample('anthropic', now)], now - 1000);
    expect(await store.usageSamples('broker:1', 0)).toEqual([sample('anthropic', now)]);
    expect(await store.usageSamples('broker:2', now + 1)).toEqual([]);
    await store.logError('http', 'boom');
    await store.logError('agent:w1', 'mine');
    await store.logError('agent:someone-elses', 'theirs');
    const errors = await store.errorsAfter('alice', 0, 5);
    expect(errors.map(e => e.message)).toEqual(['mine', 'boom']);
    expect(await store.errorsAfter('alice', errors[0]!.id, 5)).toEqual([]);
    await store.savePendingInputs([{ agentId: 'w1', kind: 'agent', text: 'first', fromId: 'alice', conversationId: 'c' }, { agentId: 'w1', kind: 'human', text: 'second', fromId: 'alice', conversationId: 'c', humanMessageId: 'm' }]);
    expect((await store.takePendingInputs()).map(i => i.text)).toEqual(['first', 'second']);
    expect(await store.takePendingInputs()).toEqual([]);
    expect(await store.getHeartbeat('w1')).toBeNull();
    await store.saveHeartbeat('w1', { at: 5, checkedAt: 5, errorId: 7, goals: { g: 1 }, workers: { w: 'idle' }, alerts: ['a.md: A'], checklist: 'ab' });
    await store.saveHeartbeat('w1', { at: 5, checkedAt: 6, errorId: 8, goals: {}, workers: {}, alerts: [], checklist: null });
    expect(await store.getHeartbeat('w1')).toEqual({ at: 5, checkedAt: 6, errorId: 8, goals: {}, workers: {}, alerts: [], checklist: null });
    const { id } = await store.createFile({ ownerId: 'alice', name: 'a.txt', mime: 'text/plain', size: 3, path: '/tmp/a' });
    expect(await store.getFile(id)).toEqual({ id, ownerId: 'alice', name: 'a.txt', mime: 'text/plain', size: 3, path: '/tmp/a' });
    await store.createSession({ id: 's1', personId: 'alice', expiresAt: now + 1000 });
    expect(await store.getSession('s1')).toEqual({ id: 's1', personId: 'alice', expiresAt: now + 1000 });
    await store.deleteSession('s1');
    expect(await store.getSession('s1')).toBeNull();
  });
});
