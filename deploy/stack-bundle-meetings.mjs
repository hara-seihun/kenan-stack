// The same persisted discovery list and provider sessions used by meeting list/status; no Calendar/provider effects.
// live: a real meeting is in progress (scheduled now, or a notetaker not yet finished). Kenan's own #kenanvoice test
// meetings organised by person25@example.com never count (November 4, 2026: a synthetic load test held a deploy 30 minutes).
// kenanSpokeAt: when Kenan's own voice was last captioned in any meeting, for the deploy's brief speech drain.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
export const synthetic = d => String(d?.organizerEmail ?? d?.meeting?.organizerEmail ?? '').trim().toLowerCase() === 'person25@example.com'
  && /#kenanvoice/i.test(String(d?.title ?? ''));
export function liveMeetings(sessions, providers, now) {
  const time = v => typeof v === 'number' ? v : Date.parse(v);
  return sessions.some(d => !synthetic(d) && time(d.startAt) <= now && now < time(d.endAt)) ||
    providers.some(d => !synthetic(d) && !['ended', 'failed', 'rejected'].includes(d.phase) && !d.finishedAt);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  // Usage: stack-bundle-meetings.mjs [beta|production]; Beta when omitted (the intake's check).
  const channel = process.argv[2] ?? 'beta';
  if (channel !== 'beta' && channel !== 'production') throw new Error(`unknown channel ${channel}`);
  const pg = createRequire(`/srv/kenan/${channel}/package.json`)('pg');
  const config = JSON.parse(readFileSync(`/etc/kenan/${channel}.json`, 'utf8'));
  const db = new pg.Client({ connectionString: config.databaseUrl });
  try {
    await db.connect();
    const owners = config.people.filter(p => p.extensions.includes('meeting')).map(p => p.id);
    const sessions = await db.query(`SELECT data FROM kenan_meeting_sessions WHERE owner_id=ANY($1)`, [owners]);
    const providers = await db.query(`SELECT data FROM kenan_meeting_provider WHERE owner_id=ANY($1)`, [owners]);
    const spoke = await db.query(`SELECT max(created_at) AS at FROM message WHERE notice='meeting_caption' AND created_at > $1
      AND parts->0->'meetingCaption'->>'speaker'='Kenan'`, [Date.now() - 120_000]);
    const now = Date.now();
    console.log(JSON.stringify({ live: liveMeetings(sessions.rows.map(r => r.data), providers.rows.map(r => r.data), now), kenanSpokeAt: spoke.rows[0]?.at === null || spoke.rows[0]?.at === undefined ? null : Number(spoke.rows[0].at), now }));
  } finally { await db.end(); }
}
