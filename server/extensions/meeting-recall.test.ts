import { describe, it, expect } from 'vitest';
import { createRecallMeetingClient, normalizeRecallEvidence, loadExistingRecallGrant, remainingMeetingSeconds } from './meeting-recall.js';
const grant = { apiKey: 'fixture-only-secret', region: 'us-west-2' };
const botId = '11111111-2222-4333-8444-555555555555';
const input = { meetingUrl: 'https://meet.google.com/abc-defg-hij', effectId: 'reserved-fixture', durationSeconds: 120 };
describe('existing Recall join route', () => {
  it('creates transparent unrecorded Kenan once and does not confuse acceptance with admission', async () => {
    const seen: RequestInit[] = [];
    const client = createRecallMeetingClient(grant, async (_url, init) => {
      seen.push(init!); return Response.json({ id: botId, status_changes: [{ code: 'joining_call' }] }, { status: 201 });
    });
    expect((await client.join(input)).state).toBe('joining');
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.body as string);
    expect(body.bot_name).toBe('Kenan notetaker'); expect(body.recording_config).toBeNull();
    expect(body.metadata.effectId).toBe(input.effectId);
    expect(body.output_media).toBeUndefined();
  });
  it('normalizes actual admission, lobby, departure, fatal and unknown distinctly', () => {
    for (const [code, state] of [['in_call_not_recording', 'entered'], ['in_waiting_room', 'lobby'], ['done', 'left'], ['fatal', 'failed'], ['future_status', 'unknown']]) {
      expect(normalizeRecallEvidence(botId, { status_changes: [{ code }] }).state).toBe(state);
    }
    expect(normalizeRecallEvidence(botId, null).state).toBe('unknown');
  });
  it('inspects provider departure after leave ACK rather than declaring success', async () => {
    let calls = 0;
    const c = createRecallMeetingClient(grant, async () => ++calls === 1 ? Response.json({}) : Response.json({ status_changes: [{ code: 'in_call_not_recording' }] }));
    expect((await c.leave(botId)).state).toBe('entered'); expect(calls).toBe(2);
  });
  it('never retries uncertain create and never exposes provider body or credential', async () => {
    let calls = 0;
    const c = createRecallMeetingClient(grant, async () => { calls++; throw new Error(grant.apiKey); });
    await expect(c.join(input)).rejects.toThrow('uncertain'); expect(calls).toBe(1);
    const denied = createRecallMeetingClient(grant, async () => new Response(grant.apiKey, { status: 403 }));
    await expect(denied.join(input)).rejects.not.toThrow(grant.apiKey);
  });
  it('rejects foreign URL, unsafe bot identity and missing reservation before network', async () => {
    let calls = 0;
    const c = createRecallMeetingClient(grant, async () => { calls++; return Response.json({}); });
    await expect(c.join({ ...input, meetingUrl: input.meetingUrl + '?other=1' })).rejects.toThrow('URL');
    await expect(c.inspect('../other')).rejects.toThrow('identity');
    await expect(c.join({ ...input, effectId: '' })).rejects.toThrow('reservation');
    expect(calls).toBe(0);
  });
  it('loads only attached identity and exact existing production grant refs', async () => {
    const urls: string[] = [];
    const g = await loadExistingRecallGrant(async url => {
      urls.push(String(url));
      if (urls.length === 1) return Response.json({ access_token: 'fixture-machine-token' });
      return Response.json({ payload: { data: Buffer.from(urls.length === 2 ? grant.apiKey : grant.region).toString('base64') } });
    });
    expect(g).toEqual(grant); expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('/meeting-recall-api-key/versions/latest:access');
    expect(urls[2]).toContain('/meeting-recall-region/versions/latest:access');
    await expect(loadExistingRecallGrant(async () => new Response('private details', { status: 403 }))).rejects.toThrow('identity unavailable (403)');
  });
});

describe('uncertain create read-only reconciliation', () => {
  it('matches exact effect and room across pages then reads current original bot', async () => {
    const urls: string[] = [];
    const c = createRecallMeetingClient(grant, async (url, init) => {
      urls.push(String(url)); expect(init?.method).toBe('GET');
      if (urls.length === 1) return Response.json({ results: [{ id: botId, meeting_url: input.meetingUrl, metadata: { effectId: 'other' } }], next: 'https://us-west-2.recall.ai/api/v1/bot/?cursor=second' });
      if (urls.length === 2) return Response.json({ results: [{ id: botId, meeting_url: input.meetingUrl, metadata: { effectId: input.effectId } }], next: null });
      return Response.json({ status_changes: [{ code: 'done' }] });
    });
    expect(await c.reconcile(input.effectId, input.meetingUrl)).toMatchObject({ botId, state: 'left' });
    expect(urls).toHaveLength(3);
  });
  it('refuses ambiguous matches even when on later page', async () => {
    let calls = 0;
    const c = createRecallMeetingClient(grant, async () => Response.json({ results: [{ id: ++calls === 1 ? botId : 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', meeting_url: input.meetingUrl, metadata: { effectId: input.effectId } }], next: calls === 1 ? '?cursor=second' : null }));
    await expect(c.reconcile(input.effectId, input.meetingUrl)).rejects.toThrow('ambiguous');
  });
  it('never follows foreign next links or unbounded lists', async () => {
    let calls = 0;
    const foreign = createRecallMeetingClient(grant, async () => { calls++; return Response.json({ results: [], next: 'https://evil.example/api/v1/bot/' }); });
    await expect(foreign.reconcile(input.effectId, input.meetingUrl)).rejects.toThrow('foreign'); expect(calls).toBe(1);
    const endless = createRecallMeetingClient(grant, async () => Response.json({ results: [], next: '?cursor=' + ++calls }));
    calls = 0; await expect(endless.reconcile(input.effectId, input.meetingUrl)).rejects.toThrow('page bound'); expect(calls).toBe(5);
  });
  it('null only after complete scan and ignores same effect in different room', async () => {
    const c = createRecallMeetingClient(grant, async () => Response.json({ results: [{ id: botId, meeting_url: 'https://meet.google.com/xxx-yyyy-zzz', metadata: { effectId: input.effectId } }], next: null }));
    expect(await c.reconcile(input.effectId, input.meetingUrl)).toBeNull();
    const malformed = createRecallMeetingClient(grant, async () => Response.json({}));
    await expect(malformed.reconcile(input.effectId, input.meetingUrl)).rejects.toThrow('incomplete');
  });
});

describe('event-bounded lobby lifetime', () => {
  it('uses remaining event duration instead of the old two-minute lobby cutoff', async () => {
    const seen: RequestInit[] = [];
    const client = createRecallMeetingClient(grant, async (_url, init) => {
      seen.push(init!); return Response.json({ id: botId, status_changes: [{ code: 'in_waiting_room' }] });
    });
    for (const durationSeconds of [30,1791,14400]) {
      expect((await client.join({...input,durationSeconds})).state).toBe('lobby');
      const body=JSON.parse(seen.at(-1)!.body as string);
      expect(body.automatic_leave.waiting_room_timeout).toBe(durationSeconds);
      expect(body.automatic_leave.in_call_not_recording_timeout).toBe(durationSeconds);
      expect(body.recording_config).toBeNull();
    }
  });
  it('floors fractional seconds, caps duration, and refuses expired/too-short/invalid events', () => {
    expect(remainingMeetingSeconds(1791999,0)).toBe(1791);
    expect(remainingMeetingSeconds(99999999,0)).toBe(14400);
    for(const end of [0,-1,29999,NaN,Infinity]) expect(()=>remainingMeetingSeconds(end,0)).toThrow('remaining duration');
  });
  it('host denial is terminal departure, never admission or another create', async () => {
    let calls=0;
    const client=createRecallMeetingClient(grant,async(_url,init)=>{
      calls++; expect(init?.method).toBe('GET');
      return Response.json({status_changes:[{code:'call_ended',sub_code:'bot_rejected'}]});
    });
    expect((await client.inspect(botId)).state).toBe('left'); expect(calls).toBe(1);
  });
});
