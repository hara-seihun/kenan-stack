/**
 * Redacts secrets people paste into Slack before an observation is persisted. Same rule as deploy/slack-redact.py:
 * Google 2-Step Verification backup-code lists (8-digit codes, 12345678 or 1234 5678), at least five codes, or at
 * least two next to backup/verification/2SV/2FA/recovery wording. Slack timestamps and longer numbers never match.
 */
const BACKUP_CODE = /(?<![\d.])\d{4} ?\d{4}(?![\d.])/g;
const CONTEXT = /backup|verification|\b2sv\b|\b2fa\b|recovery|one[- ]time/i;
export const BACKUP_CODE_MIN = 5;
export const REDACTED = '[redacted backup code]';

export function redactText(text: string): string {
  const codes = text.match(BACKUP_CODE)?.length ?? 0;
  return codes >= BACKUP_CODE_MIN || (codes >= 2 && CONTEXT.test(text)) ? text.replace(BACKUP_CODE, REDACTED) : text;
}
/** A copy of a JSON-like value with every string redacted; the input is left as it was. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v)])) as T;
  return value;
}
