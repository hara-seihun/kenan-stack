// Google sign-in for the public entrance (kenan.acme.example/pi-stack/): every check that decides who a browser is.
// Alice, 2026-11-04: everyone with an @acme.example Google Workspace account may sign in. The authorization request
// sends hd=acme.example, but that only selects the account chooser; the server trusts nothing but the signed ID token:
// its RS256 signature against Google's published keys, iss, aud/azp, nonce, lifetime, email_verified === true, the hd
// claim exactly the company domain (a consumer Google account registered with an @acme.example address has no hd), and
// the email itself in that domain. This module has no imports beyond node:crypto so the entrance runs without node_modules.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Google issues ID tokens with either form of its issuer (https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken). */
export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];
/** Clock skew tolerated for iat and nbf, in seconds. */
const SKEW_S = 60;

export interface GoogleClient { clientId: string; hostedDomain: string }
export type Refusal = { ok: false; code: 'unauthenticated' | 'forbidden'; message: string };
export type Checked<T> = { ok: true; value: T } | Refusal;
/** A verified Google Workspace identity: the stable Google account id (sub) and its lower-cased email. */
export interface GoogleIdentity { subject: string; email: string; hostedDomain: string }

const refuse = (code: Refusal['code'], message: string): Refusal => ({ ok: false, code, message });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const B64URL = /^[A-Za-z0-9_-]+$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The company email's domain, or null when the address is not exactly one non-empty local part @ one domain. */
export function emailDomain(email: string): string | null {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(email)) return null;
  return parts[1];
}

/** PKCE, state and nonce for one sign-in, plus the Google authorization URL that asks only for the company domain. */
export function startGoogleSignIn(client: GoogleClient, redirectUri: string): { url: string; state: string; nonce: string; verifier: string } {
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
    state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    hd: client.hostedDomain, prompt: 'select_account',
  }).toString();
  return { url: url.href, state, nonce, verifier };
}

/**
 * Verifies a Google ID token completely. `keys` is Google's JWKS document; `nowMs` the current time.
 * Returns unauthenticated for anything that is not a genuine, current token minted for this client and this sign-in,
 * and forbidden for a genuine Google identity that is not a verified account of the company Workspace domain.
 */
export function verifyGoogleIdToken(token: string, keys: unknown, client: GoogleClient, nonce: string, nowMs: number): Checked<GoogleIdentity> {
  if (!DOMAIN.test(client.hostedDomain) || !client.clientId) return refuse('unauthenticated', 'Sign-in is not configured');
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !B64URL.test(p))) return refuse('unauthenticated', 'Invalid identity token');
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!isRecord(header) || !isRecord(claims) || header.alg !== 'RS256' || typeof header.kid !== 'string') return refuse('unauthenticated', 'Invalid identity token');
    if (!isRecord(keys) || !Array.isArray(keys.keys)) return refuse('unauthenticated', 'Identity keys unavailable');
    const matches = keys.keys.filter((k: unknown) => isRecord(k) && k.kid === header.kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === 'RS256'));
    if (matches.length !== 1) return refuse('unauthenticated', 'Identity signing key not found');
    const key = createPublicKey({ key: matches[0], format: 'jwk' } as Parameters<typeof createPublicKey>[0]);
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) return refuse('unauthenticated', 'Identity signature rejected');

    const now = nowMs / 1000;
    if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) return refuse('unauthenticated', 'Identity issuer rejected');
    const audience = claims.aud === client.clientId || (Array.isArray(claims.aud) && claims.aud.includes(client.clientId) && claims.azp === client.clientId);
    if (!audience || (claims.azp !== undefined && claims.azp !== client.clientId)) return refuse('unauthenticated', 'Identity audience rejected');
    if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) return refuse('unauthenticated', 'Identity nonce rejected');
    if (typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + SKEW_S
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + SKEW_S))) return refuse('unauthenticated', 'Identity token expired or not yet valid');
    if (typeof claims.sub !== 'string' || !/^[0-9]{1,64}$/.test(claims.sub)) return refuse('unauthenticated', 'Identity subject rejected');

    // Below this line the token is genuine; what remains is whether this Google account is a verified company account.
    if (claims.email_verified !== true) return refuse('forbidden', 'Your Google email address is not verified');
    if (typeof claims.hd !== 'string' || claims.hd !== client.hostedDomain) return refuse('forbidden', `Sign in with your @${client.hostedDomain} Google Workspace account`);
    if (typeof claims.email !== 'string') return refuse('forbidden', `Sign in with your @${client.hostedDomain} Google Workspace account`);
    const email = claims.email.toLowerCase();
    if (emailDomain(email) !== client.hostedDomain) return refuse('forbidden', `Sign in with your @${client.hostedDomain} Google Workspace account`);
    return { ok: true, value: { subject: claims.sub, email, hostedDomain: claims.hd } };
  } catch {
    return refuse('unauthenticated', 'Identity token could not be verified');
  }
}

/** Who a verified identity is here: the administrator (both the Google account id and email match), or an employee. */
export type Role = { kind: 'administrator' } | { kind: 'employee' } | Refusal;
export function classify(identity: GoogleIdentity, administrator: { googleSubject: string; email: string }): Role {
  const subject = identity.subject === administrator.googleSubject, email = identity.email === administrator.email.toLowerCase();
  if (subject && email) return { kind: 'administrator' };
  // A half match (Alice's address on another Google account, or her account with a changed address) is never an
  // employee account either: it would put her email on someone else's workspace.
  if (subject || email) return refuse('forbidden', 'This Google account does not match its registered company identity');
  return { kind: 'employee' };
}
