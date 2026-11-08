// Host events through a durable host inbox under /var/lib/kenan/events (see host-inbox.ts). A file is
// {"topic": "acme:<agent id>", "id": "<idempotency key>", "body": <any JSON>}, written by kenan-event or a relay.
// The channel hosting the person's manager records it in host_event (a repeated id is taken without a second row)
// and checks wakes at once; `on: event` wakes on a matching topic fire with its body.
import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedManager, type PersonConfig } from './config.js';
import { startHostInboxes, startInboxPlaces, storable, type InboxOutcome } from './host-inbox.js';
import { toSiblings, type LinkResult } from './channels/link.js';
import { HOST_EVENT_RETENTION_MS, TOPIC } from './agents/wakes.js';
import type { Deps } from './types.js';

export const EVENT_INBOX_ROOT = '/var/lib/kenan/events';
const BODY_BYTES = 256 * 1024;
const PRUNE_MS = 3600_000;
const recordedCallbacks = new WeakMap<Deps['store'], () => void>();

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
  return { ok: true, value: { topic, id, body: storable(body) } };
}

async function record(deps: Deps, person: PersonConfig, raw: unknown, recorded: () => void): Promise<InboxOutcome> {
  const parsed = parseHostEvent(raw);
  if (!parsed.ok) return { kind: 'rejected', error: parsed.error };
  if (await deps.store.recordHostEvent({ ownerId: person.id, ...parsed.value })) recorded();
  return { kind: 'taken' };
}

/** Records a linked host event only on the channel hosting the person's manager. */
export async function receiveLinkedEvent(deps: Deps, personId: unknown, raw: unknown): Promise<LinkResult<null>> {
  const person = typeof personId === 'string' ? deps.person(personId) : undefined;
  if (!person || !deps.runtime.managerFor(person.id)) return { ok: false, error: 'not_here: host event owner' };
  const parsed = parseHostEvent(raw);
  if (!parsed.ok) return { ok: false, error: `event_invalid: ${parsed.error}` };
  if (await deps.store.recordHostEvent({ ownerId: person.id, ...parsed.value })) recordedCallbacks.get(deps.store)?.();
  return { ok: true, value: null };
}

/** Records the events of each person whose manager runs on this channel; `recorded` runs after each new event. */
export async function startEventInboxes(deps: Deps, root: string, recorded: () => void): Promise<() => void> {
  const prune = () => deps.store.pruneHostEvents(deps.now() - HOST_EVENT_RETENTION_MS).catch(e => deps.store.logError('event_inbox', `prune: ${String(e)}`));
  await prune();
  const timer = setInterval(prune, PRUNE_MS);
  recordedCallbacks.set(deps.store, recorded);
  // Configure forwardEvents on ONE old-host app only. Two drainers can race over the same files.
  // Each named person must remain in this host's config with their original uid and gid.
  try {
    const forwardIds = deps.config.link?.forwardEvents ?? [];
    const places = [...new Set(forwardIds)].map(id => {
      const person = deps.config.people.find(p => p.id === id);
      if (!person) throw new Error(`event_inbox: forwardEvents person ${id} is not configured`);
      if (hostedManager(person)) throw new Error(`event_inbox: forwardEvents person ${id} is hosted here`);
      return { person, name: person.id, uid: person.uid, gid: person.gid };
    });
    const stop = await startHostInboxes(deps, root, 'event_inbox', (person, raw) => record(deps, person, raw, recorded));
    try {
      const stopForward = await startInboxPlaces(deps, root, 'event_forward', places, async (person, raw) => {
        const parsed = parseHostEvent(raw);
        if (!parsed.ok) return { kind: 'rejected', error: parsed.error };
        const result = await toSiblings<null>(deps, '/host-event', { personId: person.id, event: raw });
        return result.ok ? { kind: 'taken' } : { kind: 'held', error: result.error };
      });
      return () => { clearInterval(timer); stop(); stopForward(); if (recordedCallbacks.get(deps.store) === recorded) recordedCallbacks.delete(deps.store); };
    } catch (e) { stop(); throw e; }
  } catch (e) { clearInterval(timer); if (recordedCallbacks.get(deps.store) === recorded) recordedCallbacks.delete(deps.store); throw e; }
}

/** Queues an event from this process as kenan-event does, so the channel hosting the person's manager records it
 *  wherever that channel runs. */
export async function queueHostEvent(root: string, personId: string, event: { topic: string; id: string; body: unknown }): Promise<void> {
  const parsed = parseHostEvent(event);
  if (!parsed.ok) throw new Error(`event_invalid: ${parsed.error}`);
  const dir = join(root, personId), name = `${process.hrtime.bigint()}-${randomUUID()}`;
  await writeFile(join(dir, `.${name}`), JSON.stringify(parsed.value), { mode: 0o600 });
  await rename(join(dir, `.${name}`), join(dir, `${name}.json`));
}
