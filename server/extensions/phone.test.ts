import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { briefLanguage, dial, inboundBrief, phoneLaneTask, phoneInstructions, pronounRule, speaker, startPhone, stopPhone, sweep, takeWithheld, telephoneConfig, unsayableNames, type PhoneCall } from './phone.js';

describe('telephone configuration', () => {
  it('treats an unset telephone as unavailable and rejects a malformed one or one without an inbound route', () => {
    expect(telephoneConfig(undefined).kind).toBe('unavailable');
    expect(() => telephoneConfig({ kind: 'configured', provider: 'retell-live', fromNumber: '343' })).toThrow();
    const line = { kind: 'configured', provider: 'retell-live', apiKeyPath: '/k', fromNumber: '+13435550100', publicBaseUrl: 'https://calls.example', maxCallSeconds: 600, privateNames: ['Alice'] };
    expect(() => telephoneConfig(line)).toThrow(/inbound/);
    const answered = { ...line, inbound: { kind: "answered", channel: "beta", ownerNumbers: ["+15105550100"] } };
    expect(telephoneConfig(answered).kind).toBe("configured");
    expect(() => telephoneConfig({ ...answered, privateNames: undefined })).toThrow(/privateNames/);
    expect(() => telephoneConfig({ ...answered, privateNames: [] })).toThrow(/privateNames/);
  });
});

describe('inbound brief', () => {
  it('gives a known caller the brief written for them and an unknown caller nothing about the owner', () => {
    const earlier = [{ direction: 'outbound' as const, name: 'Mme Roy', goal_id: null, placed_by_id: 'w1', call_agent_id: 'a1', brief: 'Permis 1234567890: ne parle pas de vente.', transcript: 'Person: Je vous rappelle lundi.', created_at: '1792335600000', end_reason: 'Kenan said goodbye' }];
    const known = inboundBrief('+15145550123', earlier, null);
    expect(known).toContain('Permis 1234567890: ne parle pas de vente.');
    expect(known).toContain('Je vous rappelle lundi.');
    const unknown = inboundBrief(null, [], null);
    expect(unknown).toContain('withheld');
    expect(unknown).not.toContain('Mme Roy');
  });
  // Call 9cbb9e63 (2026-10-21): Dave's Kenan line called again two minutes after its first call, and the voice was told
  // "Kenan has no earlier call with this number" and nothing about whose line it was.
  it("knows a household line and an earlier inbound call from it", () => {
    const first = { direction: 'inbound' as const, name: 'Caller +1 510 555 0142', goal_id: null, placed_by_id: 'manager:alice', call_agent_id: 'a1', brief: 'b', transcript: 'Person: Line test from Dave\'s Kenan.', created_at: '1792568078000', end_reason: 'hung up by Kenan' };
    const brief = inboundBrief('+15105550142', [first], { kind: 'kenan-line', personId: 'dave', name: 'Dave' });
    expect(brief).not.toContain('no earlier call');
    expect(brief).toContain('07:34Z inbound');
    expect(brief).toContain("Dave's Kenan line");
    expect(brief).toContain("Line test from Dave's Kenan.");
  });
});

describe('dialling through Retell', () => {
  afterEach(() => vi.unstubAllGlobals());
  const failure = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  const respond = (calls: (string | Response)[]) => {
    const fetch = vi.fn(async () => { const next = calls.shift()!; if (typeof next === 'string') throw failure(next); return next; });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const listed = (ids: string[]) => new Response(JSON.stringify(ids.map(call_id => ({ call_id }))));

  it('looks up a dial whose response was lost instead of calling it not placed', async () => {
    respond(['ECONNRESET', listed(['call_1'])]);
    expect(await dial('k', 'agent_1', {}, 0)).toEqual({ kind: 'placed', callId: 'call_1' });
    respond(['ECONNRESET', listed([]), listed([]), listed([])]);
    expect((await dial('k', 'agent_1', {}, 0)).kind).toBe('uncertain');
    respond([new Response('boom', { status: 502 }), 'ECONNRESET', 'ECONNRESET', 'ECONNRESET']);
    expect(await dial('k', 'agent_1', {}, 0)).toMatchObject({ kind: 'uncertain', why: expect.stringContaining('could not be asked') });
  });

  it('calls a dial that never reached Retell, or that Retell refused, not placed', async () => {
    const fetch = respond(['ECONNREFUSED']);
    expect(await dial('k', 'agent_1', {}, 0)).toMatchObject({ kind: 'not-placed', why: expect.stringContaining('ECONNREFUSED') });
    expect(fetch).toHaveBeenCalledTimes(1);
    respond([new Response('bad number', { status: 422 })]);
    expect((await dial('k', 'agent_1', {}, 0)).kind).toBe('not-placed');
  });
});

// Call 4533751d (2026-10-21): an English brief to Kenan's Canadian 343 line opened "Bonjour, ici Kenan" and stayed in French.
describe('the language of a call', () => {
  const brief = "Who: Kenan's own phone line. An AI assistant answers and no human is on it. This is a path check requested by Alice's Kenan after Dave's phone line moved to a new workspace and number. Goal: confirm the call connects. Say hello, say this is a line test from Dave's Kenan, then say goodbye and hang up within 30 seconds.";
  it('follows the brief, or the language it names, never the number', () => {
    expect(briefLanguage(brief)).toBe('English');
    expect(briefLanguage("Tu appelles Sam, d'un magasin de musique, au nom de Jordan, qui vend un piano usagé. But : lui dire que les offres sont attendues jeudi.")).toBe('French');
    expect(briefLanguage(`${brief}\nLanguage: French`)).toBe('French');
    expect(briefLanguage(`${brief} The menu is in French: press 1 for English.`)).toBe('English');
    const prompt = phoneInstructions({ id: 'dave', name: 'Dave', pronouns: 'he/him' } as never, { kind: 'configured', instructions: 'You are Kenan.', delegationPolicy: 'Delegate.', voice: 'v' }, { direction: 'outbound', brief, callbackNumber: '+15555550100', startedAt: new Date('2026-10-21T07:36:00Z') });
    expect(prompt).toContain('speak English from your first word');
    expect(prompt).toContain('Never choose a language from the phone number');
  });
});

// Alice's own calls went to Kenaznia, whose ~530k-token context took 8-12 s per answer (call 714bd84f); her calls now go
// to a phone lane that starts with what Kenaznia knows of her.
describe("the owner's phone lane", () => {
  it("starts with the owner's own context, Kenaznia's latest words with them, open goals and workers, not the shared worker files", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-'));
    writeFileSync(join(dir, 'OWN.md'), 'Alice is in Berkeley this week.');
    writeFileSync(join(dir, 'SHARED.md'), 'Host handbook.');
    const message = (role: string, text: string, display = 'shown') => ({ role, text, display, createdAt: Date.UTC(2026, 9, 21, 7, 0) });
    const deps: any = { store: {
      listMessages: async () => ({ messages: [message('human', 'Order me something sweet.'), message('assistant', 'Ordering a cinnamon roll.'), message('tool', 'ls'), message('assistant', 'NO_REPLY', 'silent')] }),
      listGoals: async () => [{ id: 'g1', title: 'Late-night carb food', priority: 0, notes: 'Sweet, not salty.' }],
      listAgents: async () => [{ id: 'w1', name: 'DoorDash order', role: 'worker', state: 'running', goalId: 'g1' }, { id: 'manager:alice', name: 'Kenaznia', role: 'manager', state: 'running', goalId: null }],
    } };
    const person: any = { id: 'alice', name: 'Alice', pronouns: 'she/her', worker: { contextFiles: [join(dir, 'SHARED.md')] } };
    const task = await phoneLaneTask(deps, person, { contextFiles: [join(dir, 'SHARED.md'), join(dir, 'OWN.md')] } as never, { managerId: 'manager:alice', managerConversationId: 'c', callId: 's1', from: '+15105550123', line: '+15555550100' });
    expect(task).toContain('Alice is in Berkeley this week.');
    expect(task).not.toContain('Host handbook.');
    expect(task).toContain('Alice: Order me something sweet.');
    expect(task).toContain('Kenaznia: Ordering a cinnamon roll.');
    expect(task).not.toContain('NO_REPLY');
    expect(task).toContain('g1 [p0] Late-night carb food');
    expect(task).toContain('w1 DoorDash order: running, goal Late-night carb food');
    expect(task).toContain('workers message');
  });
});

describe('pronouns on calls', () => {
  it('gives the owner\'s pronouns, and none when they are not known', () => {
    const alice = pronounRule('she/her', 'the person you assist');
    expect(alice).toContain('she/her');
    expect(alice).toContain("it's for her");
    expect(pronounRule(null, 'Erin')).toContain('never say he or she');
  });
});

// Call 739f50a8 (2026-10-19): a brief that named nobody got "Bonjour, ici Kenan, l'assistant d'Alice" on the line,
// because the voice prompt named the owner. Briefs may give the owner a work name such as "Jordan Lee"; "Alice" must never be said.
describe('the owner\'s name on calls', () => {
  const person = { id: 'alice', name: 'Alice', pronouns: 'she/her' } as never;
  const voice = { kind: 'configured', instructions: 'You are Kenan.', delegationPolicy: 'Delegate.', voice: 'v' } as const;
  const startedAt = new Date('2026-10-19T15:07:00Z');
  it('gives the voice no name for the owner but the brief\'s, in every direction', () => {
    for (const brief of ['Tester la ligne: dis bonjour puis au revoir.', "Tu appelles au nom de Jordan Lee, qui vend un piano."])
      for (const direction of ['outbound', 'inbound'] as const) {
        const prompt = phoneInstructions(person, voice, { direction, brief, callbackNumber: null, startedAt });
        expect(prompt).not.toMatch(/\bAlice\b/);
        expect(prompt).toContain('only by the name the brief gives');
      }
  });
  it('bans the owner\'s private names a brief does not use, as whole words in any case', () => {
    const banned = unsayableNames(['Alice', 'Alicia'], 'Au nom de Jordan Lee.')!;
    for (const said of ["Bonjour, ici Kenan, l'assistant d'Alice.", 'I work for alice.', "C'est pour Alicia."]) expect(said).toMatch(banned);
    for (const said of ['Ici Kenan, l\'assistant de Jordan Lee.', 'Le Sahara est loin.', 'Kenan, an AI assistant.']) expect(said).not.toMatch(banned);
    expect('Alice here').not.toMatch(unsayableNames(['Alice', 'Alicia'], 'The caller is Alice herself.')!);
    expect(unsayableNames(['Alice'], 'The caller is Alice herself.')).toBeNull();
  });
  it('does not speak a reply sentence that names the owner privately, and hands it back to the agent', () => {
    const sent: unknown[] = [];
    const call: PhoneCall = { id: 'c1', ownerId: 'alice', callAgentId: 'a1', placedById: 'p1', to: '+15145550100', token: Buffer.alloc(0), unsayable: unsayableNames(['Alice', 'Alicia'], 'Au nom de Jordan Lee.'), withheld: new Map(),
      attached: { sessionId: 's', socket: { send: (event: unknown) => sent.push(event) } as never, delegations: new Map([['d1', Date.now()]]), replies: new Map() } };
    const speak = speaker(call, 'd1')!;
    speak('Oui, Jordan Lee vend le piano.');
    speak('Alice vous rappellera demain.');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain('Alice vous');
    expect(takeWithheld(call, 'd1')).toEqual(['Alice vous rappellera demain.']);
    expect(takeWithheld(call, 'd1')).toEqual([]);
  });
});

describe.skipIf(!testDatabaseUrl)('phone calls across a restart', () => {
  it('delivers a call recorded as ended by its bridge, and a call whose bridge vanished, to their call agents, and keeps both as history', async () => {
    const url = await freshSchema('t_phone_restart');
    const delivered: any[] = [];
    const deps: any = { config: { databaseUrl: url, channel: 'test', people: [], dataDir: mkdtempSync(join(tmpdir(), 'phone-')) }, person: () => undefined, store: { getAgent: async (id: string) => ({ id, conversationId: 'c-' + id, archived: id === 'a3' }), logError: async () => {} }, runtime: { deliver: (input: any) => delivered.push(input) } };
    await startPhone(deps);
    await stopPhone();
    const db = new pg.Client({ connectionString: url }); await db.connect();
    await db.query(`INSERT INTO kenan_phone_call(id,owner_id,direction,name,call_agent_id,placed_by_id,to_number,token,brief,transcript,ended_at,end_reason,created_at) VALUES
      ('3aca2f3a-4f1a-4e35-8495-5fd3cb2a20db','alice','outbound','Buyer','a1','p1','+15145550100',$1,'b','Person: Tuesday works.',2,'telephone ended: user_hangup',1),
      ('4aca2f3a-4f1a-4e35-8495-5fd3cb2a20db','alice','inbound','Caller','a2','manager:alice',NULL,$1,'b','',NULL,NULL,1),
      ('5aca2f3a-4f1a-4e35-8495-5fd3cb2a20db','alice','outbound','Buyer','a3','p1','+15145550102',$1,'b','Person: call me Monday.',2,'telephone ended: user_hangup',1)`, [Buffer.alloc(32, 1)]);
    await startPhone(deps);
    await sweep(deps);
    const byAgent = Object.fromEntries(delivered.map(d => [d.agentId, d.text]));
    expect(byAgent.a1).toContain('Person: Tuesday works.');
    expect(byAgent.a1).toContain('user_hangup');
    expect(byAgent.a2).toContain('bridge exited');
    expect(byAgent.a3).toBeUndefined();
    expect(byAgent.p1).toContain('Person: call me Monday.');
    const rows = (await db.query('SELECT settled_at, ended_at FROM kenan_phone_call')).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.settled_at !== null && row.ended_at !== null)).toBe(true);
    await sweep(deps);
    expect(delivered).toHaveLength(3);
    await stopPhone(); await db.end();
  });
});
