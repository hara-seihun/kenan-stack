import { RECALL_BOT_NAME } from './meeting-recall.js';

/** A Meet link someone sent Kenan in a DM or an @-mention, asking it to join. */
export interface JoinRequestMessage { channel: string; ts: string; user: string; text: string }
/** Whether Slack's message timestamp (seconds.micros) is at or after the cutoff in epoch milliseconds. */
export function sentSince(message: JoinRequestMessage, since: number): boolean {
  const seconds = Number(message.ts);
  return Number.isFinite(seconds) && seconds * 1000 >= since;
}
export interface ParsedJoinRequest { meetingUrl: string; code: string }

export interface CalendarMeeting {
  eventKey: string; eventId: string; title: string; meetingUrl: string; organizerEmail: string;
  startAt: string; endAt: string; fingerprint: string;
  attendance: { included: boolean; reason?: string; excludedPerson?: string };
  attendees?: { email: string; displayName: string | null; responseStatus?: string | null }[];
  /** The series this occurrence belongs to (meeting discovery), when it recurs. */
  recurringEventId?: string;
  /** Meeting discovery: the event's title or description carries #kenanvoice. */
  voiceRequested?: boolean;
}

const MEET_CODE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z-])/i;
const DECLINE = /\b(?:don'?t|do not|no need to|never|stop)\b[^.!?\n]*\bjoin/i;
export const meetCode = (url: string) => MEET_CODE.exec(url)?.[1]?.toLowerCase() ?? null;

/** A Meet link in a message to Kenan is a request to join it, unless the message tells Kenan not to. */
export function parseJoinRequest(text: string): ParsedJoinRequest | null {
  const code = meetCode(text);
  if (!code || DECLINE.test(text)) return null;
  return { code, meetingUrl: `https://meet.google.com/${code}` };
}

export const SOON_MS = 30 * 60_000;
export const ADHOC_MS = 60 * 60_000;

export interface JoinPolicy {
  personExclusions: { email: string; displayName?: string | null }[];
  uninvitedPersonExclusions?: { email: string; displayName?: string | null }[];
  meetingExclusions: { eventKey: string }[];
  seriesExclusions?: { recurringEventId: string }[];
}

export type JoinDecision =
  | { kind: 'policy-unavailable' }
  | { kind: 'join'; meeting: CalendarMeeting }
  | { kind: 'join-overrun'; meeting: CalendarMeeting }
  | { kind: 'unlisted' }
  | { kind: 'later'; meeting: CalendarMeeting }
  | { kind: 'excluded-person'; meeting: CalendarMeeting; email: string; name: string }
  | { kind: 'excluded-meeting'; meeting: CalendarMeeting };

/**
 * What to do with a join request, from a complete, fresh Calendar observation (every meeting, included or not).
 * The occurrence that matters is the one in progress, else the next one within 30 minutes, else the most recent
 * one that already ended, else the next one. Someone's opt-out always wins over the requester.
 */
export function decideJoin(request: ParsedJoinRequest, meetings: CalendarMeeting[], now: number, policy?: JoinPolicy): JoinDecision {
  const same = meetings.filter(m => meetCode(m.meetingUrl) === request.code)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const current = same.find(m => Date.parse(m.startAt) <= now + SOON_MS && Date.parse(m.endAt) > now)
    ?? same.filter(m => Date.parse(m.endAt) <= now).at(-1)
    ?? same.find(m => Date.parse(m.startAt) > now);
  // With no calendar event Kenan can't see who is in the call, so it can't honour anyone's opt-out: it stays out.
  if (!current) return { kind: 'unlisted' };
  // Automatic selection can hide opt-outs. Explicit requests use the fresh policy itself.
  const normalize = (email: string) => email.trim().toLowerCase();
  if (policy) {
    const active = new Set([normalize(current.organizerEmail), ...(current.attendees ?? [])
      .filter(a => a.responseStatus !== 'declined').map(a => normalize(a.email))]);
    const invited = (current.attendees ?? []).some(a => normalize(a.email) === 'person25@example.com' && a.responseStatus !== 'declined');
    const excluded = [...policy.personExclusions, ...(!invited ? policy.uninvitedPersonExclusions ?? [] : [])]
      .find(p => active.has(normalize(p.email)));
    if (excluded) return { kind: 'excluded-person', meeting: current, email: excluded.email,
      name: excluded.displayName ?? current.attendees?.find(a => normalize(a.email) === normalize(excluded.email))?.displayName ?? excluded.email };
    if (policy.meetingExclusions.some(e => e.eventKey === current.eventKey)
      || policy.seriesExclusions?.some(e => e.recurringEventId === current.recurringEventId))
      return { kind: 'excluded-meeting', meeting: current };
  } else if (!current.attendance.included) {
    const email = ['person-exclusion', 'uninvited-person-exclusion'].includes(current.attendance.reason ?? '') ? current.attendance.excludedPerson : undefined;
    if (email) return { kind: 'excluded-person', meeting: current, email,
      name: current.attendees?.find(a => normalize(a.email) === normalize(email))?.displayName ?? email };
    // Never describe selection, missing policy or an unknown refusal as a meeting opt-out.
    return { kind: 'policy-unavailable' };
  }
  if (!current.attendance.included && !['not-chosen', 'person-exclusion', 'uninvited-person-exclusion', 'meeting-exclusion', 'series-exclusion'].includes(current.attendance.reason ?? ''))
    return { kind: 'policy-unavailable' };
  if (Date.parse(current.startAt) > now + SOON_MS) return { kind: 'later', meeting: current };
  // Past its scheduled end the meeting has dropped out of discovery, but its invitees are known and none opted out.
  if (Date.parse(current.endAt) <= now) return { kind: 'join-overrun', meeting: current };
  return { kind: 'join', meeting: current };
}

/**
 * Whether a refusal names the invitee who opted out. tools.meeting.optedOutNames in the person's config:
 * 'withheld' (also when unset) never names them; 'requester-dm' names them only in a 1:1 DM with the requester.
 */
export type OptedOutNames = 'withheld' | 'requester-dm';
export function optedOutNamesSetting(value: unknown): { ok: true; value: OptedOutNames } | { ok: false; error: string } {
  if (value === undefined || value === 'withheld') return { ok: true, value: 'withheld' };
  if (value === 'requester-dm') return { ok: true, value };
  return { ok: false, error: `tools.meeting.optedOutNames must be "withheld" or "requester-dm", not ${JSON.stringify(value)}` };
}
/** Slack's own conversation record for the channel a request came from; unknown when Slack couldn't say. */
export type ConversationKind = 'one-to-one-dm' | 'other' | 'unknown';
export type OptOutDisclosure = 'named' | 'ask-in-dm' | 'withheld';
export function optOutDisclosure(setting: OptedOutNames, conversation: ConversationKind): OptOutDisclosure {
  if (setting === 'withheld') return 'withheld';
  return conversation === 'one-to-one-dm' ? 'named' : 'ask-in-dm';
}

export type JoinOutcome =
  | { kind: 'joining'; title: string | null }
  | { kind: 'already-joined'; title: string | null }
  | { kind: 'later'; title: string; startAt: string; autoJoin: boolean }
  | { kind: 'excluded-person'; name: string; disclosure: OptOutDisclosure }
  | { kind: 'excluded-meeting'; title: string }
  | { kind: 'unlisted' }
  | { kind: 'joins-disabled' }
  | { kind: 'calendar-unavailable' }
  | { kind: 'join-failed' };

const clock = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const named = (title: string | null) => title ? ` ${title}` : '';

/** The answer in the requester's thread: plain, and when it's a no, what would turn it into a yes. */
export function replyText(outcome: JoinOutcome): string {
  switch (outcome.kind) {
    case 'joining': return `Joining${named(outcome.title)} now. If there's a lobby, someone will need to admit ${RECALL_BOT_NAME}.`;
    case 'already-joined': return `I'm already in${named(outcome.title)} (or on my way in).`;
    case 'later': return outcome.autoJoin
      ? `${outcome.title} starts at ${clock(outcome.startAt)}. I'll join when it starts.`
      : `${outcome.title} starts at ${clock(outcome.startAt)}. Send me the link again when it starts and I'll join.`;
    // Who opted out is said only in a 1:1 DM with the requester, and only where that is switched on.
    case 'excluded-person': switch (outcome.disclosure) {
      case 'named': return `I can't join this one: ${outcome.name} is invited, and they asked not to have the notetaker in meetings they attend. Ask them, or take them off the invite and send me the link again.`;
      case 'ask-in-dm': return `I can't join this one: someone invited asked not to have the notetaker in meetings they attend. DM me the link and I'll tell you who.`;
      case 'withheld': return `I can't join this one: someone invited asked not to have the notetaker in meetings they attend.`;
    }
    case 'excluded-meeting': return `I can't join ${outcome.title}: it's on the list of meetings I've been asked to stay out of.`;
    case 'unlisted': return `I can't join that call: it isn't on any calendar I can read, so I can't check whether anyone in it has asked not to have the notetaker. Put it on a calendar invite and send me the link again.`;
    case 'joins-disabled': return `I can't join meetings right now: joining is switched off. I've flagged it so it gets fixed.`;
    case 'calendar-unavailable': return `I couldn't read the calendars just now, so I can't check who's invited and I haven't joined. I've flagged it; send the link again in a minute.`;
    case 'join-failed': return `I tried to join but the notetaker service didn't take the request, so I'm not in the meeting. I've flagged it so it gets fixed.`;
  }
}
