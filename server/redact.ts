import type { KenanTool } from './types.js';

/** The credential formats that are never stored in a transcript or sent to a model. Each has a recognisable shape, so code, hashes and ids pass through. */
export type CredentialClass = 'private_key' | 'google_oauth_token' | 'jwt' | 'api_key' | 'bearer' | 'auth_header' | 'url_password' | 'json_secret' | 'env_secret' | 'config_secret';
/** A private key without its END line (cut-off output) ends at the first character base64 can't hold, never at the end of the record. */
/** `prefix` is kept (a header name, "Bearer "); `secret` is replaced. Quotes may be backslash-escaped: stored records hold tool output inside JSON strings. */
/** A value that looks generated rather than written: at least 20 token characters with a digit and a letter, so `req.headers.authorization` or `--user` pass. */
const TOKEN = String.raw`(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{20,}`;
/** A quoted or URL value that isn't a placeholder ($VAR, ${…}, <…>, [redacted…]) and has a digit and a letter. */
const VALUE = (chars: string, min: number) => String.raw`(?![$<{!\[])(?=${chars}*\d)(?=${chars}*[A-Za-z])${chars}{${min},}`;
/** Random, not composed: some run of 8+ letters and digits switches between them at least twice. Secret names, file paths and fixture1-token are written by hand. */
const switches = (run: string) => { let n = 0; for (let i = 1; i < run.length; i++) if (/\d/.test(run[i]!) !== /\d/.test(run[i - 1]!)) n++; return n; };
const random = (value: string) => value.split(/[^A-Za-z0-9]+/).some(run => run.length >= 8 && switches(run) >= 2);
const path = (value: string) => /^(?:~|\.{1,2})?\/[A-Za-z0-9._-]*\/?/.test(value) && /\/[a-z][a-z0-9_-]{2,}(?:\/|\.[a-z]{1,5}$)/.test(value);
const keyBody = (value: string) => value.replace(/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g, '').replace(/\\+[nr]/g, '').replace(/[^A-Za-z0-9+/=]/g, '').length >= 64;
const jwtHeader = (value: string) => { try { const header: unknown = JSON.parse(Buffer.from(value.slice(0, value.indexOf('.')), 'base64url').toString('utf8')); return typeof header === 'object' && header !== null && typeof (header as { alg?: unknown }).alg === 'string'; } catch { return false; } };
/** A vendor key stands alone: inside a run of base64 (an image, an encrypted blob) "sk-" or "ghp_" is a coincidence. */
const ALONE = String.raw`(?<![A-Za-z0-9+/_-])`, ENDS = String.raw`(?![A-Za-z0-9+/=_-])`;
const VENDOR = String.raw`(?:sk|rk)-(?:ant-|proj-|live-|test-|or-)?|gh[pousr]_|github_pat_|xox[abposr]-|glpat-|sntry[su]_`;
/** Hugging Face access tokens can be entirely alphabetic, so the generic digit-switch test misses them. */
const HF_TOKEN = String.raw`hf_[A-Za-z0-9]{34}(?:[A-Za-z0-9]{6})?`;
/** INI assignments have explicit secret names, including pgBackRest's repo1-cipher-pass and repo1-s3-key.
 * Match real and JSON-escaped line breaks, plus the first line of a quoted tool result. Unlike generic
 * token detection, these values need not look random: a password can be a short or spaced passphrase. */
const CONFIG_SPACE = String.raw`(?:[ \t]|\\t)*`;
const CONFIG_ASSIGNMENT = String.raw`(?:^|[\r\n]|\\n|(?<=["']))${CONFIG_SPACE}(?:[A-Za-z][A-Za-z0-9_.-]*[-_.])?(?:token|secret|password|passwd|pass|(?:api|access|private|crypto|secret|auth|signing|encryption|master|service|webhook)[-_.]?key|key)${CONFIG_SPACE}=${CONFIG_SPACE}`;
/** Password/passphrase fields are explicit even when their values are short. Generic key/token
 * assignments also occur in source (byte counts, sort keys), so require a generated value.
 * Named credential keys, such as repo1-s3-key or signing_key, keep literal protection. */
const configSecret = (secret: string, prefix: string) => {
  const value = secret.trim();
  if (!value || path(value)) return false;
  const name = prefix.match(/([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(?:\\*["'])?$/)?.[1] ?? '';
  return /(?:^|[-_.])(?:password|passwd|pass|secret|(?:api|access|private|crypto|secret|auth|signing|encryption|master|service|webhook|s3)[-_.]?key)$/i.test(name)
    || (new RegExp(`^${TOKEN}$`).test(value) && random(value));
};
const PATTERNS: readonly { kind: CredentialClass; pattern: RegExp; accept?: (secret: string, prefix: string) => boolean }[] = [
  { kind: 'private_key', pattern: /()(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[A-Za-z0-9+/=\s]|\\+[nr])*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?!(?:[A-Za-z0-9+/=\s]|\\+[nr]))))/g, accept: keyBody },
  { kind: 'google_oauth_token', pattern: /()(\bya29\.[0-9A-Za-z._~+/=-]{20,})/g },
  { kind: 'jwt', pattern: /()(\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, accept: jwtHeader },
  { kind: 'env_secret', pattern: new RegExp(String.raw`(\b(?:HF_TOKEN|HUGGING_FACE_HUB_TOKEN)\\*["']?\s*[:=]\s*\\*["']?)(${HF_TOKEN}${ENDS})`, 'g') },
  { kind: 'api_key', pattern: new RegExp(String.raw`()(${ALONE}${HF_TOKEN}${ENDS})`, 'g') },
  { kind: 'api_key', pattern: new RegExp(String.raw`()(${ALONE}(?:(?:${VENDOR})[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,})${ENDS})`, 'g'), accept: secret => /^GOCSPX-/.test(secret) || random(secret.replace(new RegExp(`^(?:${VENDOR})`), '')) },
  { kind: 'bearer', pattern: new RegExp(String.raw`(\b(?:bearer|basic)\s+)(${TOKEN})`, 'gi'), accept: secret => random(secret) && !path(secret) },
  { kind: 'auth_header', pattern: new RegExp(String.raw`(\b(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)\\*["']?\s*[:=]\s*\\*["']?)(?!(?:bearer|basic)\s)(${TOKEN})`, 'gi'), accept: secret => random(secret) && !path(secret) },
  { kind: 'url_password', pattern: new RegExp(String.raw`(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'\\]+:)(${VALUE(String.raw`[^\s@/"'\\]`, 12)})(?=@)`, 'gi') },
  { kind: 'json_secret', pattern: new RegExp(String.raw`(\\*["'](?:access_token|refresh_token|id_token|client_secret|private_key|api_key|apiKey|accessToken|refreshToken|idToken|clientSecret|privateKey|password|secret)\\*["']\s*:\s*\\*["'])(${VALUE(String.raw`[^"'\\\s]`, 16)})`, 'g'), accept: (secret, prefix) => /password/.test(prefix) || random(secret) },
  /** Environment-style names (`_SENTRY_AUTH_TOKEN": "…"`, `WEBHOOK_SECRET=…`), as in CI trigger substitutions and .env dumps, whatever the vendor format. */
  { kind: 'env_secret', pattern: new RegExp(String.raw`(\b[A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|(?:ACCESS|PRIVATE|CRYPTO|SECRET|AUTH|SIGNING|ENCRYPTION|MASTER|SERVICE|WEBHOOK)_KEY)\\*["']?\s*[:=]\s*\\*["']?)(${VALUE(String.raw`[^"'\\\s,;&()]`, 16)})(?![A-Za-z0-9_.$-]*\()`, 'g'), accept: secret => random(secret) && !path(secret) },
  // Structured formats must run first: an assignment must never consume only a PEM header.
  { kind: 'config_secret', pattern: new RegExp(`(${CONFIG_ASSIGNMENT})` + String.raw`(?![$<{!\["'\\])([^\s\\"';#][^\r\n\\"';#]*)`, 'gim'), accept: configSecret },
  { kind: 'config_secret', pattern: new RegExp(`(${CONFIG_ASSIGNMENT}` + String.raw`\\*["'])(?![$<{!\[])([^"'\\\r\n]+)`, 'gim'), accept: configSecret },
];
export type Found = Partial<Record<CredentialClass, number>>;
export interface Redacted { text: string; found: Found; count: number }
/**
 * `marker` replaces each secret with `[redacted:CLASS]`. `same-length` overwrites it with a marker cut or padded with `*`
 * to the secret's exact length, so a file can be redacted in place while another process appends to it. Replacements
 * contain no quotes or backslashes, so JSON stays valid either way.
 */
export function redactCredentials(text: string, mode: 'marker' | 'same-length' = 'marker'): Redacted {
  const found: Found = {};
  let count = 0;
  let out = text;
  for (const { kind, pattern, accept } of PATTERNS) {
    out = out.replace(pattern, (match: string, prefix: string, secret: string) => {
      if (accept && !accept(secret.replace(/^\\+|\\+$/g, ''), prefix)) return match;
      found[kind] = (found[kind] ?? 0) + 1; count++;
      const marker = `[redacted:${kind}]`;
      return prefix + (mode === 'marker' ? marker : marker.slice(0, secret.length).padEnd(secret.length, '*'));
    });
  }
  return { text: out, found, count };
}

/** Every string inside a value, redacted; other values unchanged. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactCredentials(value).text as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactDeep(child)])) as T;
  return value;
}
type Content = { type: string; text?: string };
const redactContent = <T extends { content?: Content[]; details?: unknown }>(result: T): T => result && typeof result === 'object' ? {
  ...result,
  ...(Array.isArray(result.content) ? { content: result.content.map(part => part.type === 'text' && typeof part.text === 'string' ? { ...part, text: redactCredentials(part.text).text } : part) } : {}),
  ...('details' in result ? { details: redactDeep(result.details) } : {}),
} : result;
/** A tool's output, streamed updates and error messages are redacted before Pi stores them or sends them to the model. */
export function redactedTool(tool: KenanTool): KenanTool {
  return {
    ...tool,
    execute: async (callId, params, signal, onUpdate, ctx) => {
      try {
        return redactContent(await tool.execute(callId, params, signal, onUpdate ? update => onUpdate(redactContent(update)) : onUpdate, ctx));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const { text, count } = redactCredentials(error.message);
        if (!count) throw error;
        throw Object.assign(new Error(text), { name: error.name });
      }
    },
  };
}
