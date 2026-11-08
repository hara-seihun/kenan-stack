// One calendar event's description (its agenda), read for the meeting voice so Kenan can answer "what is this meeting
// about?" at once. Read with Google Workspace domain-wide delegation, the same way meeting discovery reads calendars
// (products/kenan/src/meeting-agent/calendar.ts mintWorkspaceToken): this host's GCE metadata token signs a JWT for the
// configured service account through IAM Credentials, the JWT is exchanged for a token acting as the calendar's owner
// with the read-only events scope, and one event is fetched.
//
// The description is company content: it is bounded, stripped of HTML, never logged, and kept only in memory and in the
// meeting voice's context. A failure is a typed reason; the meeting goes on without an agenda.

/** tools.meeting.calendarContext: absent means no agenda is read. */
export type CalendarContextConfig = { serviceAccountEmail: string };
export function calendarContextConfig(raw: unknown): CalendarContextConfig | null {
  if (raw === undefined || raw === null) return null;
  const email = (raw as { serviceAccountEmail?: unknown }).serviceAccountEmail;
  if (typeof raw !== 'object' || Object.keys(raw).some(k => k !== 'serviceAccountEmail') || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email))
    throw new Error('tools.meeting.calendarContext must be { "serviceAccountEmail": "<name>@<project>.iam.gserviceaccount.com" }');
  return { serviceAccountEmail: email };
}

// The domain-wide delegation grant for this service account covers calendar.events, not the readonly scopes (both readonly
// scopes answered 401 on November 6, 2026). Only GET is ever sent with it.
export const CALENDAR_EVENTS_READONLY = 'https://www.googleapis.com/auth/calendar.events';
export const DESCRIPTION_MAX_CHARS = 6_000;
const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export type CalendarEventContext = {
  description: string | null; summary: string | null;
  attendees: { email: string; displayName: string | null; responseStatus: string | null }[];
  organizer: { email: string | null; displayName: string | null } | null;
};
/** Why no agenda was read (logged; the description itself never is). */
export type CalendarContextFailure = 'not-configured' | 'no-event' | 'metadata-token' | 'sign-jwt' | 'token-exchange' | 'event-read' | 'invalid-response' | 'timeout';
export class CalendarContextError extends Error {
  constructor(readonly reason: CalendarContextFailure, readonly status: number | null = null) { super(`calendar_context_${reason}${status ? ` (${status})` : ''}`); }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** "calendarId:eventId" (meeting discovery's eventKey) as its two parts; null for keys that name no calendar event. */
export function eventOf(eventKey: string, eventId?: string | null): { calendarId: string; eventId: string } | null {
  if (eventId && eventKey.endsWith(`:${eventId}`)) {
    const calendarId = eventKey.slice(0, -(eventId.length + 1));
    return calendarId && !calendarId.includes(':') ? { calendarId, eventId } : null;
  }
  const at = eventKey.lastIndexOf(':');
  if (at <= 0 || eventKey.indexOf(':') !== at) return null;
  return { calendarId: eventKey.slice(0, at), eventId: eventKey.slice(at + 1) };
}

/** An event description as plain text: tags removed, entities decoded, whitespace tidied, at most DESCRIPTION_MAX_CHARS. */
export function plainDescription(html: string): string {
  const text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n').replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > DESCRIPTION_MAX_CHARS ? `${text.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : text;
}

/**
 * Reads one event through domain-wide delegation. `fetchImpl` is injected in tests. Throws CalendarContextError with a
 * typed reason; never includes the description in an error.
 */
export async function readEventContext(config: CalendarContextConfig, event: { calendarId: string; eventId: string }, fetchImpl: Fetch = fetch as Fetch, timeoutMs = 10_000): Promise<CalendarEventContext> {
  const signal = () => AbortSignal.timeout(timeoutMs);
  const call = async (reason: CalendarContextFailure, input: string, init: RequestInit) => {
    let response: Awaited<ReturnType<Fetch>>;
    try { response = await fetchImpl(input, { ...init, signal: signal() }); }
    catch (error) { throw new CalendarContextError((error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : reason); }
    if (!response.ok) throw new CalendarContextError(reason, response.status);
    try { return await response.json() as Record<string, unknown>; } catch { throw new CalendarContextError('invalid-response'); }
  };
  const metadata = await call('metadata-token', METADATA_TOKEN, { headers: { 'metadata-flavor': 'Google' } });
  if (typeof metadata.access_token !== 'string') throw new CalendarContextError('metadata-token');
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now, iss: config.serviceAccountEmail, scope: CALENDAR_EVENTS_READONLY, sub: event.calendarId });
  const signed = await call('sign-jwt', `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:signJwt`,
    { method: 'POST', headers: { authorization: `Bearer ${metadata.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ payload }) });
  if (typeof signed.signedJwt !== 'string' || !signed.signedJwt) throw new CalendarContextError('sign-jwt');
  const exchanged = await call('token-exchange', 'https://oauth2.googleapis.com/token',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ assertion: signed.signedJwt, grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer' }).toString() });
  if (typeof exchanged.access_token !== 'string' || !exchanged.access_token) throw new CalendarContextError('token-exchange');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(event.calendarId)}/events/${encodeURIComponent(event.eventId)}?fields=${encodeURIComponent('description,summary,attendees(displayName,email,responseStatus),organizer')}`;
  const body = await call('event-read', url, { headers: { authorization: `Bearer ${exchanged.access_token}` } });
  const attendees = Array.isArray(body.attendees) ? (body.attendees as Record<string, unknown>[]).filter(a => typeof a?.email === 'string').map(a => ({
    email: a.email as string, displayName: typeof a.displayName === 'string' ? a.displayName : null, responseStatus: typeof a.responseStatus === 'string' ? a.responseStatus : null })) : [];
  const organizer = body.organizer && typeof body.organizer === 'object' ? body.organizer as Record<string, unknown> : null;
  const description = typeof body.description === 'string' ? plainDescription(body.description) : '';
  return { description: description || null, summary: typeof body.summary === 'string' ? body.summary : null, attendees,
    organizer: organizer ? { email: typeof organizer.email === 'string' ? organizer.email : null, displayName: typeof organizer.displayName === 'string' ? organizer.displayName : null } : null };
}
