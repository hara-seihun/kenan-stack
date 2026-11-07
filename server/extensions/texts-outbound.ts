// Outbound texts follow the configured provider and policy; no carrier is assumed.
import { readFile } from 'node:fs/promises';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T>(value: T) => ({ ok: true as const, value });
const err = <E>(error: E) => ({ ok: false as const, error });

/** media.telephone.outboundTexts: `{"kind":"forbidden","reason":"…"}`, or `{"kind":"textbelt","keyPath":"/…","footer":"…","replyLine":"+1…"}`.
 * A Textbelt text leaves from Textbelt's shared numbers, whose replies never reach us, so every text ends with `footer`,
 * which must name who it is from and give `replyLine` (Kenan's line, which receives) for replies. */
export type TelnyxOutbound = { kind: 'telnyx'; keyPath: string; fromNumber: string; messagingProfileId: string };
export type OutboundTexts = TelnyxOutbound | { kind: 'forbidden'; reason: string } | { kind: 'textbelt'; keyPath: string; footer: string; replyLine: string };
export type OutboundSetup = { kind: 'none' } | { kind: 'configured'; route: OutboundTexts };

const SHAPE = 'media.telephone.outboundTexts must be {"kind":"forbidden","reason":"…"} or {"kind":"textbelt","keyPath":"/…","footer":"…","replyLine":"+1…"} or {"kind":"telnyx","keyPath":"/…","fromNumber":"+1…","messagingProfileId":"…"}';
const digits = (s: string) => s.replace(/\D/g, '');
/** The footer gives the reply line when its digits appear in it, with or without the country code. */
const footerGivesLine = (footer: string, line: string) => digits(footer).includes(digits(line).replace(/^1(?=\d{10}$)/, ''));

export function outboundSetup(media: unknown): Result<OutboundSetup, string> {
  const telephone = (media as { telephone?: Record<string, unknown> } | null)?.telephone;
  if (!telephone || telephone.kind !== 'configured') return ok({ kind: 'none' });
  const o = telephone.outboundTexts as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return err(`${SHAPE}; it is unset`);
  const keys = Object.keys(o).sort().join(',');
  if (o.kind === 'forbidden' && keys === 'kind,reason' && typeof o.reason === 'string' && o.reason.trim()) return ok({ kind: 'configured', route: { kind: 'forbidden', reason: o.reason } });
  if (o.kind === 'textbelt' && keys === 'footer,keyPath,kind,replyLine' && typeof o.keyPath === 'string' && o.keyPath.startsWith('/')
    && typeof o.replyLine === 'string' && /^\+[1-9]\d{6,14}$/.test(o.replyLine) && typeof o.footer === 'string' && o.footer.trim()) {
    if (!footerGivesLine(o.footer, o.replyLine)) return err(`media.telephone.outboundTexts.footer must give the reply line ${o.replyLine}: replies to Textbelt's numbers never reach us`);
    return ok({ kind: 'configured', route: { kind: 'textbelt', keyPath: o.keyPath, footer: o.footer.trim(), replyLine: o.replyLine } });
  }
  if (o.kind === 'telnyx' && keys === 'fromNumber,keyPath,kind,messagingProfileId' && typeof o.keyPath === 'string' && o.keyPath.startsWith('/')
    && typeof o.fromNumber === 'string' && /^\+[1-9]\d{6,14}$/.test(o.fromNumber) && typeof o.messagingProfileId === 'string' && o.messagingProfileId.trim()) {
    return ok({ kind: 'configured', route: { kind: 'telnyx', keyPath: o.keyPath, fromNumber: o.fromNumber, messagingProfileId: o.messagingProfileId } });
  }
  return err(SHAPE);
}

export type Sent = { status: 'accepted'; provider: 'telnyx'; id: string; from: string; to: string; body: string } | { status: 'sent'; provider: 'textbelt'; id: string; to: string; body: string; quotaRemaining: number };
export type SendError =
  | { code: 'sms_outbound_not_permitted'; message: string }
  | { code: 'sms_provider_refused'; message: string }
  | { code: 'sms_provider_unreachable'; message: string }
  | { code: 'sms_provider_misconfigured'; message: string };

export type Fetch = (url: string, init: { method: 'POST'; body: URLSearchParams | string; headers?: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const TEXTBELT = 'https://textbelt.com/text';

export async function sendText(route: OutboundTexts, to: string, body: string, fetcher: Fetch): Promise<Result<Sent, SendError>> {
  switch (route.kind) {
    case 'forbidden': return err({ code: 'sms_outbound_not_permitted', message: route.reason });
    case 'telnyx': {
      const key = await readFile(route.keyPath, 'utf8').then(k => k.trim(), () => '');
      if (!key) return err({ code: 'sms_provider_misconfigured', message: `Telnyx API key at ${route.keyPath} unreadable or empty` });
      const answer = await fetcher('https://api.telnyx.com/v2/messages', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: route.fromNumber, to, text: body, messaging_profile_id: route.messagingProfileId, type: 'SMS' }),
        signal: AbortSignal.timeout(20_000),
      }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) as { data?: { id?: unknown }; errors?: { code?: string; title?: string; detail?: string }[] } | null }), () => null);
      if (!answer || answer.status >= 500 || answer.status === 408) return err({ code: 'sms_provider_unreachable', message: 'Telnyx did not confirm acceptance. The text may or may not have gone out; check Telnyx message records before resending.' });
      if (answer.status >= 200 && answer.status < 300 && typeof answer.json?.data?.id === 'string') return ok({ status: 'accepted', provider: 'telnyx', id: answer.json.data.id, from: route.fromNumber, to, body });
      if (answer.status >= 200 && answer.status < 300) return err({ code: 'sms_provider_unreachable', message: 'Telnyx accepted the request but returned no message ID. Check message records before resending.' });
      const detail = answer.json?.errors?.map(e => [e.code, e.title, e.detail].filter(Boolean).join(': ')).join('; ') || 'No error detail';
      return err({ code: 'sms_provider_refused', message: `Telnyx refused (HTTP ${answer.status}): ${detail}` });
    }
    case 'textbelt': {
      const key = await readFile(route.keyPath, 'utf8').then(k => k.trim(), (e: Error) => e);
      if (key instanceof Error || !key) return err({ code: 'sms_provider_misconfigured', message: `Textbelt key at ${route.keyPath} unreadable${key instanceof Error ? `: ${key.message}` : ': empty'}` });
      const message = withFooter(body, route.footer);
      const answer = await fetcher(TEXTBELT, { method: 'POST', body: new URLSearchParams({ phone: to, message, key }), signal: AbortSignal.timeout(20_000) })
        .then(async r => ({ status: r.status, json: await r.json().catch(() => null) as Record<string, unknown> | null }), (e: Error) => e);
      if (answer instanceof Error) return err({ code: 'sms_provider_unreachable', message: `Textbelt did not answer: ${answer.message}. The text may or may not have gone out; check before resending.` });
      const j = answer.json;
      if (j?.success === true && (typeof j.textId === 'string' || typeof j.textId === 'number')) return ok({ status: 'sent', provider: 'textbelt', id: String(j.textId), to, body: message, quotaRemaining: Number(j.quotaRemaining) });
      return err({ code: 'sms_provider_refused', message: `Textbelt refused (HTTP ${answer.status}): ${typeof j?.error === 'string' ? j.error : JSON.stringify(j)}` });
    }
  }
}

/** The body as sent: the footer is added once at the end, unless the body already ends with it. */
export const withFooter = (body: string, footer: string) => body.trimEnd().endsWith(footer) ? body.trimEnd() : `${body.trimEnd()}\n${footer}`;
