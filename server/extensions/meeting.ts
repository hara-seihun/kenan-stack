import {meetingGenerationId} from './meeting-generation.js';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Type } from 'typebox';
import type { Deps, Extension } from '../types.js';
import type { PersonConfig } from '../config.js';
import { createRecallMeetingClient, loadExistingRecallGrant, remainingMeetingSeconds, type RecallEvidence } from './meeting-recall.js';
import { callMeetingBrowser, type BrowserAdapterConfig } from './meeting-browser-port.js';
import { joinMeeting } from './meeting-controller.js';
import { providerObservation, watchdogAction, type ProviderSession } from './meeting-session.js';
import { personOf } from '../http/app.js';
import { fail } from '../db/errors.js';
import { renderMeetingMediaPage } from './meeting-media.js';
import { ingestCaption } from './meeting-captions.js';
import { ownerProcess } from '../tools/owner.js';
import { assertObserverSuccess, createObserverHealth } from './meeting-observer.js';
import { receiptPath, reconcileRead, preserveReadLineage, type ReadState } from './meeting-receipt.js';
import { loadKenanSlackBot, lobbyPingDue, type LobbyPings } from './meeting-lobby.js';

export interface MeetingObservation {
  at: string;
  coverage: { kind: string; unknownCalendars: string[] };
  snapshot: { meetings: ObservedMeeting[]; withdrawnEventKeys: string[] };
}
export interface ObservedMeeting {
  eventKey: string; eventId: string; title: string; meetingUrl: string; organizerEmail: string;
  startAt: string; endAt: string; fingerprint: string;
  attendance: { included: boolean };
}
export function eligibleMeetings(proof: MeetingObservation, now: number): ObservedMeeting[] {
  const age = now - Date.parse(proof.at);
  if (!Number.isFinite(age) || age < -5000 || age > 60000) throw new Error('Meeting observation is stale');
  if (proof.coverage.kind !== 'complete' || proof.coverage.unknownCalendars.length) throw new Error('Meeting calendar coverage is incomplete');
  if (!Array.isArray(proof.snapshot.meetings) || !Array.isArray(proof.snapshot.withdrawnEventKeys)) throw new Error('Invalid meeting snapshot');
  for (const meeting of proof.snapshot.meetings) {
    if (!meeting.eventKey || !meeting.fingerprint || typeof meeting.attendance?.included !== 'boolean' || typeof meeting.organizerEmail !== 'string'
      || !Number.isFinite(Date.parse(meeting.startAt)) || !Number.isFinite(Date.parse(meeting.endAt))
      || Date.parse(meeting.endAt) <= Date.parse(meeting.startAt)) throw new Error('Invalid meeting observation');
  }
  return proof.snapshot.meetings.filter(m => m.attendance.included && !proof.snapshot.withdrawnEventKeys.includes(m.eventKey)
    && Date.parse(m.startAt) <= now + 30 * 60000 && Date.parse(m.endAt) > now);
}
export const browserMeetingState = (reply: { state?: string; observation?: unknown }) => {
  // The guarded adapter classifies complete origin-bound snapshots; never infer from a click ACK.
  if (reply.state==='entered' || reply.state==='left' || reply.state==='lobby') return reply.state;
  return 'unknown' as const;
};
export function activeProviderEvidence(data: ProviderSession, now: number): boolean {
  return data.phase==='active' && Number.isFinite(data.endsAt) && data.endsAt>now
    && Number.isFinite(data.lastObservedAt) && data.lastObservedAt<=now && now-data.lastObservedAt<=60000;
}

interface Settings { recallEnabled?: boolean; periodicEnabled?: boolean; joiningEnabled?: boolean; browser?: BrowserAdapterConfig; observer: { executable: string; args: string[]; snapshotPath: string }; }
export function createMeetingExtension(): Extension {
  let deps: Deps, pool: pg.Pool | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const observerHealth = createObserverHealth();
  const observations = new Map<string, { at: string; eligible: number }>();
  const settings = async (person: PersonConfig): Promise<Settings> => {
    const config = person.extensionConfigPath ? JSON.parse(await readFile(person.extensionConfigPath, 'utf8')).tools?.meeting : undefined;
    if (!config?.observer?.executable || !Array.isArray(config.observer.args) || !config.observer.snapshotPath) throw new Error('Meeting observer is not configured');
    return config as Settings;
  };
  const inflight = new Map<string, Promise<{ observedAt: string; meetings: ObservedMeeting[] }>>();
  const observeOnce = async (person: PersonConfig, operationId: string) => {
    const config = await settings(person);
    const result = await ownerProcess(deps.placement, person, config.observer.executable, [...config.observer.args, '--observer-op', operationId, '--observer-receipt', receiptPath(config.observer.snapshotPath, operationId)], undefined, undefined, undefined, 90, deps.placement?.kind==='channelScope'?`agent-tool-${deps.placement.channel}-meeting-${operationId}.scope`:undefined);
    assertObserverSuccess(result, deps.now());
    const proof = JSON.parse(await readFile(config.observer.snapshotPath, 'utf8')) as MeetingObservation;
    const meetings = eligibleMeetings(proof, deps.now());
    for (const m of meetings) {
      const id = createHash('sha256').update(`${person.id}\0${m.eventKey}`).digest('hex');
      await pool!.query(`INSERT INTO kenan_meeting_sessions(id,owner_id,event_key,data) VALUES($1,$2,$3,$4)
        ON CONFLICT(owner_id,event_key) DO UPDATE SET data=excluded.data`, [id, person.id, m.eventKey, m]);
    }
    // Withdrawal and time expiry do not silently leave an active provider session.
    // They surface to the current manager, which owns provider cleanup.
    const sessions = await pool!.query('SELECT id,data,phase,notice_key FROM kenan_meeting_sessions WHERE owner_id=$1', [person.id]);
    const manager = deps.runtime.managerFor(person.id);
    for (const row of sessions.rows) {
      const current = meetings.find(m => m.eventKey === (row.data as ObservedMeeting).eventKey);
      const phase = !current ? 'withdrawn' : Date.parse(current.startAt) <= deps.now() ? 'due' : 'upcoming';
      const noticeKey = `${phase}:${current?.fingerprint ?? 'absent'}`;
      if (row.notice_key === noticeKey) continue;
      await pool!.query('UPDATE kenan_meeting_sessions SET phase=$2 WHERE id=$1', [row.id, phase]);
      if (manager) {
        const agent = await deps.store.getAgent(manager);
        if (agent) { deps.runtime.deliver({ agentId: manager, kind: 'external', fromId: 'system', conversationId: agent.conversationId,
          text: `Meeting ${phase}: ${JSON.stringify({ sessionId: row.id, ...row.data, observedAt: proof.at })}. This is discovery, not a join receipt. Use meeting join only through the configured guarded WORK adapter; recheck fresh policy before provider join; respect withdrawals and end time, and clean up any active session.` });
          await pool!.query('UPDATE kenan_meeting_sessions SET notice_key=$2 WHERE id=$1', [row.id, noticeKey]);
        }
      }
    }
    observations.set(person.id,{at:proof.at,eligible:meetings.length});
    return { observedAt: proof.at, meetings };
  };
  const observe = (person: PersonConfig) => {
    const prior = inflight.get(person.id);
    if (prior) return prior;
    const task = (async () => {
      observerHealth.assertReady(person.id, deps.now());
      const prior = observerHealth.status(person.id), config = await settings(person);
      const operationId = randomUUID();
      const pendingState: ReadState = {
        ...((prior as ReadState | null)?.interruptedRead ? {interruptedRead:(prior as ReadState).interruptedRead} : {}),
        ...((prior as ReadState | null)?.priorInterruptedReads ? {priorInterruptedReads:(prior as ReadState).priorInterruptedReads} : {}),
        lastAttemptAt: new Date(deps.now()).toISOString(), lastSuccessAt: prior?.lastSuccessAt ?? null,
        consecutiveFailures: prior?.consecutiveFailures ?? 0, lastError: 'Meeting read admission unsettled',
        nextPeriodicAttemptAt: new Date(deps.now()).toISOString(), retryBlocked: true,
        pendingRead: { operationId, receiptPath: receiptPath(config.observer.snapshotPath, operationId),
          snapshotPath: config.observer.snapshotPath, ownerUid: person.uid,
          ...(deps.placement?.kind==='channelScope'?{launchUnit:`agent-tool-${deps.placement.channel}-meeting-${operationId}.scope`,launcher:{pid:process.pid,bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),startTicks:(await readFile(`/proc/${process.pid}/stat`,'utf8')).split(') ')[1]!.split(' ')[19]!}}:{}),
          repairOwner: deps.runtime.managerFor(person.id), admittedAt: deps.now(), reconcileAt: deps.now()+95000 },
      };
      // Persist before launch. A failed result commit retains the original UUID, never a new request.
      await pool!.query('INSERT INTO kenan_meeting_observer_health(owner_id,data) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET data=excluded.data', [person.id,pendingState]);
      observerHealth.restore(person.id,pendingState);
      try {
        const proof = await observeOnce(person, operationId);
        // This caller observed actual child completion and validated the snapshot.
        // Only restart/uncertain completion requires the retained receipt.
        const {pendingRead: _pending, ...completed} = pendingState;
        observerHealth.restore(person.id,{...completed,retryBlocked:false});
        observerHealth.success(person.id,deps.now(),proof.observedAt);
        observerHealth.restore(person.id,preserveReadLineage(observerHealth.status(person.id)!,pendingState));
        const committed = await pool!.query("UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1 AND data->'pendingRead'->>'operationId'=$3 RETURNING owner_id", [person.id,observerHealth.status(person.id),operationId]);
        if (!committed.rowCount) throw new Error('Meeting read settlement changed');
        return proof;
      } catch (error) {
        observerHealth.restore(person.id,pendingState);
        // A timeout, signal or missing receipt is uncertainty, not permission to retry upstream.
        const settled = await reconcileRead(pendingState,deps.now());
        try {
          const updated = await pool!.query("UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1 AND data->'pendingRead'->>'operationId'=$3 RETURNING owner_id", [person.id,settled.state,operationId]);
          if (updated.rowCount) observerHealth.restore(person.id,settled.state);
        } catch { /* Keep protected in memory and in the original write-ahead record. */ }
        throw error;
      }
    })().finally(() => { inflight.delete(person.id); });
    inflight.set(person.id, task);
    return task;
  };
  const recallClient = async()=>createRecallMeetingClient(await loadExistingRecallGrant());
  const normalizedRecall = (e: RecallEvidence) => ({providerSessionId:e.botId,observedAt:Date.parse(e.observedAt),state:e.state==='entered'||e.state==='left'||e.state==='lobby'?e.state:'unknown' as const});
  const recallIdentity = async(person:PersonConfig,meeting:ObservedMeeting)=>{
    const baseId=createHash('sha256').update(`${person.id}\0${meeting.eventKey}`).digest('hex');
    const prior=(await pool!.query('SELECT data FROM kenan_meeting_provider WHERE id=$1 AND owner_id=$2',[baseId,person.id])).rows[0]?.data as ProviderSession|undefined;
    return {baseId,sessionId:meetingGenerationId(baseId,meeting,prior,deps.now())};
  };
  const joinRecall = async(person:PersonConfig, meeting:ObservedMeeting, observedAt:string, conversationId:string)=>{
    const {sessionId,baseId}=await recallIdentity(person,meeting);
    const request={sessionId,ownerId:person.id,conversationId,meetingUrl:meeting.meetingUrl,endsAt:Date.parse(meeting.endAt),observedAt:Date.parse(observedAt),included:true};
    const client=await recallClient();
    return joinMeeting(request,deps.now(),{
      reserve:async r=>!!(await pool!.query('INSERT INTO kenan_meeting_provider(id,owner_id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[r.sessionId,r.ownerId,{...r,baseSessionId:baseId,providerKind:'recall',providerSessionId:'',phase:'unknown',lastObservedAt:r.observedAt}])).rowCount,
      save:async session=>{await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[session.sessionId,{...session,baseSessionId:baseId,providerKind:'recall',meetingUrl:meeting.meetingUrl}]);},
      join:async()=>normalizedRecall(await client.join({meetingUrl:meeting.meetingUrl,effectId:sessionId,durationSeconds:remainingMeetingSeconds(request.endsAt,deps.now())})),
    });
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const person of deps.config.people.filter(p => p.manager && p.extensions.includes('meeting'))) {
        try {
          const config = await settings(person);
          if(config.periodicEnabled===false) continue;
          let retained=observerHealth.status(person.id) as ReadState|null;
          if(retained?.interruptedRead && retained.lastError==='Meeting observer interrupted; original server result and retry hint unknown' && retained.retryBlocked && !retained.pendingRead && (retained.retryNotBefore??0)<=deps.now()){
            // Apply the current read-only recovery disposition to already retained
            // interruptions too. No effect/join is replayed; observe() mints a UUID.
            retained={...retained,retryBlocked:false};
            await pool!.query('UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1',[person.id,retained]);observerHealth.restore(person.id,retained);
          }
          if(retained?.interruptedRead && !retained.interruptedRead.noticedAt){
            const manager=deps.runtime.managerFor(person.id),agent=manager?await deps.store.getAgent(manager):null;
            if(agent){
              // Commit the notification claim before delivery, so a restart cannot spam it.
              const next={...retained,interruptedRead:{...retained.interruptedRead,noticedAt:deps.now()}};
              await pool!.query('UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1',[person.id,next]);observerHealth.restore(person.id,next);
              deps.runtime.deliver({agentId:agent.id,conversationId:agent.conversationId,kind:'external',fromId:'system',text:`Meeting observer interrupted ${retained.interruptedRead.operationId}: exact original process ended without a terminal receipt. No detector success/failure or server retry hint is known. Original identity retained; no original operation replay. Explicit current read-only recovery policy admits a new discovery identity after proven process cessation, respecting recorded server deadlines.`});
            }
          }
          if(retained?.retryBlocked && !retained.pendingRead && !retained.interruptedRead && deps.now()>=(retained.legacyRepairWakeAt??0)){
            const manager=deps.runtime.managerFor(person.id),agent=manager?await deps.store.getAgent(manager):null;
            if(agent){deps.runtime.deliver({agentId:agent.id,conversationId:agent.conversationId,kind:'external',fromId:'system',text:'Owned meeting read repair: legacy protected unknown without retained original read UUID/receipt. Do not clear or replay upstream reads by timer; reconcile original operation custody. Automatic repair wake continues every5min.'});
              const next={...retained,legacyRepairWakeAt:deps.now()+300000};await pool!.query('UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1',[person.id,next]);observerHealth.restore(person.id,next);
            }
          }
          if(retained?.pendingRead && deps.now()>=retained.pendingRead.reconcileAt){
            const result=await reconcileRead(retained,deps.now());
            // CAS prevents an old receipt or delayed reconciliation settling a new read.
            const updated=await pool!.query("UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1 AND data->'pendingRead'->>'operationId'=$3 RETURNING owner_id",[person.id,result.state,retained.pendingRead.operationId]);
            if(updated.rowCount){observerHealth.restore(person.id,result.state);
              if(!result.settled && result.state.pendingRead && deps.now()>=(retained.pendingRead.repairWakeAt??0)){
                const originalOwner=retained.pendingRead.repairOwner,originalAgent=originalOwner?await deps.store.getAgent(originalOwner):null;
                const agent=originalAgent&&!originalAgent.archived?originalAgent:await deps.store.getAgent(deps.runtime.managerFor(person.id)??'');const manager=agent?.id??originalOwner;
                if(agent){deps.runtime.deliver({agentId:agent.id,conversationId:agent.conversationId,kind:'external',fromId:'system',text:`Owned meeting read repair ${retained.pendingRead.operationId}: original process ${result.process??'unknown'}, terminal receipt unavailable. Protected unknown, no upstream replay. Reconcile exact receipt ${retained.pendingRead.receiptPath}; do not timer-clear an unknown server hint. Repair owner ${manager}; automatic receipt reconciliation remains every30s.`});
                  const next={...result.state,pendingRead:{...result.state.pendingRead!,repairOwner:manager,repairWakeAt:deps.now()+300000}};
                  await pool!.query("UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1 AND data->'pendingRead'->>'operationId'=$3",[person.id,next,retained.pendingRead.operationId]);observerHealth.restore(person.id,next);
                }
              }
            }
            continue;
          }
          if (!observerHealth.ready(person.id, deps.now())) continue;
          let proof: {observedAt:string;meetings:ObservedMeeting[]};
          try { proof = await observe(person); }
          catch {
            await deps.store.logError('meeting-observer', JSON.stringify({ownerId:person.id,...observerHealth.status(person.id)}));
            // No joins or policy-dependent cleanup from failed/unknown discovery.
            continue;
          }
          if(config.recallEnabled && config.joiningEnabled){
            const manager=deps.runtime.managerFor(person.id),agent=manager?await deps.store.getAgent(manager):null;
            if(agent) for(const m of proof.meetings.filter(m=>Date.parse(m.startAt)<=deps.now())) {
              const {sessionId:id}=await recallIdentity(person,m);
              if(!(await pool!.query('SELECT 1 FROM kenan_meeting_provider WHERE id=$1',[id])).rowCount) {
                try{await joinRecall(person,m,proof.observedAt,agent.conversationId);}catch(error){await deps.store.logError('meeting-join',error instanceof Error?error.message:'Recall join failed; original reservation retained');}
              }
            }
          }
          if (config.browser || config.recallEnabled) {
            const sessions = await pool!.query('SELECT data FROM kenan_meeting_provider WHERE owner_id=$1',[person.id]);
            for (const row of sessions.rows) {
              try {
              let session = row.data as ProviderSession & {providerKind?:string;meetingUrl?:string};
              if(session.providerKind==='recall'){
                if(!session.providerSessionId){
                  const original=session.meetingUrl?await (await recallClient()).reconcile(session.sessionId,session.meetingUrl):null;
                  if(!original)continue; // original remains uncertain; never create again
                  session=providerObservation({...session,providerSessionId:original.botId},normalizedRecall(original));
                  await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[session.sessionId,session]);
                }
                const client=await recallClient();
                const meeting=proof.meetings.find(m=>createHash('sha256').update(`${person.id}\0${m.eventKey}`).digest('hex')===((session as ProviderSession&{baseSessionId?:string}).baseSessionId??session.sessionId));
                const action=watchdogAction(session,deps.now(),!!meeting);
                if(action!=='none'){
                  if(action==='leave'){
                    await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[session.sessionId,{...session,phase:'leaving'}]);
                    const prior=await client.inspect(session.providerSessionId);
                    if(prior.state!=='left')await client.leave(session.providerSessionId);
                  }
                  const observed=normalizedRecall(await client.inspect(session.providerSessionId));
                  const next=providerObservation(session,observed);
                  const pings:LobbyPings=(row.data as {lobbyPings?:LobbyPings}).lobbyPings??[];
                  const ping=action==='observe'&&meeting?lobbyPingDue(observed.state,pings,deps.now(),session.endsAt,meeting.title):null;
                  const lobbyPings=ping?[...pings,deps.now()]:pings;
                  // Recorded before sending: a crash mid-send loses a ping rather than repeating one.
                  await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[session.sessionId,{...next,providerKind:'recall',lobbyPings,...(action==='leave'&&next.phase!=='ended'?{phase:'leaving'}:{})}]);
                  if(ping&&meeting){
                    const sent=await (await loadKenanSlackBot()).send(meeting.organizerEmail,ping.text);
                    if(!sent.ok)await deps.store.logError('meeting-lobby-ping',JSON.stringify({sessionId:session.sessionId,kind:ping.kind,host:meeting.organizerEmail,error:sent.error}));
                  }
                }
                continue;
              }
              if(!config.browser)continue;
              const meeting = proof.meetings.find(m=>createHash('sha256').update(`${person.id}\0${m.eventKey}`).digest('hex')===session.sessionId);
              const action = watchdogAction(session,deps.now(),!!meeting);
              if (action==='leave' && session.phase!=='leaving') {
                // Mark before dispatch so process death cannot replay an uncertain leave click.
                await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[session.sessionId,{...session,phase:'leaving'}]);
                await callMeetingBrowser(config.browser,{action:'leave',session:session.providerSessionId});
              } else if (action==='observe' || session.phase==='leaving') {
                // Reconcile the original tab only. No new prepare/open/join here.
                const reply = await callMeetingBrowser(config.browser,{action:'inspect',session:session.providerSessionId});
                const observed = providerObservation(session,{providerSessionId:session.providerSessionId,observedAt:deps.now(),state:browserMeetingState(reply)});
                await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[session.sessionId,session.phase==='leaving'&&observed.phase!=='ended'?{...observed,phase:'leaving'}:observed]);
              }
              }catch(error){await deps.store.logError('meeting-cleanup',error instanceof Error?error.message:'Provider cleanup failed; original identity retained');}
            }
          }
        } catch (error) { await deps.store.logError('meeting', error instanceof Error ? error.message : 'Meeting observation failed'); }
      }
    } finally { running = false; }
  };
  return { id: 'meeting', name: 'Meetings',
    promptSnippet: 'Meeting discovery is read-only. A due notice is not proof of joining. Do not join unless current adapter readiness is established and joiningEnabled is explicitly true. Recheck for fresh attendance policy before acting. Never revive retired meeting executors.',
    async start(d) {
      deps = d; pool = new pg.Pool({ connectionString: d.config.databaseUrl, max: 2 });
      await pool.query(`CREATE TABLE IF NOT EXISTS kenan_meeting_sessions(id text PRIMARY KEY,owner_id text NOT NULL,event_key text NOT NULL,data jsonb NOT NULL,phase text NOT NULL DEFAULT 'new',notice_key text,UNIQUE(owner_id,event_key))`);
      await pool.query('CREATE TABLE IF NOT EXISTS kenan_meeting_observer_health(owner_id text PRIMARY KEY,data jsonb NOT NULL)');
      for (const row of (await pool.query('SELECT owner_id,data FROM kenan_meeting_observer_health')).rows) observerHealth.restore(row.owner_id,row.data);
      await pool.query('CREATE TABLE IF NOT EXISTS kenan_meeting_provider(id text PRIMARY KEY,owner_id text NOT NULL,data jsonb NOT NULL)');
      // Only the channel with the configured manager owns periodic observation.
      timer = setInterval(() => { void tick(); }, 30000); timer.unref();
    },
    async stop() { if (timer) clearInterval(timer); await Promise.allSettled(inflight.values()); await pool?.end(); pool = undefined; },
    routes(app) {
      app.get('/status', async c => {
        const ownerId=personOf(c),person=deps.person(ownerId);
        if (!person?.extensions.includes('meeting')) fail('forbidden','Meetings are not enabled');
        return c.json({ok:true,value:{pollIntervalMs:30000,periodicOwner:!!person!.manager&&(await settings(person!)).periodicEnabled!==false,currentManager:deps.runtime.managerFor(ownerId),lastObservation:observations.get(ownerId)??null,observerHealth:observerHealth.status(ownerId),providerSessions:(await pool!.query('SELECT data FROM kenan_meeting_provider WHERE owner_id=$1',[ownerId])).rows.map(row=>row.data as ProviderSession),joiningEnabled:(await settings(person!)).joiningEnabled===true,provider:(await settings(person!)).recallEnabled?'recall':'guarded-browser',authentication:'not-inferred',legacyExecutor:false}});
      });
      app.post('/recheck', async c => {
        const person=deps.person(personOf(c));
        if (!person?.extensions.includes('meeting')) fail('forbidden','Meetings are not enabled');
        return c.json({ok:true,value:await observe(person!)});
      });
      app.get('/:sessionId/media', async c => {
        const ownerId = personOf(c), person = deps.person(ownerId);
        if (!person?.extensions.includes('meeting') || !person.extensions.includes('voice')) fail('forbidden','Meeting voice is not enabled');
        const sessionId = c.req.param('sessionId');
        const session = (await pool!.query('SELECT data FROM kenan_meeting_provider WHERE id=$1 AND owner_id=$2',[sessionId,ownerId])).rows[0]?.data as ProviderSession | undefined;
        if (!session || !activeProviderEvidence(session,deps.now())) fail('not_found','Active meeting session not found');
        return c.html(renderMeetingMediaPage({meetingId:sessionId,conversationId:session!.conversationId,voiceStartUrl:'/api/ext/voice/start',voiceBaseUrl:'/api/ext/voice'}));
      });
      // Current rewrite authenticated owner route, not a public/legacy Recall webhook.
      app.post('/:sessionId/captions', async c => {
        const ownerId = personOf(c), person = deps.person(ownerId);
        if (!person?.extensions.includes('meeting')) fail('forbidden','Meetings are not enabled');
        const raw = await c.req.text();
        if (Buffer.byteLength(raw,'utf8') > 131072) fail('invalid_input','Caption packet is too large');
        const body = JSON.parse(raw) as {eventId:string;text:string;isFinal:boolean;at:number;speaker?:string;speakerId?:string};
        const sessionId = c.req.param('sessionId');
        const proof = await observe(person!);
        const provider = (await pool!.query('SELECT data FROM kenan_meeting_provider WHERE id=$1 AND owner_id=$2',[sessionId,ownerId])).rows[0]?.data as ProviderSession | undefined;
        if (!provider) fail('not_found','Meeting provider session not found');
        const result = await ingestCaption({sessionId,eventId:body.eventId,ownerId,conversationId:provider!.conversationId,text:body.text,isFinal:body.isFinal,at:body.at,...(body.speaker!==undefined?{speaker:body.speaker}:{}),...(body.speakerId!==undefined?{speakerId:body.speakerId}:{})}, {
          resolveSession: async id => {
            const data = (await pool!.query('SELECT data FROM kenan_meeting_provider WHERE id=$1 AND owner_id=$2',[id,ownerId])).rows[0]?.data as ProviderSession | undefined;
            const meeting = proof.meetings.find(m=>createHash('sha256').update(`${ownerId}\0${m.eventKey}`).digest('hex')===id);
            if (!data || !activeProviderEvidence(data,deps.now()) || !meeting) return null;
            return {...data,phase:'active' as const,source:{channel:deps.config.channel,eventKey:meeting.eventKey,fingerprint:meeting.fingerprint,organizerEmail:meeting.organizerEmail,startAt:meeting.startAt,endAt:meeting.endAt}};
          },
          getMessageByClientId:id=>deps.store.getMessageByClientId(id),
          appendMessage:message=>deps.store.appendMessage(message),
        });
        if (result.status==='appended' && result.message) {
          const message = await deps.store.getMessageByClientId(result.message.clientId);
          if (message) {
            deps.bus.toConversation(message.conversationId,{type:'message',message});
            const conversation = await deps.store.getConversation(message.conversationId,ownerId);
            if (conversation?.agentId) deps.runtime.deliver({agentId:conversation.agentId,kind:'external',fromId:`meeting:${sessionId}`,conversationId:message.conversationId,text:`Meeting caption (${sessionId}): ${body.text}`});
          }
        }
        return c.json({ok:true,value:result});
      });
    },
    tool: ctx => ({ name: 'meeting', files: 'none', label: 'Meetings', description: 'List discovered meetings or recheck fresh Calendar and attendance policy. Join requires fresh policy and the configured guarded WORK adapter; inspect reconciles existing effects; leave requests cleanup without assuming completion.',
      parameters: Type.Object({ action: Type.Union([Type.Literal('status'), Type.Literal('list'), Type.Literal('recheck'), Type.Literal('join'), Type.Literal('inspect'), Type.Literal('leave')]) , sessionId: Type.Optional(Type.String()) }),
      execute: async (_id, raw: unknown) => {
        const args = raw as { action: string; sessionId?: string };
        if (args.action==='status') {
          const config=await settings(ctx.person);
          const value={pollIntervalMs:30000,periodicOwner:!!ctx.person.manager&&(await settings(ctx.person)).periodicEnabled!==false,currentManager:deps.runtime.managerFor(ctx.person.id),lastObservation:observations.get(ctx.person.id)??null,observerHealth:observerHealth.status(ctx.person.id),providerSessions:(await pool!.query('SELECT data FROM kenan_meeting_provider WHERE owner_id=$1',[ctx.person.id])).rows.map(row=>row.data as ProviderSession),joiningEnabled:config.joiningEnabled===true,provider:config.recallEnabled?'recall':'guarded-browser',authentication:'not-inferred',legacyExecutor:false};
          return {content:[{type:'text',text:JSON.stringify(value)}],details:{}};
        }
        if (['join','inspect','leave'].includes(args.action)) {
          if (!args.sessionId) throw new Error('sessionId required');
          const config = await settings(ctx.person);
          if (args.action==='join' && config.recallEnabled && config.joiningEnabled) {
            const proof=await observe(ctx.person),meeting=proof.meetings.find(m=>createHash('sha256').update(`${ctx.person.id}\0${m.eventKey}`).digest('hex')===args.sessionId);
            if(!meeting) throw new Error('Fresh eligible meeting required');
            const session=await joinRecall(ctx.person,meeting,proof.observedAt,ctx.agent.conversationId);
            return {content:[{type:'text',text:JSON.stringify(session)}],details:{}};
          }
          if(args.action!=='join'){
            const prior=(await pool!.query('SELECT data FROM kenan_meeting_provider WHERE id=$1 AND owner_id=$2',[args.sessionId,ctx.person.id])).rows[0]?.data as (ProviderSession&{providerKind?:string})|undefined;
            if(prior?.providerKind==='recall'){
              if(!prior.providerSessionId)throw new Error('Uncertain original Recall create requires metadata reconciliation; no replay');
              const client=await recallClient();
              if(args.action==='leave')await client.leave(prior.providerSessionId);
              const session=providerObservation(prior,normalizedRecall(await client.inspect(prior.providerSessionId)));
              await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[prior.sessionId,{...session,providerKind:'recall'}]);
              return {content:[{type:'text',text:JSON.stringify(session)}],details:{}};
            }
          }
          if (!config.browser) throw new Error('Guarded meeting browser adapter is not configured');
          if (args.action==='join' && config.joiningEnabled!==true) throw new Error('Meeting joins are disabled until legitimate WORK adapter readiness is established; inspect status without authentication retry');
          const row = (await pool!.query('SELECT data FROM kenan_meeting_sessions WHERE id=$1 AND owner_id=$2', [args.sessionId,ctx.person.id])).rows[0];
          if (!row) throw new Error('Meeting session not found');
          const browserSession = `meet-${args.sessionId.slice(0,32)}`;
          let meetingUrl = (row.data as ObservedMeeting).meetingUrl;
          const call = (action: 'prepare'|'join'|'inspect'|'leave') => callMeetingBrowser(config.browser!, { action, session: browserSession, url: meetingUrl });
          const save = async (session: ProviderSession) => { await pool!.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1', [session.sessionId,session]); };
          if (args.action === 'join') {
            const proof = await observe(ctx.person);
            const meeting = proof.meetings.find(m=>m.eventKey===(row.data as ObservedMeeting).eventKey);
            if (!meeting) throw new Error('Meeting is no longer eligible');
            meetingUrl = meeting.meetingUrl;
            const request = {sessionId:args.sessionId,ownerId:ctx.person.id,conversationId:ctx.agent.conversationId,meetingUrl:meeting.meetingUrl,endsAt:Date.parse(meeting.endAt),observedAt:Date.parse(proof.observedAt),included:true};
            const session = await joinMeeting(request,deps.now(),{
              reserve:async r => !!(await pool!.query('INSERT INTO kenan_meeting_provider(id,owner_id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[r.sessionId,r.ownerId,{...r,providerSessionId:browserSession,phase:'unknown',lastObservedAt:r.observedAt}])).rowCount,
              save,
              join:async()=>{ await call('prepare'); const reply=await call('join'); return {providerSessionId:browserSession,observedAt:deps.now(),state:browserMeetingState(reply)}; },
            });
            return {content:[{type:'text',text:JSON.stringify(session)}],details:{}};
          }
          const prior = (await pool!.query('SELECT data FROM kenan_meeting_provider WHERE id=$1 AND owner_id=$2',[args.sessionId,ctx.person.id])).rows[0]?.data as ProviderSession | undefined;
          if (!prior) throw new Error('No original provider session to reconcile');
          if (args.action==='leave') { await call('leave'); await save({...prior,phase:'leaving'}); }
          const observed=providerObservation(prior,{providerSessionId:browserSession,observedAt:deps.now(),state:browserMeetingState(await call('inspect'))});
          const session=args.action==='leave'&&observed.phase!=='ended'?{...observed,phase:'leaving' as const}:observed;
          await save(session);
          return {content:[{type:'text',text:JSON.stringify(session)}],details:{}};
        }
        const value = args.action === 'recheck' ? await observe(ctx.person) : (await pool!.query('SELECT id AS "sessionId",data,phase FROM kenan_meeting_sessions WHERE owner_id=$1 ORDER BY data->>\'startAt\' LIMIT 100', [ctx.person.id])).rows;
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
      },
    }),
  };
}
export const meetingExtension = createMeetingExtension();
