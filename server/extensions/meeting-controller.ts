import type { ProviderSession } from './meeting-session.js';
import { providerObservation } from './meeting-session.js';
export interface JoinRequest {
  sessionId: string; ownerId: string; conversationId: string; meetingUrl: string;
  endsAt: number; observedAt: number; included: boolean;
}
export interface MeetingControllerPorts {
  /** Atomic INSERT IF ABSENT. Return false for any existing/uncertain join. */
  reserve(request: JoinRequest): Promise<boolean>;
  save(session: ProviderSession): Promise<void>;
  join(request: JoinRequest): Promise<{ providerSessionId: string; observedAt: number; state: 'lobby' | 'entered' | 'left' | 'unknown' }>;
}
/** The fresh current policy result must be obtained by the caller, never inferred from a due notice. */
export async function joinMeeting(request: JoinRequest, now: number, ports: MeetingControllerPorts): Promise<ProviderSession> {
  const age = now - request.observedAt;
  if (!request.included || !Number.isFinite(age) || age < -5000 || age > 60000 || !Number.isFinite(request.endsAt) || request.endsAt <= now) throw new Error('Fresh eligible meeting required');
  if (!request.sessionId || !request.ownerId || !request.conversationId || !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(request.meetingUrl)) throw new Error('Invalid WORK meeting join');
  if (!await ports.reserve(request)) throw new Error('Existing join must be reconciled, not repeated');
  // A thrown/unknown join keeps the reservation. It is not safe to create a second provider effect.
  const result = await ports.join(request);
  if (!result.providerSessionId || result.observedAt < request.observedAt) throw new Error('Current provider evidence required');
  const session = providerObservation({ sessionId: request.sessionId, ownerId: request.ownerId, conversationId: request.conversationId,
    providerSessionId: result.providerSessionId, phase: 'joining', endsAt: request.endsAt, lastObservedAt: request.observedAt }, result);
  await ports.save(session);
  return session;
}
