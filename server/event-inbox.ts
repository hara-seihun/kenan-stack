// Host events through a durable host inbox under /var/lib/kenan/events (see host-inbox.ts). A file is
// {"topic": "acme:<agent id>", "id": "<idempotency key>", "body": <any JSON>}, written by kenan-event or a relay.
// The channel hosting the person's manager records it in host_event (a repeated id is taken without a second row)
// and checks wakes at once; `on: event` wakes on a matching topic fire with its body.
import type { PersonConfig } from './config.js';
import { startHostInboxes, type InboxOutcome } from './host-inbox.js';
import { HOST_EVENT_RETENTION_MS, TOPIC } from './agents/wakes.js';
import type { Deps } from './types.js';

export const EVENT_INBOX_ROOT = '/var/lib/kenan/events';
const BODY_BYTES = 256 * 1024;
const PRUNE_MS = 3600_000;

type Parsed = { ok: true; value: { topic: string; id: string; body: unknown } } | { ok: false; error: string };

export function parseHostEvent(raw: unknown): Parsed {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'file must be a JSON object {topic, id, body}' };
  const extra = Object.keys(r).filter(k => k !== 'topic' && k !== 'id' && k !== 'body');
  if (extra.length) return { ok: false, error: `unknown fields: ${extra.join(', ')}` };
  const { topic, id, body } = r;
  if (typeof topic !== 'string' || !TOPIC.test(topic)) return { ok: false, error: 'topic: 1–200 of A–Z a–z 0–9 . _ : @ / -' };
  if (typeof id !== 'string' || !id || id.length > 200) return { ok: false, error: 'id: 1–200 characters' };
  if (body === undefined) return { ok: false, error: 'body: required (any JSON value)' };
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_BYTES) return { ok: false, error: 'body: at most 256 KiB of JSON' };
  return { ok: true, value: { topic, id, body } };
}

async function record(deps: Deps, person: PersonConfig, raw: unknown, recorded: () => void): Promise<InboxOutcome> {
  const parsed = parseHostEvent(raw);
  if (!parsed.ok) return { kind: 'rejected', error: parsed.error };
  if (await deps.store.recordHostEvent({ ownerId: person.id, ...parsed.value })) recorded();
  return { kind: 'taken' };
}

/** Records the events of each person whose manager runs on this channel; `recorded` runs after each new event. */
export async function startEventInboxes(deps: Deps, root: string, recorded: () => void): Promise<() => void> {
  const prune = () => deps.store.pruneHostEvents(deps.now() - HOST_EVENT_RETENTION_MS).catch(e => deps.store.logError('event_inbox', `prune: ${String(e)}`));
  await prune();
  const timer = setInterval(prune, PRUNE_MS);
  const stop = await startHostInboxes(deps, root, 'event_inbox', (person, raw) => record(deps, person, raw, recorded));
  return () => { clearInterval(timer); stop(); };
}
