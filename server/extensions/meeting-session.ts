/** Provider lifecycle is deliberately separate from Calendar discovery status. */
export type ProviderPhase = 'joining' | 'active' | 'leaving' | 'ended' | 'unknown';
export interface ProviderSession {
  sessionId: string; ownerId: string; conversationId: string;
  providerSessionId: string; phase: ProviderPhase;
  endsAt: number; lastObservedAt: number;
}
export type SessionAction = 'observe' | 'leave' | 'none';
/**
 * When the bot leaves. 'until-alone': the provider removes the bot itself once every other
 * participant has gone (ALONE_GRACE_SECONDS) or the host ends the call; Kenan only enforces
 * withdrawal, an unadmitted bot at the scheduled end, and OVERTIME_CAP_MS past it.
 * 'scheduled-end': the provider can't see who is present, so Kenan leaves at the scheduled end.
 */
export type LeavePolicy = 'until-alone' | 'scheduled-end';
export const ALONE_GRACE_SECONDS = 120;
export const OVERTIME_CAP_MS = 3 * 3600_000;
export const latestLeaveAt = (session: Pick<ProviderSession, 'endsAt'>) => session.endsAt + OVERTIME_CAP_MS;
/** Missing provider evidence means reconcile, never create another join. */
export function watchdogAction(session: ProviderSession, now: number, included: boolean, policy: LeavePolicy): SessionAction {
  if (session.phase === 'ended') return 'none';
  // included: still on the calendar (the caller decides what absence means past the scheduled end).
  if (!included) return 'leave';
  if (now >= session.endsAt && (policy === 'scheduled-end' || now >= latestLeaveAt(session) || session.phase === 'joining')) return 'leave';
  // A joining bot may be waiting in a lobby, where its host is pinged at once: observe it every pass.
  if (session.phase === 'unknown' || session.phase === 'joining' || now - session.lastObservedAt > 30000) return 'observe';
  return 'none';
}
export function providerObservation(session: ProviderSession, result: {
  providerSessionId: string; observedAt: number; state: 'lobby' | 'entered' | 'left' | 'unknown';
}): ProviderSession {
  if (result.providerSessionId !== session.providerSessionId) throw new Error('Provider session mismatch');
  if (!Number.isFinite(result.observedAt) || result.observedAt < session.lastObservedAt) throw new Error('Stale provider evidence');
  if (session.phase === 'ended' && result.state !== 'left') throw new Error('Ended session cannot restart');
  return { ...session, lastObservedAt: result.observedAt,
    phase: result.state === 'left' ? 'ended' : result.state === 'entered' ? 'active' : result.state === 'lobby' ? 'joining' : 'unknown' };
}
export interface ProviderAdapter {
  observe(providerSessionId: string): Promise<{ providerSessionId: string; observedAt: number; state: 'lobby' | 'entered' | 'left' | 'unknown' }>;
  /** Must be idempotent; leave does not itself prove that the provider left. */
  leave(providerSessionId: string): Promise<void>;
}
export async function reconcileProviderSession(session: ProviderSession, now: number, included: boolean, policy: LeavePolicy, adapter: ProviderAdapter): Promise<ProviderSession> {
  const action = watchdogAction(session, now, included, policy);
  if (action === 'none') return session;
  let next = session;
  if (action === 'leave') {
    await adapter.leave(session.providerSessionId);
    next = { ...session, phase: 'leaving' };
  }
  // Observe even after an accepted leave; never claim terminal cleanup from send acceptance.
  const observed = providerObservation(next, await adapter.observe(session.providerSessionId));
  return action === 'leave' && observed.phase !== 'ended' ? { ...observed, phase: 'leaving' } : observed;
}
