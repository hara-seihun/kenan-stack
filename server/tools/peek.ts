import type { AgentInfo } from '../../shared/contract.js';
import type { Deps, RecentWork } from '../types.js';
import { wakeSummary } from '../agents/wakes.js';

/**
 * What a worker is doing right now, read from its stored conversation and its live turn. One worker gets the detailed
 * view, all active workers the compact one, so every peek stays within a few KB per worker.
 */
export const PEEK_SHAPES = {
  compact: { said: 2, did: 5, text: 300, args: 160, out: 240, input: 200 },
  detailed: { said: 6, did: 15, text: 1200, args: 400, out: 800, input: 600 },
} as const;
export type PeekShape = keyof typeof PEEK_SHAPES;
/** All active workers is bounded; beyond this many the rest are counted, not shown. */
export const PEEK_MAX_WORKERS = 30;

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-|or-)?[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  [/((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization|cookie|session[_-]?key)\\?["']?\s*[:=]\s*\\?["']?)(?!\[redacted)[^\s"'\\,;&]{6,}/gi, '$1[redacted]'],
];
/** Credential-looking content never leaves a peek. */
export function redact(text: string): string {
  return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
const flat = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
/** Redacted before it is cut, so a secret straddling the cut can't leak its prefix. */
const clip = (text: string, limit: number, total = text.length) => {
  const shown = flat(redact(text));
  return shown.length <= limit && total <= text.length ? shown : `${shown.slice(0, limit)}… [${total} chars]`;
};
/** A tool's output: its start and its end, since errors and results usually land last. */
const output = (head: string, tail: string, total: number, limit: number) => {
  if (total <= limit) return flat(redact(head));
  const half = Math.floor(limit / 2);
  return `${flat(redact(head)).slice(0, half)} … ${flat(redact(tail)).slice(-half)} [${total} chars]`;
};
/** The end of a message's reasoning: where it has got to. */
const thought = (text: string, limit: number) => { const shown = flat(redact(text)); return shown.length <= limit ? shown : `…${shown.slice(-limit)}`; };
const ago = (now: number, at: number) => Math.max(0, Math.round((now - at) / 1000));

export type PeekError = 'worker_not_found' | 'worker_archived' | 'worker_id_ambiguous';
export class PeekFailure extends Error {
  constructor(readonly code: PeekError, message: string) { super(`${code}: ${message}`); }
}

/** A worker named by its id or a unique prefix of at least 8 characters, among the person's workers. */
export function resolveWorker(workers: AgentInfo[], ref: string): AgentInfo {
  const exact = workers.find(w => w.id === ref);
  const matches = exact ? [exact] : ref.length >= 8 ? workers.filter(w => w.id.startsWith(ref.toLowerCase())) : [];
  if (matches.length > 1) throw new PeekFailure('worker_id_ambiguous', `${ref} matches ${matches.map(w => w.id).join(', ')}`);
  const worker = matches[0];
  if (!worker) throw new PeekFailure('worker_not_found', `no worker ${ref}`);
  if (worker.archived) throw new PeekFailure('worker_archived', `${worker.name} (${worker.id}) is archived${worker.lastReport ? `; it reported ${worker.lastReport.status}: ${clip(worker.lastReport.text, 300)}` : ''}`);
  return worker;
}

export async function peekWorkers(deps: Deps, ownerId: string, workers: AgentInfo[], shape: PeekShape) {
  const s = PEEK_SHAPES[shape], now = deps.now();
  const [work, wakes, goals] = await Promise.all([
    deps.store.recentWork(workers.map(w => w.conversationId), { said: s.said, did: s.did, chars: Math.max(s.text, s.args, s.out) * 2 }),
    deps.store.pendingWakes(ownerId),
    deps.store.listGoals(ownerId),
  ]);
  const titles = new Map(goals.map(goal => [goal.id, goal.title]));
  const view = (worker: AgentInfo) => {
    const recent: RecentWork = work.get(worker.conversationId) ?? { lastActivityAt: worker.createdAt, said: [], did: [] };
    const turn = deps.runtime.turnOf(worker.id);
    const activity = deps.bus.activity(worker.conversationId);
    return {
      id: worker.id, name: worker.name, state: worker.state,
      goal: worker.goalId ? { id: worker.goalId, title: titles.get(worker.goalId) ?? null } : null,
      parent: worker.parentAgentId,
      turn: turn && { ageS: ago(now, turn.startedAt), queued: turn.queued, inputs: turn.inputs.map(input => ({ kind: input.kind, from: input.fromId, text: clip(input.text, s.input) })) },
      activity: activity && { state: activity.state, label: activity.label && clip(activity.label, s.text), forS: ago(now, activity.since) },
      idleS: ago(now, Math.max(recent.lastActivityAt, turn?.startedAt ?? 0)),
      wakes: wakes.filter(wake => wake.agentId === worker.id).map(wakeSummary),
      lastReport: worker.lastReport && { status: worker.lastReport.status, agoS: ago(now, worker.lastReport.at), text: clip(worker.lastReport.text, s.text) },
      said: recent.said.map(m => ({ agoS: ago(now, m.at), ...(m.text.trim() ? { text: clip(m.text, s.text, m.textLength) } : {}), ...(m.thinking ? { thinking: thought(m.thinking, s.text) } : {}) })),
      did: recent.did.map(call => ({
        agoS: ago(now, call.at), tool: call.name, args: clip(call.args, s.args, call.argsLength),
        ...(call.running ? { runningS: ago(now, call.at) } : { tookS: ago(call.updatedAt, call.at), result: output(call.head, call.tail, call.outLength, s.out) }),
        ...(call.isError ? { error: true } : {}),
      })),
    };
  };
  return workers.map(view);
}
