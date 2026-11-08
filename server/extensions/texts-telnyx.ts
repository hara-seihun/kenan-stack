// Telnyx v2 messaging webhooks: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bodyLimit } from 'hono/body-limit';
import type { Extension } from '../types.js';
import { receive } from '../channels/inbound.js';
import { LINE_TEXT_INBOX_ROOT, KENAN_LINE, personLine, receiveLineText, lineItem, tellManager, type TelnyxLine } from './texts-line.js';
import type { LineText, Unstored } from './texts.js';

/** Signatures cover timestamp + '|' + the exact request bytes, not reserialized JSON. */
export function verifyTelnyx(raw: Buffer, signature: string | undefined, timestamp: string | undefined, publicKey: string, now: number): boolean {
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = Buffer.from(publicKey.trim(), 'base64');
    const sig = Buffer.from(signature, 'base64');
    if (key.length !== 32 || sig.length !== 64) return false;
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), spki, sig);
  } catch { return false; }
}

type Received = Unstored<Extract<LineText, { direction: 'received' }>>;
export function telnyxReceived(raw: unknown, config: TelnyxLine): Received | null {
  const d = (raw as { data?: Record<string, any> } | null)?.data;
  if (d?.event_type !== 'message.received') return null;
  const p = d.payload;
  if (!p || p.direction !== 'inbound' || p.messaging_profile_id !== config.messagingProfileId || !Array.isArray(p.to) || !p.to.some((t: any) => t?.phone_number === config.line)) throw new Error('Message does not match the configured Telnyx line and messaging profile');
  const at = Date.parse(p.received_at ?? d.occurred_at);
  if (typeof p.id !== 'string' || !p.id || typeof p.from?.phone_number !== 'string' || !/^\+?\d{2,15}$/.test(p.from.phone_number) || !Number.isFinite(at)
    || (p.text !== null && p.text !== undefined && typeof p.text !== 'string') || !Array.isArray(p.media) || p.media.some((m: any) => typeof m?.url !== 'string' || !/^https:\/\//.test(m.url))) throw new Error('Invalid Telnyx message fields');
  return { id: `telnyx:${p.id}`, source: 'line', line: config.line, direction: 'received', from: p.from.phone_number, body: p.text ?? '', media: p.media.map((m: any) => m.url), at };
}

export const telnyxHooks: NonNullable<Extension['hooks']> = (app, deps) => {
  app.use('/telnyx/*', bodyLimit({ maxSize: 256 * 1024 }));
  app.post('/telnyx/:person', async c => {
    const person = deps.person(c.req.param('person'));
    if (!person || !person.extensions.includes('texts') || (person.manager && 'elsewhere' in person.manager)) return c.json({ error: 'line_not_here' }, 404);
    const setup = personLine(person, deps.config.channel);
    if (!setup.ok) return c.json({ error: 'line_misconfigured' }, 503);
    if (setup.value.kind !== 'here' || setup.value.config.kind !== 'telnyx') return c.json({ error: 'telnyx_not_active_here' }, 404);
    const config = setup.value.config;
    const key = await readFile(config.publicKeyPath, 'utf8').catch(() => null);
    if (!key) return c.json({ error: 'public_key_unavailable' }, 503);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!verifyTelnyx(raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'), key, deps.now())) return c.json({ error: 'invalid_signature' }, 401);
    let event: any, text: Received | null;
    try { event = JSON.parse(raw.toString('utf8')); text = telnyxReceived(event, config); }
    catch { return c.json({ error: 'invalid_message' }, 400); }
    if (text) {
      const kept = await receiveLineText(deps, person, text, LINE_TEXT_INBOX_ROOT);
      if (kept.kind === 'kept' && kept.fresh) await receive(deps, person, [lineItem(text, KENAN_LINE, null)]);
    } else if (event?.data?.event_type === 'message.finalized') {
      const p = event.data.payload;
      if (p?.from?.phone_number === config.line && p.messaging_profile_id === config.messagingProfileId && Array.isArray(p.to)) {
        const failed = p.to.filter((t: any) => ['sending_failed', 'delivery_failed'].includes(t?.status));
        if (failed.length) await tellManager(deps, person, `telnyx:${p.id}`, `Telnyx reports text ${p.id} failed for ${failed.map((t: any) => t.phone_number).join(', ')}. Check its message record before resending.`);
      }
    }
    return c.json({ ok: true });
  });
};
