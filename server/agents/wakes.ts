// Self-scheduled resumes. An agent's wake is a durable row: on an event (new mail matching IMAP criteria, a Signal
// message from a named contact, a text matching a query, a host event on a topic), with a time as deadline, whichever
// comes first. The time-or-event contract: every wake also fires on anything addressed to its agent (host events whose
// topic names the agent or its goal, and reports, notes and messages delivered to it), so nobody sleeps past what they
// wait for; a time alone is a clock wake and needs its reason (a decision time, a dated reminder). The server checks
// pending rows (time, texts, Signal and host events every tick and at once when a host event lands, mail once a minute
// per wake), settles each once and delivers a `wake` input to the agent. Wakes of archived, stopped or deleted agents
// are dropped with that reason.
// Waiting workers are an anomaly, not a state to hide: a worker's wait longer than SHORT_WAIT_MS becomes a held trigger.
// The wake moves to the person's manager with the worker's goal and handoff (also added at the top of the goal's notes), the worker
// ends archived, and when the trigger fires the manager gets the event and the handoff and launches a fresh worker.
import { DatabaseSync } from 'node:sqlite';
import { Type } from 'typebox';
import type { AgentInfo, Goal } from '../../shared/contract.js';
import { isSubAgent, subAgentActive, swarmsOf } from '../../shared/swarm.js';
import type { PersonConfig } from '../config.js';
import { searchMail, type MailRow } from '../extensions/mail.js';
import { readTexts, textMatches, type Text } from '../extensions/texts.js';
import type { AgentInput, Carried, Deps, FiredSettlement, HostEvent, KenanTool, NewWakeTrigger, SignalChat, ToolContext, Wake, WakeAddress, WakeCarry, WakeEvent, WakeSettlement, WakeTrigger } from '../types.js';

/** A worker keeps its own wake only when its deadline is this close. Beta, 1,751 fired worker wakes to 2026-10-21: wakes
 * with deadlines up to 30 minutes actually waited 3–14 minutes on average (their event came early); deadlines beyond
 * waited 45 minutes to 10 hours. Longer waits hand off. A coordinator with active sub-agents keeps its wakes: its swarm is working. */
export const SHORT_WAIT_MS = 30 * 60_000;

export const WAKE_TICK_MS = 10_000;
export const MAIL_CHECK_MS = 60_000;
const PAST_GRACE_MS = 60_000;
const CLIP = 300;
/** A host event wake carries up to EVENT_BATCH events, each body up to EVENT_BODY characters of JSON; the rest wait for the next wake. */
export const EVENT_BATCH = 10;
export const EVENT_BODY = 4000;
/** How many uncarried addressed events the scheduler reads to judge whether a burst has settled. */
export const ADDRESSED_LIMIT = 1000;
/** Events addressed to an agent come in bursts (one release raises a deploy event per product), so an addressed wake
 * fires once its unread events have been quiet for ADDRESSED_QUIET_MS, or once the oldest is ADDRESSED_CAP_MS old,
 * carrying them all in one turn. A wake `on: "event"` for a topic the agent named fires at once. */
export const ADDRESSED_QUIET_MS = 60_000;
export const ADDRESSED_CAP_MS = 180_000;
/** A burst whose events are all routine (body `routine: true`, set by the producer for successes and progress such as a
 * product going live or a queue admitting a leaf) waits longer to settle, so a release's per-product events, which land
 * minutes apart, are one turn instead of several. Any event that isn't routine settles the burst on the normal clock. */
export const ROUTINE_QUIET_MS = 180_000;
export const ROUTINE_CAP_MS = 600_000;
const isRoutine = (body: unknown) => !!body && typeof body === 'object' && (body as { routine?: unknown }).routine === true;
/** Whether a burst of uncarried addressed events (oldest first) has settled and should fire the agent's addressed wake. */
export function addressedSettled(events: readonly HostEvent[], now: number): boolean {
  if (!events.length) return false;
  const [quiet, cap] = events.every(e => isRoutine(e.body)) ? [ROUTINE_QUIET_MS, ROUTINE_CAP_MS] : [ADDRESSED_QUIET_MS, ADDRESSED_CAP_MS];
  return now - events.at(-1)!.arrivedAt >= quiet || now - events[0]!.arrivedAt >= cap;
}
/** Inputs that reach an agent from someone else and fire its addressed wakes: a report, a note (worker or peer) or a message. */
export const ADDRESSED_INPUTS: ReadonlySet<AgentInput['kind']> = new Set(['report', 'note', 'agent']);
/** Host events are kept this long, so an event that arrives before its wake is scheduled still fires it. */
export const HOST_EVENT_RETENTION_MS = 14 * 24 * 3600_000;
export const TOPIC = /^[A-Za-z0-9._:@/-]{1,200}$/;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const clip = (text: string) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > CLIP ? `${flat.slice(0, CLIP - 1)}…` : flat; };
const clock = (at: number) => new Date(at).toISOString().slice(0, 16) + 'Z';
const mailKey = (row: MailRow) => row.messageId || row.reference;

/** `group` is the group chat a message arrived in; null is the sender's direct chat with the person. */
export interface SignalMessage { observedAt: number; from: string; group: { id: string | null; name: string | null } | null; body: string }
type Match = { ok: true; detail: string } | { ok: false };
const none: Match = { ok: false };

const describeChat = (chat: SignalChat) => chat.kind === 'direct' ? 'in their direct chat' : chat.kind === 'group' ? `in a group matching "${chat.group}"` : 'in any chat';
const describeEvent = (event: WakeEvent) => event.source === 'mail' ? `mail in ${event.folder} matching ${event.criteria}`
  : event.source === 'signal' ? `Signal from ${event.from} ${describeChat(event.chat)}${event.query ? ` containing "${event.query}"` : ''}`
  : event.source === 'text' ? `text containing "${event.query}"`
  : event.prefix ? `an event on a topic starting "${event.topic}"` : `an event on topic "${event.topic}"`;
export function describeTrigger(trigger: WakeTrigger | Wake): string {
  const held = 'held' in trigger && trigger.held;
  const parts = [...(trigger.event ? [`on ${describeEvent(trigger.event)}`] : []), ...(trigger.listen.kind === 'addressed' ? [held ? `on anything addressed to ${held.workerId ? `worker ${held.workerId.slice(0, 8)} or ` : ''}goal ${held.goalId.slice(0, 8)}` : 'on anything addressed to you'] : [])];
  const time = trigger.at === null ? [] : [`at ${clock(trigger.at)}`];
  const all = [...parts, ...time].join(', or ');
  return trigger.listen.kind === 'clock' ? `${all} (clock wake: ${trigger.listen.reason})` : all;
}

/** Who an agent's addressed wakes listen for: its id and goal, in full and as the 8-character prefix producers also use. */
export function addressOf(agent: Pick<AgentInfo, 'id' | 'goalId'>): WakeAddress {
  const short = (id: string) => /^[0-9a-f]{8}-/.test(id) ? [id, id.slice(0, 8)] : [id];
  const goals = agent.goalId ? short(agent.goalId) : [];
  return { ids: [...short(agent.id), ...goals], goals };
}

/** Who a wake listens for: its agent, or for a held trigger the worker that handed it off and the goal, since that worker's start. */
export function listenerOf(wake: Wake, agents: Map<string, AgentInfo>): { address: WakeAddress; since: number } | null {
  if (wake.held) {
    const worker = wake.held.workerId ? agents.get(wake.held.workerId) : undefined;
    const address = worker ? addressOf({ id: worker.id, goalId: wake.held.goalId }) : { ids: addressOf({ id: wake.held.goalId, goalId: null }).ids, goals: addressOf({ id: wake.held.goalId, goalId: null }).ids };
    return { address, since: worker?.createdAt ?? wake.createdAt };
  }
  const agent = agents.get(wake.agentId);
  return agent ? { address: addressOf(agent), since: agent.createdAt } : null;
}

/** Validates tool arguments into a trigger; mail's baseline is filled in by the caller. */
type TriggerArgs = { at?: string; inMinutes?: number; on?: string; clock?: string; criteria?: string; folder?: string; from?: string; chat?: string; group?: string; query?: string; topic?: string };
type ParsedTrigger = { at: number; event: null; listen: { kind: 'clock'; reason: string } }
  | { at: number | null; event: Omit<Extract<WakeEvent, { source: 'mail' }>, 'seen'> | Exclude<WakeEvent, { source: 'mail' }> | null; listen: { kind: 'addressed' } };

/** The refusal for a time alone without a clock reason: it names the events the agent can wait on instead. */
export const needsEvent = (agentId: string) => `wake_needs_event: a time alone wakes you late whenever what you wait for happens earlier. Wait on the event, with the time as deadline: on "event" with a topic for you (acme:${agentId} for Acme qualify/merge/deploy, gpujob:${agentId}:* for your GPU jobs, contention:${agentId}), on "mail", "text" or "signal", or on "any" for anything addressed to you. Every wake also fires on anything addressed to you: those host events and, for a worker, reports, notes and messages sent to it. Only when the time itself is what you wait for (a decision time, a dated reminder, a reset), give clock: the reason.`;

function parseChat(args: TriggerArgs): Result<SignalChat> {
  switch (args.chat) {
    case undefined: return { ok: false, error: 'on signal needs chat: "direct" (their 1:1 chat with you), "group" (with group: part of the group name or id) or "any"' };
    case 'direct': case 'any': return args.group === undefined ? { ok: true, value: { kind: args.chat } } : { ok: false, error: `group only applies with chat "group"` };
    case 'group': return args.group?.trim() ? { ok: true, value: { kind: 'group', group: args.group.trim() } } : { ok: false, error: 'chat "group" needs group (part of the group name or id)' };
    default: return { ok: false, error: `Unknown chat: ${args.chat} (use "direct", "group" or "any")` };
  }
}

export function parseTrigger(args: TriggerArgs, now: number, person: PersonConfig, agentId: string): Result<ParsedTrigger> {
  if (args.at !== undefined && args.inMinutes !== undefined) return { ok: false, error: 'Give at or inMinutes, not both' };
  let at: number | null = null;
  if (args.at !== undefined) {
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(args.at.trim())) return { ok: false, error: 'at needs an explicit timezone, e.g. 2026-10-19T13:00:00Z or 2026-10-19T09:00:00-04:00' };
    at = Date.parse(args.at);
    if (Number.isNaN(at)) return { ok: false, error: `at is not a valid ISO time: ${args.at}` };
    if (at < now - PAST_GRACE_MS) return { ok: false, error: `at ${clock(at)} is in the past (now ${clock(now)})` };
  } else if (args.inMinutes !== undefined) {
    if (!Number.isFinite(args.inMinutes) || args.inMinutes <= 0) return { ok: false, error: 'inMinutes must be positive' };
    at = now + Math.round(args.inMinutes * 60_000);
  }
  const unused = (fields: ('criteria' | 'folder' | 'from' | 'chat' | 'group' | 'query' | 'topic')[]) => fields.filter(field => args[field] !== undefined);
  if (args.clock !== undefined && args.on !== undefined) return { ok: false, error: 'clock is for a wake on a time alone; with on, the wake already waits for its event' };
  const addressed = { kind: 'addressed' } as const;
  switch (args.on) {
    case undefined: {
      if (at === null) return { ok: false, error: 'Give an on event with at or inMinutes as its deadline, or a time with clock' };
      const extra = unused(['criteria', 'folder', 'from', 'chat', 'group', 'query', 'topic']);
      if (extra.length) return { ok: false, error: `${extra.join(', ')} only apply with on` };
      if (args.clock === undefined) return { ok: false, error: needsEvent(agentId) };
      const reason = args.clock.trim();
      return reason ? { ok: true, value: { at, event: null, listen: { kind: 'clock', reason } } } : { ok: false, error: 'clock needs the reason the time itself is what you wait for' };
    }
    case 'any': {
      const extra = unused(['criteria', 'folder', 'from', 'chat', 'group', 'query', 'topic']);
      return extra.length ? { ok: false, error: `${extra.join(', ')} do not apply to any` } : { ok: true, value: { at, event: null, listen: addressed } };
    }
    case 'mail': {
      if (!person.extensions.includes('mail')) return { ok: false, error: 'Mail is not enabled for this account' };
      if (!args.criteria?.trim()) return { ok: false, error: 'on mail needs criteria (IMAP search, e.g. FROM "buyer@example.com")' };
      const extra = unused(['from', 'chat', 'group', 'query', 'topic']);
      return extra.length ? { ok: false, error: `${extra.join(', ')} do not apply to mail; put them in criteria` } : { ok: true, value: { at, event: { source: 'mail', folder: args.folder?.trim() || 'INBOX', criteria: args.criteria.trim() }, listen: addressed } };
    }
    case 'signal': {
      if (person.signalStore === null) return { ok: false, error: 'Signal is not linked for this account' };
      if (!args.from?.trim()) return { ok: false, error: 'on signal needs from (part of the contact name, number or UUID)' };
      const extra = unused(['criteria', 'folder', 'topic']);
      if (extra.length) return { ok: false, error: `${extra.join(', ')} do not apply to signal` };
      const chat = parseChat(args);
      return chat.ok ? { ok: true, value: { at, event: { source: 'signal', from: args.from.trim(), chat: chat.value, query: args.query?.trim() || null }, listen: addressed } } : chat;
    }
    case 'text': {
      if (!person.extensions.includes('texts')) return { ok: false, error: 'Texts are not enabled for this account' };
      if (!args.query?.trim()) return { ok: false, error: 'on text needs query (part of the sender, body or app)' };
      const extra = unused(['criteria', 'folder', 'from', 'chat', 'group', 'topic']);
      return extra.length ? { ok: false, error: `${extra.join(', ')} do not apply to text` } : { ok: true, value: { at, event: { source: 'text', query: args.query.trim() }, listen: addressed } };
    }
    case 'event': {
      const extra = unused(['criteria', 'folder', 'from', 'chat', 'group', 'query']);
      if (extra.length) return { ok: false, error: `${extra.join(', ')} do not apply to event` };
      const topic = parseTopic(args.topic);
      return topic.ok ? { ok: true, value: { at, event: { source: 'event', ...topic.value }, listen: addressed } } : topic;
    }
    default: return { ok: false, error: `Unknown on: ${args.on}` };
  }
}

/** `acme:abc` matches that topic exactly; a trailing `*` (`acme:*`) matches every topic starting with the rest. */
export function parseTopic(raw: string | undefined): Result<{ topic: string; prefix: boolean }> {
  const text = raw?.trim() ?? '';
  if (!text) return { ok: false, error: 'on event needs topic (exact, e.g. acme:<your id>, or a prefix ending in *, e.g. acme:*)' };
  const prefix = text.endsWith('*'), topic = prefix ? text.slice(0, -1) : text;
  return TOPIC.test(topic) ? { ok: true, value: { topic, prefix } } : { ok: false, error: `topic must be 1–200 of A–Z a–z 0–9 . _ : @ / - (with an optional trailing *), got ${JSON.stringify(text)}` };
}

const bodyText = (body: unknown) => { const json = JSON.stringify(body); return json.length > EVENT_BODY ? `${json.slice(0, EVENT_BODY - 1)}… (${json.length} characters)` : json; };
/** The wake detail for the events a wake carries, oldest first, each with its full topic, arrival and JSON body. */
export function eventDetail(events: HostEvent[]): string {
  return `${events.length === 1 ? 'host event' : `${events.length} host events`}:\n${events.map(e => `- ${e.topic} (arrived ${new Date(e.arrivedAt).toISOString().slice(0, 19)}Z, id ${e.id}): ${bodyText(e.body)}`).join('\n')}`;
}

/** A fired wake's detail: what fired it (`lead`, null when the addressed events did), then every event it carries.
 * An event is marked carried only together with this text, so nothing addressed to an agent is ever settled unseen. */
export function carriedDetail(lead: string | null, { own, addressed, waiting }: Carried): string {
  return [lead, own.length ? eventDetail(own) : null,
    addressed.length ? `${lead !== null || own.length ? 'also addressed to you' : 'addressed to you'}: ${eventDetail(addressed)}` : null,
    waiting ? `${waiting} more host event${waiting === 1 ? '' : 's'} addressed to you did not fit in this wake; your next wake carries them.` : null,
  ].filter(part => part !== null).join('\n\n');
}

/** Every wake that fires carries its own events and then the oldest events addressed to its listener that no wake has carried. */
const carryFor = (listener: { address: WakeAddress; since: number }, own: HostEvent[]): WakeCarry => ({ own, addressed: listener, limit: EVENT_BATCH });
const fired = (detail: string): FiredSettlement => ({ status: 'fired', reason: 'event', detail });

export function matchText(event: Extract<WakeEvent, { source: 'text' }>, since: number, texts: Text[]): Match {
  const hit = texts.filter(t => t.storedAt >= since && textMatches(event.query)(t)).at(0);
  return hit ? { ok: true, detail: `text from ${hit.sender} (${hit.app}): "${clip(hit.body)}"` } : none;
}

function inChat(chat: SignalChat, group: SignalMessage['group']): boolean {
  switch (chat.kind) {
    case 'direct': return group === null;
    case 'group': return group !== null && [group.name, group.id].some(part => part?.toLowerCase().includes(chat.group.toLowerCase()));
    case 'any': return true;
  }
}

export function matchSignal(event: Extract<WakeEvent, { source: 'signal' }>, since: number, messages: SignalMessage[]): Match {
  const from = event.from.toLowerCase(), query = event.query?.toLowerCase() ?? null;
  const hit = messages.find(m => m.observedAt >= since && inChat(event.chat, m.group) && m.from.toLowerCase().includes(from) && (query === null || m.body.toLowerCase().includes(query)));
  if (!hit) return none;
  const where = hit.group === null ? 'direct' : `in group "${hit.group.name ?? hit.group.id ?? 'unnamed'}"`;
  return { ok: true, detail: `Signal message from ${hit.from} (${where}): "${clip(hit.body)}"` };
}

export function matchMail(event: Extract<WakeEvent, { source: 'mail' }>, rows: MailRow[]): Match {
  const seen = new Set(event.seen);
  const hit = rows.find(row => !seen.has(mailKey(row)));
  return hit ? { ok: true, detail: `mail from ${hit.from}: "${clip(hit.subject)}" (mail read ${event.folder} ${hit.reference})` } : none;
}

/** Incoming Signal data messages observed since `since`, oldest first; `from` is name, number and UUID for matching.
 * The receiver commits each event in its own short rollback-journal transaction, so a read can briefly meet its lock:
 * each attempt waits up to SIGNAL_BUSY_MS inside SQLite, and a still-locked read is retried after an async pause
 * within the same poll, keeping the event loop free while the receiver commits. */
export const SIGNAL_BUSY_MS = 250;
export const SIGNAL_RETRY_PAUSE_MS = 400;
export const SIGNAL_ATTEMPTS = 6;
/** A trigger source's failure is logged only once it has lasted this long, so a passing timeout or lock is not reported. */
export const OUTAGE_REPORT_AFTER_MS = 5 * 60_000;
const locked = (e: unknown) => /database is locked|SQLITE_BUSY|database table is locked/i.test(String(e));

export function readSignalOnce(store: string, since: number): SignalMessage[] {
  const db = new DatabaseSync(store, { readOnly: true, timeout: SIGNAL_BUSY_MS });
  try {
    const rows = db.prepare('SELECT observed_at, payload FROM events WHERE observed_at >= ? ORDER BY observed_at').all(since) as { observed_at: number; payload: string }[];
    return rows.flatMap(row => {
      const envelope = (() => { try { return JSON.parse(row.payload).envelope; } catch { return null; } })();
      const body = envelope?.dataMessage?.message;
      if (typeof body !== 'string' || !body) return [];
      const from = [envelope.sourceName, envelope.sourceNumber, envelope.sourceUuid].filter((v: unknown) => typeof v === 'string' && v).join(' ');
      const info = envelope.dataMessage.groupInfo;
      const str = (v: unknown) => typeof v === 'string' && v ? v : null;
      const group = info == null ? null : { id: str(info.groupId), name: str(info.groupName) };
      return [{ observedAt: Number(row.observed_at), from, group, body }];
    });
  } finally { db.close(); }
}

export async function readSignal(store: string, since: number, signal?: AbortSignal): Promise<Result<SignalMessage[]>> {
  for (let attempt = 1; ; attempt++) {
    try { return { ok: true, value: readSignalOnce(store, since) }; }
    catch (e) {
      if (!locked(e) || attempt >= SIGNAL_ATTEMPTS || signal?.aborted) return { ok: false, error: `${e}${locked(e) ? ` (${attempt} attempts)` : ''}` };
      await new Promise(resolve => setTimeout(resolve, SIGNAL_RETRY_PAUSE_MS));
    }
  }
}

export const dropReason = (agent: AgentInfo | undefined): Extract<WakeSettlement, { status: 'dropped' }> | null =>
  !agent ? { status: 'dropped', reason: 'agent_missing', detail: 'The agent no longer exists' }
  : agent.archived ? { status: 'dropped', reason: 'agent_archived', detail: `${agent.name} is archived` }
  : agent.state === 'stopped' ? { status: 'dropped', reason: 'agent_stopped', detail: `${agent.name} is stopped` }
  : null;

/** What a manager reads when a held trigger fires: the event, the handoff, and the instruction to launch a fresh worker. */
export function heldText(wake: Wake & { status: 'fired' }, held: NonNullable<Wake['held']>, goal: Goal | null, others: Wake[]): string {
  const goalLine = goal ? `goal "${goal.title}" (${goal.id}, ${goal.status})` : `goal ${held.goalId} (not found)`;
  const from = held.workerId ? `Worker ${held.workerId} handed it off ${clock(wake.createdAt)}` : `You set it ${clock(wake.createdAt)}`;
  const rest = others.length ? `\n\nOther held triggers still waiting for this goal (they stay with you; the fresh worker sees them in its task and can cancel ones it replaces): ${others.map(o => `${o.id} ${describeTrigger(o)}`).join('; ')}.` : '';
  return `Held trigger ${wake.id} for ${goalLine} fired (${wake.reason === 'time' ? 'its time came' : 'its event arrived'}): ${wake.detail}. ${from}, waiting ${describeTrigger(wake)}.

Launch a fresh worker for this goal now with workers spawn goalId ${held.goalId}, giving it this event and the handoff below${held.workerId ? " (the goal's notes keep it too)" : ''}. If a worker is already active on the goal, message it instead. If the goal is closed or the trigger is moot, say so with goals update appendNote.

Handoff:
${held.handoff}${wake.message.trim() === held.handoff.trim() ? '' : `\n\nNote for when it fires:\n${wake.message}`}${rest}`;
}

export function wakeText(wake: Wake & { status: 'fired' }): string {
  const early = wake.reason === 'event' && wake.at !== null && wake.at > wake.settledAt ? ` It fired before its time ${clock(wake.at)}: if you still need to wait, schedule again.` : '';
  return `Your wake ${wake.id} fired (${wake.reason === 'time' ? 'its time came' : 'its event arrived'}): ${wake.detail}. You scheduled it ${clock(wake.createdAt)} ${describeTrigger(wake)}.${early}\n\nYour note to yourself:\n${wake.message}`;
}

/** An input from someone else (a report, a note, a message) fires a worker's addressed wakes; their notes join the turn it starts.
 * A manager receives reports and notes all day, and its wakes wait on other things, so its inputs leave them pending. */
export async function fireOnInput(deps: Deps, input: AgentInput): Promise<void> {
  if (!ADDRESSED_INPUTS.has(input.kind)) return;
  const agent = await deps.store.getAgent(input.agentId);
  if (agent?.role !== 'worker') return;
  const what = input.kind === 'report' ? 'a report' : input.kind === 'note' ? 'a note' : 'a message';
  const lead = `${what} from ${input.fromId} arrived: "${clip(input.text)}"`;
  const wakes = (await deps.store.pendingWakes(agent.ownerId)).filter(w => w.agentId === agent.id && w.listen.kind === 'addressed');
  const settled: Wake[] = [];
  for (const wake of wakes) {
    const done = await deps.store.fireWake(wake.id, carryFor({ address: addressOf(agent), since: agent.createdAt }, []), carried => fired(carriedDetail(lead, carried)));
    if (done) settled.push(done);
  }
  if (!settled.length) return;
  await publishAgent(deps, agent.id);
  for (const wake of settled) if (wake.status === 'fired') deps.runtime.deliver({ agentId: agent.id, kind: 'wake', text: wakeText(wake), fromId: 'system', conversationId: input.conversationId });
}

/** Failing sources by key: each outage is logged once, after OUTAGE_REPORT_AFTER_MS, and the next success ends it. */
export class Outages {
  private failing = new Map<string, { since: number; reported: boolean }>();
  constructor(private readonly now: () => number, private readonly report: (key: string, minutes: number, error: string) => Promise<void>) {}
  succeeded(key: string): void { this.failing.delete(key); }
  /** Records the failure and returns how long the outage has lasted. */
  async failed(key: string, error: string): Promise<number> {
    const outage = this.failing.get(key) ?? { since: this.now(), reported: false };
    this.failing.set(key, outage);
    const lasted = this.now() - outage.since;
    if (!outage.reported && lasted >= OUTAGE_REPORT_AFTER_MS) {
      outage.reported = true;
      await this.report(key, Math.round(lasted / 60_000), error);
    }
    return lasted;
  }
  forget(keep: (key: string) => boolean): void { for (const key of this.failing.keys()) if (!keep(key)) this.failing.delete(key); }
}

export class WakeScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | null = null;
  private again = false;
  private mailChecks = new Map<string, { at: number; running: Promise<void> | null }>();
  private signalOutages: Outages;
  private mailOutages: Outages;
  private abort = new AbortController();
  constructor(private readonly deps: Deps) {
    this.signalOutages = new Outages(deps.now, (ownerId, minutes, error) => this.error(`wakes:${ownerId}`, `Signal store unreadable for ${minutes} min: ${error}`));
    this.mailOutages = new Outages(deps.now, (key, minutes, error) => { const [agentId, wakeId] = key.split(' '); return this.error(`agent:${agentId}`, `wake ${wakeId} mail check failing for ${minutes} min: ${error}`); });
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), WAKE_TICK_MS);
  }

  /** Stops checking and waits for in-flight checks, so every fired wake has been delivered before the runtime saves its queues. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.ticking;
    await Promise.all([...this.mailChecks.values()].map(check => check.running));
  }

  /** Checks now; a tick asked for while a check runs runs once more after it, so a just-recorded host event is seen. */
  tick(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.ticking) { this.again = true; return this.ticking; }
    this.ticking = this.check().catch(e => this.error('wakes', e)).finally(() => {
      this.ticking = null;
      if (this.again) { this.again = false; void this.tick(); }
    });
    return this.ticking;
  }

  private async error(scope: string, error: unknown): Promise<void> { await this.deps.store.logError(scope, String(error)).catch(() => {}); }

  private async check(): Promise<void> {
    const pending = await this.deps.store.pendingWakes(null);
    for (const id of this.mailChecks.keys()) if (!pending.some(w => w.id === id) && !this.mailChecks.get(id)!.running) this.mailChecks.delete(id);
    this.mailOutages.forget(key => pending.some(w => key === `${w.agentId} ${w.id}`));
    const owners = [...new Set(pending.map(w => w.ownerId))];
    for (const ownerId of owners) {
      const wakes = pending.filter(w => w.ownerId === ownerId);
      const agents = new Map((await this.deps.store.listAgents(ownerId, { includeArchived: true })).map(a => [a.id, a]));
      const person = this.deps.person(ownerId);
      const live: Wake[] = [];
      for (const wake of wakes) {
        const drop = dropReason(agents.get(wake.agentId));
        if (drop && await this.deps.store.settleWake(wake.id, drop)) await publishAgent(this.deps, wake.agentId);
        else live.push(wake);
      }
      if (!person) continue;
      const now = this.deps.now();
      const texts = live.some(w => w.event?.source === 'text') ? await readTexts(person).catch(e => { void this.error(`wakes:${ownerId}`, `texts unreadable: ${e}`); return null; }) : [];
      const signalSince = Math.min(...live.flatMap(w => w.event?.source === 'signal' ? [w.createdAt] : []));
      const signal = Number.isFinite(signalSince) && person.signalStore !== null ? await this.readSignal(ownerId, person.signalStore, signalSince) : { ok: true as const, value: [] };
      const signalStale = !signal.ok && signal.lasted >= OUTAGE_REPORT_AFTER_MS;
      for (const wake of live) {
        const event = wake.event;
        if (event?.source === 'event') {
          const events = await this.deps.store.hostEventsFor(ownerId, event, wake.createdAt, EVENT_BATCH);
          if (events.length) { await this.fire(wake, carried => fired(carriedDetail(null, carried)), events); continue; }
        }
        const listener = listenerOf(wake, agents);
        if (wake.listen.kind === 'addressed' && listener) {
          const events = await this.deps.store.addressedEventsFor(ownerId, listener.address, listener.since, ADDRESSED_LIMIT);
          if (addressedSettled(events, now)) { await this.fire(wake, carried => carried.addressed.length ? fired(carriedDetail(null, carried)) : null, []); continue; }
        }
        const match = event === null || event.source === 'event' ? none
          : event.source === 'text' ? (texts ? matchText(event, wake.createdAt, texts) : none)
          : event.source === 'signal' ? (signal.ok ? matchSignal(event, wake.createdAt, signal.value) : none)
          : (this.checkMail(wake, event, person), none);
        if (match.ok) await this.fire(wake, carried => fired(carriedDetail(match.detail, carried)), []);
        else if (wake.at !== null && wake.at <= now && !(event?.source === 'signal' && !signal.ok && !signalStale)) await this.fire(wake, carried => ({ status: 'fired', reason: 'time', detail: carriedDetail(`due ${clock(wake.at!)}`, carried) }), []);
      }
    }
  }

  /** Messages since `since`, or how long the store has been unreadable. */
  private async readSignal(ownerId: string, store: string, since: number): Promise<{ ok: true; value: SignalMessage[] } | { ok: false; lasted: number }> {
    const read = await readSignal(store, since, this.abort.signal);
    if (read.ok) { this.signalOutages.succeeded(ownerId); return read; }
    return { ok: false, lasted: await this.signalOutages.failed(ownerId, read.error) };
  }
  private checkMail(wake: Wake, event: Extract<WakeEvent, { source: 'mail' }>, person: PersonConfig): void {
    const state = this.mailChecks.get(wake.id) ?? { at: 0, running: null };
    const outage = `${wake.agentId} ${wake.id}`;
    this.mailChecks.set(wake.id, state);
    const now = this.deps.now();
    if (state.running || now - state.at < MAIL_CHECK_MS) return;
    state.at = now;
    state.running = (async () => {
      try {
        const match = matchMail(event, await searchMail(this.deps.placement, person, event.folder, event.criteria, this.abort.signal));
        this.mailOutages.succeeded(outage);
        if (match.ok && !this.abort.signal.aborted) await this.fire(wake, carried => fired(carriedDetail(match.detail, carried)), []);
      } catch (e) {
        if (this.abort.signal.aborted) return;
        await this.mailOutages.failed(outage, String(e));
      } finally { state.running = null; }
    })();
  }

  /** Settles the wake once and delivers it, carrying its own `events` and every uncarried event addressed to its agent that fits. */
  private async fire(wake: Wake, describe: (carried: Carried) => FiredSettlement | null, events: HostEvent[]): Promise<void> {
    const agents = new Map((await this.deps.store.listAgents(wake.ownerId, { includeArchived: true })).map(a => [a.id, a]));
    const agent = agents.get(wake.agentId);
    const drop = dropReason(agent);
    if (drop || !agent) { if (await this.deps.store.settleWake(wake.id, drop!)) await publishAgent(this.deps, wake.agentId); return; }
    const settled = await this.deps.store.fireWake(wake.id, carryFor(listenerOf(wake, agents)!, events), describe);
    if (!settled || settled.status !== 'fired') return;
    if (agent.lastReport) await this.deps.store.updateAgent(agent.id, { lastReport: null });
    await publishAgent(this.deps, agent.id);
    const text = settled.held ? heldText(settled, settled.held, await this.deps.store.getGoal(wake.ownerId, settled.held.goalId),
      (await this.deps.store.pendingWakes(wake.ownerId)).filter(w => w.held?.goalId === settled.held!.goalId)) : wakeText(settled);
    this.deps.runtime.deliver({ agentId: agent.id, kind: 'wake', text, fromId: 'system', conversationId: agent.conversationId });
  }
}

/** How long a worker has waited and on what, for the warning lists show: "waiting 2h on mail …, or at 2026-10-21T16:30Z". */
export function waitingLine(agent: AgentInfo, wakes: Wake[], now: number): string | null {
  if (agent.role !== 'worker' || agent.archived || agent.state !== 'idle') return null;
  const own = wakes.filter(w => w.agentId === agent.id && w.status === 'pending');
  if (!own.length) return null;
  const since = Math.min(...own.map(w => w.createdAt));
  return `waiting ${span(now - since)} ${own.map(describeTrigger).join('; ')}`;
}
const span = (ms: number) => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 6) / 10}h` : `${Math.round(m / 1440)}d`; };

/** Pending wakes are part of an agent's public state, so every wake change republishes it. */
async function publishAgent(deps: Deps, agentId: string): Promise<void> {
  const agent = await deps.store.getAgent(agentId);
  if (agent) deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
export const wakeSummary = (wake: Wake) => ({ id: wake.id, trigger: describeTrigger(wake), message: clip(wake.message), createdAt: clock(wake.createdAt),
  ...(wake.held ? { goalId: wake.held.goalId, handedOffBy: wake.held.workerId } : {}),
  ...(wake.status === 'pending' ? { status: wake.status } : { status: wake.status, reason: wake.reason, detail: clip(wake.detail), settledAt: clock(wake.settledAt) }) });

/** Why an agent may not keep a wait of this length itself, or null when it may. */
type WaitPlan = { kind: 'own' } | { kind: 'hand_off'; managerId: string; worker: AgentInfo & { goalId: string } } | { kind: 'refused'; error: string };
export function planWait(agent: AgentInfo, at: number | null, now: number, agents: AgentInfo[], managerId: string | null): WaitPlan {
  if (agent.role !== 'worker' || (at !== null && at - now <= SHORT_WAIT_MS)) return { kind: 'own' };
  if ((swarmsOf(agents).get(agent.id) ?? []).some(subAgentActive)) return { kind: 'own' };
  const parent = agents.find(a => a.id === agent.parentAgentId);
  const wait = at === null ? 'a wait with no deadline' : `a wait of ${Math.round((at - now) / 60_000)} minutes`;
  if (isSubAgent(agent, parent)) return { kind: 'refused', error: `long_wait_sub_agent: ${wait} is longer than a sub-agent keeps (${SHORT_WAIT_MS / 60_000} minutes). Report to your coordinator what you wait for and what to do when it happens; it decides.` };
  if (!agent.goalId) return { kind: 'refused', error: `long_wait_without_goal: ${wait} hands off to your manager for your goal, and you have none. Report instead.` };
  if (!managerId) return { kind: 'refused', error: `long_wait_without_manager: ${wait} hands off to your manager, and this account has none hosted here. Report instead.` };
  return { kind: 'hand_off', managerId, worker: { ...agent, goalId: agent.goalId } };
}

export function wakeTool({ deps, person, agent }: ToolContext): KenanTool {
  const minutes = SHORT_WAIT_MS / 60_000;
  const workerRule = agent.role === 'worker'
    ? ` Waits are short: you keep a wake whose deadline is at most ${minutes} minutes away (or any wake while you have active sub-agents). A longer wait, or one with no deadline, hands off: give handoff (what a fresh worker with no context needs: state, files, and exactly what to do when it fires); the wake moves to your manager as a trigger held for your goal, the handoff goes on top of the goal's notes, and this run is archived when your turn ends. When it fires, your manager gets the event and the handoff and launches a fresh worker. Schedule every trigger you need in the same turn, each with its handoff, then end your turn. Sub-agents are refused long waits (long_wait_sub_agent): report to the coordinator instead.`
    : ' As a manager you hold the triggers your workers hand off: list shows each with its goal and handoff, and when one fires you get the event and the handoff and launch a fresh worker for its goal. To hold a trigger for a goal yourself, give goalId and handoff.';
  return {
    name: 'wake', files: 'none', label: 'Wake',
    description: `Schedule a resume, so waiting work continues the moment what it waits for happens. Wait on the event, with a time as deadline (whichever comes first); every wake also fires on anything addressed to you (host events naming your id or goal, such as acme:<your id> for Acme qualify/merge/deploy, gpujob:<your id>:* for your GPU jobs, contention:<your id> and goal-<goal id>:anything, and, for a worker, reports, notes and messages sent to it; addressed events fire it once they have been quiet a minute, or 3 minutes after the first (a burst of only routine successes such as deploys going live: quiet 3 minutes, or 10 after the first), and every wake that fires for any reason carries the ones no wake has carried yet, up to ${EVENT_BATCH} per wake in full, oldest first). A time alone is refused unless you give clock: the reason the time itself is what you wait for (a decision time, a dated reminder, a reset).${workerRule} action "schedule": message (your note for when it fires), at (ISO time with timezone) or inMinutes, and on: "event" with topic (exact, or a prefix with a trailing *, e.g. acme:*: an event that arrived since you scheduled, or that no wake has carried yet, fires it at once, and the wake text carries every such event's topic, arrival time and JSON body, up to ${EVENT_BATCH} per wake), "any" (only what is addressed to you), "mail" with criteria (IMAP search, e.g. FROM "buyer@example.com"; folder defaults to INBOX: the search covers only mail that arrives after scheduling), "signal" with from (part of the contact's name, number or UUID), chat (required: "direct" for their 1:1 chat with you, "group" plus group (part of the group name or id) for one group chat, or "any" for every chat including groups) and an optional query in the body, or "text" with query (part of sender, body or app). Each wake fires once and survives service restarts. A waiting worker shows as a warning in every list. A done report archives you, and wakes of archived or stopped runs are dropped (held triggers belong to the manager and stay). action "list": your pending and recently settled wakes, the triggers held for your goal (all held triggers, for a manager, with their handoffs) and, for a manager, the workers still waiting. action "cancel": id (your own wake, a trigger held for your goal, or any wake for a manager).`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('schedule'), Type.Literal('list'), Type.Literal('cancel')]),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      at: Type.Optional(Type.String()),
      inMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      on: Type.Optional(Type.Union([Type.Literal('event'), Type.Literal('any'), Type.Literal('mail'), Type.Literal('signal'), Type.Literal('text')])),
      clock: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'Only for a time alone: why the time itself is what you wait for' })),
      handoff: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: 'For a wait that hands off: what a fresh worker needs (state, files, what to do when it fires)' })),
      goalId: Type.Optional(Type.String({ description: 'Manager only: hold this trigger for a goal (with handoff)' })),
      topic: Type.Optional(Type.String()),
      criteria: Type.Optional(Type.String()), folder: Type.Optional(Type.String()), from: Type.Optional(Type.String()),
      chat: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('group'), Type.Literal('any')])), group: Type.Optional(Type.String()), query: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    }),
    execute: async (_id, raw: unknown, signal) => {
      const args = raw as { action: 'schedule' | 'list' | 'cancel'; message?: string; at?: string; inMinutes?: number; on?: string; clock?: string; handoff?: string; goalId?: string; criteria?: string; folder?: string; from?: string; chat?: string; group?: string; query?: string; topic?: string; id?: string };
      switch (args.action) {
        case 'schedule': {
          if (!args.message?.trim()) throw new Error('message is required');
          const now = deps.now();
          const parsed = parseTrigger(args, now, person, agent.id);
          if (!parsed.ok) throw new Error(parsed.error);
          const value = parsed.value;
          const agents = await deps.store.listAgents(person.id, { includeArchived: true });
          const self = agents.find(a => a.id === agent.id) ?? agent;
          const plan = planWait(self, value.at, now, agents, deps.runtime.managerFor(person.id));
          if (plan.kind === 'refused') throw new Error(plan.error);
          const handoff = args.handoff?.trim();
          if (plan.kind === 'hand_off' && !handoff) throw new Error(`wake_needs_handoff: ${value.at === null ? 'a wait with no deadline' : `a wait of ${Math.round((value.at - now) / 60_000)} minutes`} is longer than a worker keeps (${minutes} minutes), so it moves to your manager and this run ends. Give handoff: what a fresh worker with no context needs (state, the files that hold the truth, and exactly what to do when it fires). Or wait at most ${minutes} minutes.`);
          if (agent.role === 'worker' && args.goalId !== undefined) throw new Error('goalId is for managers; a worker hands off for its own goal');
          if (plan.kind === 'own' && agent.role === 'worker' && handoff) throw new Error(`handoff applies only to a wait longer than ${minutes} minutes; this one stays with you`);
          if (agent.role === 'manager' && (args.goalId === undefined) !== (handoff === undefined)) throw new Error('A held trigger needs both goalId and handoff');
          const trigger: NewWakeTrigger = value.listen.kind === 'clock' ? value as Extract<ParsedTrigger, { listen: { kind: 'clock' } }> : {
            at: value.at, listen: value.listen,
            event: value.event?.source === 'mail' ? { ...value.event, seen: (await searchMail(deps.placement, person, value.event.folder, value.event.criteria, signal)).map(mailKey) } : value.event,
          };
          if (plan.kind === 'hand_off') {
            const { wake, goal, worker } = await deps.store.handOff({ worker: plan.worker, managerId: plan.managerId, message: args.message, trigger, handoff: handoff!, summary: describeTrigger(trigger) });
            deps.bus.toPerson(person.id, { type: 'goal', goal });
            deps.bus.toPerson(person.id, { type: 'agent', agent: worker });
            await publishAgent(deps, plan.managerId);
            return result({ handedOff: wakeSummary(wake), heldBy: plan.managerId, next: 'Your manager holds this trigger for your goal and your handoff is in the goal notes. This run is archived when your turn ends: schedule any other triggers you need now, each with its handoff, then end your turn without reporting.' });
          }
          let held: Wake['held'] = null;
          if (agent.role === 'manager' && args.goalId !== undefined) {
            const goal = (await deps.store.listGoals(person.id, 'open')).find(g => g.id === args.goalId || (args.goalId!.length >= 8 && g.id.startsWith(args.goalId!)));
            if (!goal) throw new Error(`No open goal ${args.goalId}`);
            held = { goalId: goal.id, workerId: null, handoff: handoff! };
          }
          const wake = await deps.store.createWake({ agentId: agent.id, ownerId: person.id, message: args.message, trigger, held });
          await publishAgent(deps, agent.id);
          return result({ scheduled: wakeSummary(wake) });
        }
        case 'list': {
          const [all, settled, agents] = await Promise.all([deps.store.pendingWakes(person.id), deps.store.settledWakes(person.id, 0, 10, agent.id), deps.store.listAgents(person.id)]);
          const heldWakes = all.filter(w => w.held && (agent.role === 'manager' || w.held.goalId === agent.goalId));
          const goals = new Map((await deps.store.listGoals(person.id, 'open')).map(g => [g.id, g.title]));
          const held = heldWakes.map(w => ({ ...wakeSummary(w), goalTitle: goals.get(w.held!.goalId) ?? 'closed or unknown goal', handoff: agent.role === 'manager' ? clipTo(w.held!.handoff, 600) : w.held!.handoff }));
          const waiting = agent.role === 'manager' ? agents.flatMap(a => { const line = waitingLine(a, all, deps.now()); return line ? [{ id: a.id, name: a.name, goalId: a.goalId, warning: line }] : []; }) : undefined;
          return result({ pending: all.filter(w => w.agentId === agent.id && !w.held).map(wakeSummary), held, ...(waiting ? { waitingWorkers: waiting } : {}), recentlySettled: settled.map(wakeSummary) });
        }
        case 'cancel': {
          if (!args.id) throw new Error('id is required');
          const wake = (await deps.store.pendingWakes(person.id)).find(w => w.id === args.id);
          if (!wake) throw new Error('No pending wake with that id');
          const mine = wake.agentId === agent.id || (wake.held !== null && wake.held.goalId === agent.goalId);
          if (!mine && agent.role !== 'manager') throw new Error('That wake belongs to another agent');
          const cancelled = await deps.store.settleWake(wake.id, { status: 'cancelled', reason: 'cancelled', detail: `cancelled by ${agent.name}` });
          if (!cancelled) throw new Error('The wake settled before it could be cancelled');
          await publishAgent(deps, wake.agentId);
          return result({ cancelled: wakeSummary(cancelled) });
        }
        default: throw new Error(`Unknown wake action ${String((args as { action: unknown }).action)}`);
      }
    },
  };
}
const clipTo = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}… (${text.length} characters; the goal's notes have it in full)` : text;
