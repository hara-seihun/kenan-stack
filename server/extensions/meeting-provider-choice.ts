/**
 * Which notetaker autojoin sends to a meeting (Alice's direction through manager:acme, 2026-10-30).
 *
 * Recall's bot is a guest: in an internal meeting Kenan wasn't invited to, nobody admits it from the lobby.
 * Kenan's own native notetaker is the signed-in acme.example account, so it enters internal meetings directly,
 * and since November 2, 2026 it talks and presents too (meeting-joiner-voice.ts). So native goes wherever there is
 * native capacity (our cap and the cloud browser's free sessions), invited or not; at capacity: Recall. Until
 * November 4, 2026 an invitation sent Recall, whose guest bot then waited in the lobby of meetings that had invited
 * Kenan (self-service opt-in for the company is inviting person25@example.com, goal bebd442d).
 * Either way it is one notetaker per meeting (the claim row), with the same opt-outs, announcement and
 * leave-on-request.
 */
export type AutojoinChoice = { kind: 'native' | 'recall' | 'none'; why: string };

export interface AutojoinInput {
  nativeConfigured: boolean;
  recallEnabled: boolean;
  /** Kenan's own account is on the invitation. */
  invited: boolean;
  /** Native notetakers in a call (or starting) right now. */
  nativeActive: number;
  /** Our own cap on concurrent native notetakers. */
  nativeMax: number;
  /** Free cloud browser sessions, or null when unknown or not used. */
  cloudFree: number | null;
}

export function chooseAutojoinProvider(i: AutojoinInput): AutojoinChoice {
  const nativeRoom = i.nativeActive < i.nativeMax && (i.cloudFree === null || i.cloudFree > 0);
  if (!i.nativeConfigured) return i.recallEnabled ? { kind: 'recall', why: 'native notetaker not configured' } : { kind: 'none', why: 'no notetaker configured' };
  if (!i.recallEnabled) return nativeRoom ? { kind: 'native', why: 'Recall not enabled' } : { kind: 'none', why: 'native notetaker at capacity and Recall not enabled' };
  if (!nativeRoom) return { kind: 'recall', why: i.nativeActive >= i.nativeMax ? `native notetaker at capacity (${i.nativeActive}/${i.nativeMax})` : 'no free cloud browser session' };
  return { kind: 'native', why: i.invited ? 'Kenan is invited: the signed-in account enters without the lobby' : 'Kenan is not invited: the signed-in account enters without the lobby' };
}

/** Kenan's own account is on the invitation, as meeting discovery reports it. */
export const kenanInvited = (meeting: { attendance: { reason?: string } }): boolean => meeting.attendance.reason === 'calendar-invitation';
