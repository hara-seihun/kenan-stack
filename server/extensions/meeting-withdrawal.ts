/**
 * Being removed from a meeting Kenan joined uninvited is a withdrawal (manager:acme, November 2, 2026, after Tiago
 * Dias removed the native notetaker from his "Atlas BO Sync" within a minute). The removal is recorded as an opt-out in
 * the attendance policy that meeting discovery reads, so the notetaker never turns up uninvited at that meeting again:
 * the whole series when the event recurs, that one event otherwise. The occurrence itself is never rejoined: its claim
 * row has ended, and the joiner does not re-enter after a removal.
 *
 * The policy object is shared with discovery and with people's own opt-out edits, so the write is a compare-and-swap on
 * its GCS generation, retried on a conflict, and adding an entry that is already there changes nothing.
 */
export type PolicyExclusion =
  | { kind: 'series'; recurringEventId: string; meetingTitle: string; why: string }
  | { kind: 'meeting'; eventKey: string; meetingTitle: string; why: string };

export interface WithdrawalInput {
  /** The claim came from autojoin: Kenan was not asked to this meeting by anyone. */
  autojoin: boolean;
  reason: string | null;
  title: string;
  eventKey: string;
  recurringEventId?: string | null;
  organizerEmail: string;
  leftAt: number | null;
  sessionId: string;
}

/** The opt-out a removal from an uninvited meeting records, or null when nothing should be recorded. */
export function withdrawalExclusion(i: WithdrawalInput): PolicyExclusion | null {
  if (!i.autojoin || i.reason !== 'removed') return null;
  // Ad hoc and overrun sessions carry synthetic keys; they are not calendar events discovery could exclude.
  if (i.eventKey.startsWith('overrun:') || i.eventKey.startsWith('adhoc:')) return null;
  const when = i.leftAt ? new Date(i.leftAt).toISOString() : 'unknown time';
  const why = `removed from the call at ${when} (organizer ${i.organizerEmail}, notetaker session ${i.sessionId.slice(0, 16)}); `
    + 'a removal from a meeting Kenan joined uninvited is a withdrawal';
  return i.recurringEventId
    ? { kind: 'series', recurringEventId: i.recurringEventId, meetingTitle: i.title, why }
    : { kind: 'meeting', eventKey: i.eventKey, meetingTitle: i.title, why };
}

type Policy = Record<string, unknown> & { seriesExclusions?: unknown; meetingExclusions?: unknown; updatedAt?: unknown };

/** The policy with the exclusion added, or null when it is already there (nothing to write). */
export function withExclusion(policy: Policy, exclusion: PolicyExclusion, at: string, actor: string): Policy | null {
  const createdBy = `${actor}: ${exclusion.why}`;
  if (exclusion.kind === 'series') {
    const list = Array.isArray(policy.seriesExclusions) ? policy.seriesExclusions as { recurringEventId?: string }[] : [];
    if (list.some(e => e.recurringEventId === exclusion.recurringEventId)) return null;
    return { ...policy, seriesExclusions: [...list, { createdAt: at, createdBy, meetingTitle: exclusion.meetingTitle, recurringEventId: exclusion.recurringEventId }], updatedAt: at };
  }
  const list = Array.isArray(policy.meetingExclusions) ? policy.meetingExclusions as { eventKey?: string }[] : [];
  if (list.some(e => e.eventKey === exclusion.eventKey)) return null;
  return { ...policy, meetingExclusions: [...list, { createdAt: at, createdBy, eventKey: exclusion.eventKey, meetingTitle: exclusion.meetingTitle }], updatedAt: at };
}

type Fetch = typeof fetch;
export type RecordOutcome = { kind: 'recorded' | 'already'; generation: string } | { kind: 'failed'; detail: string };

/** Adds the exclusion to gs://BUCKET/OBJECT with a generation-matched write, retrying a lost race a few times. */
export async function recordExclusion(bucket: string, object: string, token: string, exclusion: PolicyExclusion, at: string, actor: string, request: Fetch = fetch): Promise<RecordOutcome> {
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;
  const auth = { authorization: `Bearer ${token}` };
  for (let attempt = 0; attempt < 4; attempt++) {
    const meta = await request(base, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!meta.ok) return { kind: 'failed', detail: `policy metadata unreadable (${meta.status})` };
    const generation = String((await meta.json() as { generation?: string }).generation ?? '');
    const body = await request(`${base}?alt=media&generation=${generation}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!body.ok) return { kind: 'failed', detail: `policy unreadable (${body.status})` };
    const next = withExclusion(await body.json() as Policy, exclusion, at, actor);
    if (!next) return { kind: 'already', generation };
    const upload = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=${generation}`;
    const put = await request(upload, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: `${JSON.stringify(next, null, 2)}\n`, signal: AbortSignal.timeout(10_000) });
    if (put.ok) return { kind: 'recorded', generation: String((await put.json() as { generation?: string }).generation ?? '') };
    if (put.status !== 412) return { kind: 'failed', detail: `policy write refused (${put.status})` };
  }
  return { kind: 'failed', detail: 'the policy kept changing under the write' };
}
