// Host-local phone notifications through a durable host inbox under /var/lib/kenan/notify (see host-inbox.ts): the
// channel hosting the person's manager delivers each queued file like the agent notify tool, so an alert raised during
// a restart or deploy arrives late instead of never.
import type { PersonConfig } from './config.js';
import { saveFile } from './files/files.js';
import { startHostInboxes, type InboxOutcome } from './host-inbox.js';
import { notify } from './notifications.js';
import type { Deps } from './types.js';

type Image = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer };
type Parsed = { ok: true; value: { title: string; body: string; level: 'normal' | 'urgent'; image: Image | null } } | { ok: false; error: string };
const IMAGE_BYTES = 4 * 1024 * 1024;

export const NOTIFY_OUTBOX_ROOT = '/var/lib/kenan/notify';

export function parseNotification(raw: unknown): Parsed {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const { title, body, level, image } = r;
  if (typeof title !== 'string' || !title.trim() || title.length > 120) return { ok: false, error: 'title: 1–120 characters' };
  if (typeof body !== 'string' || !body.trim() || body.length > 2000) return { ok: false, error: 'body: 1–2000 characters' };
  if (level !== 'normal' && level !== 'urgent') return { ok: false, error: 'level: "normal" or "urgent"' };
  if (image === undefined) return { ok: true, value: { title, body, level, image: null } };
  const i = image as Record<string, unknown> | null;
  if (!i || typeof i !== 'object' || (i.mime !== 'image/jpeg' && i.mime !== 'image/png' && i.mime !== 'image/webp') || typeof i.base64 !== 'string') return { ok: false, error: 'image: {mime: image/jpeg|png|webp, base64}' };
  const bytes = Buffer.from(i.base64, 'base64');
  if (!bytes.length || bytes.length > IMAGE_BYTES) return { ok: false, error: 'image: 1 byte to 4 MiB' };
  return { ok: true, value: { title, body, level, image: { mime: i.mime, bytes } } };
}

async function deliver(deps: Deps, person: PersonConfig, raw: unknown): Promise<InboxOutcome> {
  const parsed = parseNotification(raw);
  if (!parsed.ok) return { kind: 'rejected', error: parsed.error };
  const manager = await deps.store.getAgent(`manager:${person.id}`);
  if (!manager) return { kind: 'held', error: `no manager agent for ${person.id}` };
  const { image, ...text } = parsed.value;
  const imageFileId = image ? (await saveFile(deps, person.id, `notification.${image.mime.slice(6)}`, image.mime, image.bytes)).id : null;
  await notify(deps, person.id, manager, { ...text, imageFileId });
  return { kind: 'taken' };
}

/** Delivers the outbox of each person whose manager runs on this channel; returns a closer. */
export const startNotifyOutboxes = (deps: Deps, root: string) => startHostInboxes(deps, root, 'notify_outbox', (person, raw) => deliver(deps, person, raw));
