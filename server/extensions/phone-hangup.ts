// Hanging up once Kenan has said goodbye. This decides when the bridge ends the call, never when GPT Live speaks.
/** After Kenan's goodbye, whether the bridge may hang up. GPT Live's transcript runs ahead of its audio, so both sides
 *  must be quiet on the transcript and Kenan's voice must have stopped reaching the phone; a reply the call agent is still
 *  writing holds the line (call 714bd84f: the answer to Alice's last question came after both goodbyes and was cut off),
 *  for at most REPLY_HOLD_MS after the goodbye. */
export const GOODBYE_QUIET_MS = 3500, VOICE_QUIET_MS = 1200, REPLY_HOLD_MS = 20_000;
/** After a goodbye, this long with no words from either side ends the call whatever the audio does: on call 9cbb9e63
 *  (2026-10-21, Dave's Kenan calling Kenan) GPT Live's stream carried full-size frames for 527 s after both goodbyes,
 *  so the voice test never passed and the line stayed open until the other side dropped. */
export const GOODBYE_CAP_MS = 15_000;
export type HangUp = { kind: 'wait' } | { kind: 'hold'; pendingReplies: number } | { kind: 'end'; unanswered: number };
export function goodbyeHangUp(s: { now: number; goodbyeAt: number; lastSpeech: number; lastKenanVoice: number; pendingReplies: number }): HangUp {
  if (s.now - Math.max(s.lastSpeech, s.goodbyeAt) > GOODBYE_CAP_MS) return { kind: 'end', unanswered: s.pendingReplies };
  if (s.now - s.lastSpeech <= GOODBYE_QUIET_MS || s.now - s.lastKenanVoice <= VOICE_QUIET_MS) return { kind: 'wait' };
  if (s.pendingReplies > 0 && s.now - s.goodbyeAt <= REPLY_HOLD_MS) return { kind: 'hold', pendingReplies: s.pendingReplies };
  return { kind: 'end', unanswered: s.pendingReplies };
}
