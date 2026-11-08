/**
 * Recall as the fallback when autojoin's native notetaker can't get in (Alice's direction through manager:acme,
 * 2026-10-30): sign-in lost, a CAPTCHA, a crash, or still not in the call NATIVE_ENTER_DEADLINE_MS after it set out.
 * The native claim is released first (its joiner asked to leave, and stopped if it doesn't), and Recall is sent only
 * once the joiner's unit is gone, so the meeting never has two notetakers at once. Only autojoin claims fall back:
 * a native join someone asked for by name stays native.
 */
import type { JoinerSummary } from './meeting-native.js';

/** How long after the joiner sets out (its start, or 90 s before the meeting, whichever is later) it must be in the call. */
export const NATIVE_ENTER_DEADLINE_MS = 180_000;
/** How long a joiner asked to leave for the fallback gets before its unit is stopped. */
export const NATIVE_RELEASE_STOP_MS = 60_000;

/** Native leave reasons that mean it couldn't attend, as opposed to the meeting ending or someone sending it away. */
const FAILED = new Set(['failed', 'denied', 'not-admitted']);

export interface NativeFallbackInput {
  /** The claim came from autojoin (not a join that named the native provider). */
  autojoin: boolean;
  recallEnabled: boolean;
  summary: Pick<JoinerSummary, 'state' | 'enteredAt' | 'reason' | 'detail'>;
  /** When the joiner sets out: max(start of the joiner, the meeting's start less ENTER_BEFORE_START_MS); null when unknown. */
  setOutAt: number | null;
  now: number;
}

/** Why the native notetaker should give the meeting to Recall, or null. */
export function nativeFallbackWhy(i: NativeFallbackInput): string | null {
  if (!i.autojoin || !i.recallEnabled) return null;
  const s = i.summary;
  if (s.state === 'left') {
    if (!s.reason || !FAILED.has(s.reason)) return null;
    // A joiner that was in the call and then failed (a crash) also falls back; one that ended normally never does.
    return `the native notetaker ${s.reason === 'failed' ? 'failed' : s.reason === 'denied' ? 'was refused by Google Meet' : 'was not let in'}${s.detail ? `: ${s.detail}` : ''}`;
  }
  // A notetaker in the lobby has knocked and the host has been pinged; Recall would need the same admission, and ACME's
  // Meet refuses anonymous guests outright ("You can't join this video call", seen November 2, 2026). Keep the knock;
  // if nobody lets it in by admitUntil it leaves as not-admitted, which falls back above.
  if (s.state === 'lobby') return null;
  if (s.enteredAt === null && i.setOutAt !== null && i.now >= i.setOutAt + NATIVE_ENTER_DEADLINE_MS)
    return `the native notetaker was still not in the call ${Math.round(NATIVE_ENTER_DEADLINE_MS / 60_000)} minutes after joining (${s.state})`;
  return null;
}

export type FallbackStep =
  /** Ask the joiner to leave (once), and stop its unit once NATIVE_RELEASE_STOP_MS have passed. */
  | { kind: 'release'; stop: boolean }
  /** The joiner is gone: send Recall now (the meeting is still current and not over). */
  | { kind: 'recall' }
  /** The joiner is gone but the meeting is over or withdrawn: just finish the native claim. */
  | { kind: 'finish' }
  /** Discovery is unreadable this tick: keep the claim until a current read decides. */
  | { kind: 'wait' };

/** The next step for a claim whose fallback is recorded (at: when it was recorded). */
export function fallbackStep(i: { at: number; now: number; unitGone: boolean; current: boolean | null; endsAt: number }): FallbackStep {
  if (!i.unitGone) return { kind: 'release', stop: i.now - i.at >= NATIVE_RELEASE_STOP_MS };
  if (i.now >= i.endsAt) return { kind: 'finish' };
  if (i.current === null) return { kind: 'wait' };
  return i.current ? { kind: 'recall' } : { kind: 'finish' };
}
