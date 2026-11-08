import { SHARED_MEETINGS_URL } from './meeting-shared-notes.js';
/**
 * Who gets a meeting's notes by Slack DM once it ends (Taylor Taylor, Alice / Taylor Sync, November 4, 2026: notes reach
 * the people in the meeting who should have them, so he can later ask for his action items).
 *
 * The organizer, and every attendee who opted in to Kenan joining their meetings (the attendance policy's
 * uninvitedIncludedEmails), when they actually took part (not declined). Only acme.example addresses; never Kenan itself;
 * never the owner's own addresses (the explicit inclusion list, Alice), whose notes already arrive in the owner's
 * meeting conversation; never someone on the person exclusions.
 */
export type NotesAttendee = { email: string; responseStatus?: string | null };
export type NotesRecipientInput = {
  organizerEmail: string | null;
  attendees: readonly NotesAttendee[];
  optedIn: readonly string[];
  ownerEmails: readonly string[];
  excluded: readonly string[];
  kenanEmail: string;
};
export type NotesRecipient = { email: string; why: 'organizer' | 'opted-in' };

const norm = (email: string) => email.trim().toLowerCase();
const ACME = (email: string) => /^[^@\s]+@acme.example$/u.test(email);

export function notesRecipients(i: NotesRecipientInput): NotesRecipient[] {
  const never = new Set([norm(i.kenanEmail), ...i.ownerEmails.map(norm), ...i.excluded.map(norm)]);
  const declined = new Set(i.attendees.filter(a => a.responseStatus === 'declined').map(a => norm(a.email)));
  const out = new Map<string, NotesRecipient>();
  const add = (email: string, why: NotesRecipient['why']) => {
    const e = norm(email);
    if (!ACME(e) || never.has(e) || declined.has(e) || out.has(e)) return;
    out.set(e, { email: e, why });
  };
  if (i.organizerEmail) add(i.organizerEmail, 'organizer');
  const optedIn = new Set(i.optedIn.map(norm));
  for (const a of i.attendees) if (optedIn.has(norm(a.email))) add(a.email, 'opted-in');
  return [...out.values()];
}

/** The DM: the notes themselves, why this person gets them, and how to keep Kenan out. */
export function notesDm(title: string, startAt: string | null, notes: string, why: NotesRecipient['why']): string {
  const when = startAt ? ` (${startAt.slice(0, 10)})` : '';
  const reason = why === 'organizer' ? 'you organized it' : 'you asked Kenan to join your meetings';
  const body = notes.length > 12000 ? `${notes.slice(0, 12000)}\n…` : notes;
  return `Notes from "${title}"${when}, sent to you because ${reason}:\n\n${body}\n\n`
    + `Notes and transcripts of your meetings, and whether Kenan joins them: ${SHARED_MEETINGS_URL} (sign in with your ACME Google account). `
    + 'To keep Kenan out of a call, say "Kenan, leave" in the meeting.';
}
