/**
 * Meeting notes and transcripts for the people who were in the meeting (Taylor Taylor, November 4, 2026: everyone at
 * ACME can use Kenan in their meetings, and notes and transcripts are shareable with the people in each meeting).
 *
 * Anyone signed in to kenan.acme.example with a acme.example Google account sees the meetings Kenan took notes in where
 * their verified address was the organizer or an attendee who didn't decline, and nothing else. Each person also
 * chooses whether Kenan joins their meetings (the attendance policy's opt-in list) or never joins meetings with them
 * (its person exclusions).
 */
export type SharedAttendee = { email: string; responseStatus?: string | null };
export type SharedMeeting = { organizerEmail?: string | null; attendees?: readonly SharedAttendee[] | null };

const norm = (email: string) => email.trim().toLowerCase();
export const isACMEAddress = (email: string): boolean => /^[^@\s]+@acme.example$/u.test(norm(email));

/**
 * The verified acme.example address a signed-in person stands for. Google sign-in names each new person by their
 * verified lower-cased address; the meetings' owner (Alice, whose own account carries no address) is the first address
 * on the policy's explicit inclusion list. Anyone else has none and sees no meetings.
 */
export function personAddress(person: { name: string; extensions: readonly string[] }, ownerEmails: readonly string[]): string | null {
  if (isACMEAddress(person.name)) return norm(person.name);
  const owner = ownerEmails.find(isACMEAddress);
  return person.extensions.includes('meeting') && owner ? norm(owner) : null;
}

/** Whether this address was in the meeting: its organizer, or an attendee who didn't decline. */
export function attended(email: string, meeting: SharedMeeting): boolean {
  const e = norm(email);
  if (meeting.organizerEmail && norm(meeting.organizerEmail) === e) return true;
  return (meeting.attendees ?? []).some(a => norm(a.email) === e && a.responseStatus !== 'declined');
}

/**
 * What an attendee may read: the owner's private names become her work name, and the notetaker's local file path
 * (meaningless outside the host) is dropped.
 */
export function shareable(text: string, privateNames: readonly string[], ownerName: string): string {
  let out = text.replace(/\n*The notetaker was in the call [^\n]*Transcript \(\d+ lines\): \S+\s*$/u, '').replace(/\nTranscript \(\d+ lines\): \/\S+/gu, '');
  for (const name of privateNames) {
    if (!name.trim()) continue;
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'giu'), ownerName);
  }
  return out;
}

export type AttendancePreference = 'join' | 'default' | 'never';
type Exclusion = { email?: unknown; createdAt?: unknown; createdBy?: unknown; displayName?: unknown };
type Policy = Record<string, unknown> & {
  uninvitedIncludedEmails?: unknown; personExclusions?: unknown; uninvitedPersonExclusions?: unknown; uninvitedIncludedEmailSources?: unknown;
};

const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const emailOf = (x: unknown) => typeof x === 'string' ? norm(x) : x && typeof x === 'object' && typeof (x as Exclusion).email === 'string' ? norm((x as Exclusion).email as string) : null;

/** A person's own current choice, read from the policy. */
export function preferenceOf(policy: Policy, email: string): AttendancePreference {
  const e = norm(email);
  if (list(policy.personExclusions).some(x => emailOf(x) === e)) return 'never';
  if (list(policy.uninvitedIncludedEmails).some(x => emailOf(x) === e)) return 'join';
  return 'default';
}

/**
 * The policy with this person's own choice applied, or null when nothing changes. Only their own entries are touched:
 * join puts them on the opt-in list and lifts their own stops (their later choice supersedes them); never adds their
 * person exclusion and takes them off the opt-in list; default takes them off both, keeping a request for no
 * uninvited joins.
 */
export function withPreference(policy: Policy, email: string, choice: AttendancePreference, at: string, actor: string): Policy | null {
  const e = norm(email);
  if (!isACMEAddress(e)) throw new Error('Only acme.example addresses can set a meeting preference');
  const included = list(policy.uninvitedIncludedEmails).filter(x => emailOf(x) !== e);
  const excluded = list(policy.personExclusions).filter(x => emailOf(x) !== e);
  const uninvited = list(policy.uninvitedPersonExclusions).filter(x => emailOf(x) !== e);
  const sources = list(policy.uninvitedIncludedEmailSources).filter(x => emailOf(x) !== e);
  const next: Policy = { ...policy, updatedAt: at };
  if (choice === 'join') {
    next.uninvitedIncludedEmails = [...included, e];
    next.uninvitedIncludedEmailSources = [...sources, { email: e, createdAt: at, createdBy: actor, source: 'their own choice on kenan.acme.example' }];
    next.personExclusions = excluded;
    next.uninvitedPersonExclusions = uninvited;
  } else if (choice === 'never') {
    next.uninvitedIncludedEmails = included;
    next.uninvitedIncludedEmailSources = sources;
    next.personExclusions = [...excluded, { createdAt: at, createdBy: actor, displayName: null, email: e }];
  } else {
    next.uninvitedIncludedEmails = included;
    next.uninvitedIncludedEmailSources = sources;
    next.personExclusions = excluded;
  }
  if (policy.uninvitedPersonExclusions === undefined && list(next.uninvitedPersonExclusions).length === 0) delete next.uninvitedPersonExclusions;
  if (policy.uninvitedIncludedEmailSources === undefined && list(next.uninvitedIncludedEmailSources).length === 0) delete next.uninvitedIncludedEmailSources;
  return preferenceOf(policy, e) === choice && (choice !== 'join' || !list(policy.uninvitedPersonExclusions).some(x => emailOf(x) === e)) ? null : next;
}

export type PreferenceOutcome = { kind: 'recorded' | 'already'; preference: AttendancePreference } | { kind: 'failed'; detail: string };
/** Reads gs://BUCKET/OBJECT and writes this person's choice with a generation-matched write, retrying a lost race. */
export async function recordPreference(bucket: string, object: string, token: string, email: string, choice: AttendancePreference, at: string, actor: string, request: typeof fetch = fetch): Promise<PreferenceOutcome> {
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;
  const auth = { authorization: `Bearer ${token}` };
  for (let attempt = 0; attempt < 4; attempt++) {
    const meta = await request(base, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!meta.ok) return { kind: 'failed', detail: `policy metadata unreadable (${meta.status})` };
    const generation = String((await meta.json() as { generation?: string }).generation ?? '');
    const body = await request(`${base}?alt=media&generation=${generation}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!body.ok) return { kind: 'failed', detail: `policy unreadable (${body.status})` };
    const next = withPreference(await body.json() as Policy, email, choice, at, actor);
    if (!next) return { kind: 'already', preference: choice };
    const upload = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=${generation}`;
    const put = await request(upload, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: `${JSON.stringify(next, null, 2)}\n`, signal: AbortSignal.timeout(10_000) });
    if (put.ok) return { kind: 'recorded', preference: choice };
    if (put.status !== 412) return { kind: 'failed', detail: `policy write refused (${put.status})` };
  }
  return { kind: 'failed', detail: 'the policy kept changing under the write' };
}

/**
 * https://kenan.acme.example/pi-stack/api/ext/meeting/shared/page (SHARED_MEETINGS_URL): the signed-in person's meetings (notes, transcript on request) and
 * their choice whether Kenan joins their meetings. Everything shown is set with textContent, never as HTML.
 */
export const SHARED_MEETINGS_URL = 'https://kenan.acme.example/pi-stack/api/ext/meeting/shared/page';
export function renderSharedMeetingsPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Your meetings with Kenan</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:820px;margin:0 auto;padding:16px;color:#111}h1{font-size:1.5em}fieldset{border:1px solid #ccc;border-radius:8px;margin:16px 0}label{display:block;margin:4px 0}section{border-top:1px solid #ddd;padding:12px 0}pre{white-space:pre-wrap;font:inherit;margin:0}.muted{color:#666}button{font:inherit}#status{min-height:1.5em}</style></head>
<body><h1>Your meetings with Kenan</h1><p class="muted" id="who"></p>
<fieldset><legend>Should Kenan join your meetings?</legend>
<label><input type="radio" name="pref" value="join"> Yes: take notes in my meetings, including my one-on-ones (internal meetings only; anyone can still say "Kenan, leave").</label>
<label><input type="radio" name="pref" value="default"> Only when someone invites person25@example.com or another attendee asked for Kenan.</label>
<label><input type="radio" name="pref" value="never"> Never join a meeting I am in.</label>
<p id="status" role="status"></p></fieldset>
<h2>Meetings you were in</h2><p class="muted">Notes from meetings Kenan attended where you were the organizer or an attendee. Only the people in each meeting can see it.</p><div id="list"><p>Loading…</p></div>
<script>
const base=location.pathname.replace(/\\/shared\\/page\\/?$/,'');
const api=async(path,init)=>{const r=await fetch(base+path,{credentials:'same-origin',...init});const j=await r.json().catch(()=>null);if(!r.ok||!j||!j.ok)throw new Error(j&&j.error&&j.error.message||('HTTP '+r.status));return j.value;};
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const status=document.getElementById('status');
async function load(){
  const v=await api('/shared');
  document.getElementById('who').textContent=v.email?('Signed in as '+v.email+'.'):'This account has no acme.example address, so it has no meetings here.';
  for(const r of document.querySelectorAll('input[name=pref]')){r.checked=r.value===v.preference;r.disabled=!v.email;r.onchange=async()=>{status.textContent='Saving…';try{await api('/shared/preference',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({preference:r.value})});status.textContent='Saved. It applies from the next calendar check (within a minute).';}catch(e){status.textContent='Not saved: '+e.message;}};}
  const list=document.getElementById('list');list.replaceChildren();
  if(!v.meetings.length){list.append(el('p','No meetings yet.','muted'));return;}
  for(const m of v.meetings){
    const s=el('section');s.append(el('h3',m.title));s.append(el('p',(m.startAt?new Date(m.startAt).toLocaleString():'')+(m.organizerEmail?' · organized by '+m.organizerEmail:''),'muted'));
    s.append(el('pre',m.notes.replace(/^Meeting notes: [^\\n]*\\n+/,'')));
    const b=el('button','Show transcript');const t=el('pre',null);
    b.onclick=async()=>{b.disabled=true;try{const d=await api('/shared/'+encodeURIComponent(m.sessionId));t.textContent=d.transcript||'No transcript was kept for this meeting.';b.remove();}catch(e){t.textContent='Could not load it: '+e.message;b.disabled=false;}};
    s.append(b,t);list.append(s);
  }
}
load().catch(e=>{document.getElementById('list').textContent='Could not load your meetings: '+e.message;});
</script></body></html>`;
}
