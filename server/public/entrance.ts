// The public door at https://kenan.acme.example/pi-stack/ (Caddy strips the /pi-stack prefix and proxies to loopback 8788).
// It signs a browser in with Google (google-identity.ts), turns the verified identity into a native Kenan session for that
// person's account, and proxies the app's /api to the Beta channel. Alice's account is the administrator; every other
// verified @acme.example Workspace account gets its own account from the root enrollment service on first sign-in.
// Replaces the Auth0 entrance carried over from pi-stack-next (adapt-ingress.py): Auth0's ID token has no hd claim,
// so it could not tell a Workspace account from a consumer Google account that uses an @acme.example address.
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { classify, GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL, startGoogleSignIn, verifyGoogleIdToken, type GoogleIdentity } from './google-identity.js';

export interface EntranceConfig {
  publicUrl: string;
  upstream: string;
  webRoot: string;
  google: { clientId: string; clientSecret: string; hostedDomain: string };
  administrator: { googleSubject: string; email: string; accountId: string; accountSecret: string };
}
export interface Account { accountId: string; accountSecret: string }
/** Root enrollment: the verified identity in, that person's account out (created on first sign-in). */
export type ResolveAccount = (identity: GoogleIdentity) => Promise<Account>;
type Fetcher = typeof fetch;

const STATE_COOKIE = 'kenan_google_state';
const SESSION_COOKIE = 'kenan_session';
const PENDING_MAX = 1000, PENDING_MS = 300_000, KEYS_MS = 3_600_000;

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function cookieValue(header: string | undefined, name: string): string | null {
  const values = (header ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}

export function assertEntranceConfig(config: EntranceConfig): void {
  const publicUrl = new URL(config.publicUrl), upstream = new URL(config.upstream);
  const bad = publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/pi-stack/' || publicUrl.search || publicUrl.hash
    // The root-owned entrance configuration selects the upstream host, not the source tree.
    || upstream.protocol !== 'http:' || upstream.port !== '18190' || upstream.username || upstream.password
    || upstream.pathname !== '/' || upstream.search || upstream.hash
    || !config.webRoot.startsWith('/') || !isRecord(config.google) || !/\.apps\.googleusercontent\.com$/.test(config.google.clientId)
    || typeof config.google.clientSecret !== 'string' || config.google.clientSecret.length < 16 || config.google.hostedDomain !== 'acme.example'
    || !isRecord(config.administrator) || !/^[0-9]{1,64}$/.test(config.administrator.googleSubject) || emailOf(config.administrator.email) === null
    || typeof config.administrator.accountId !== 'string' || typeof config.administrator.accountSecret !== 'string' || config.administrator.accountSecret.length < 24;
  if (bad) throw new Error('Invalid public entrance configuration');
}
const emailOf = (email: unknown) => typeof email === 'string' && /^[^@\s]+@acme.example$/i.test(email) ? email.toLowerCase() : null;

export function createEntrance(config: EntranceConfig, resolveAccount: ResolveAccount, fetcher: Fetcher = fetch, now: () => number = Date.now): Server {
  assertEntranceConfig(config);
  const publicUrl = new URL(config.publicUrl), upstream = new URL(config.upstream);
  const base = publicUrl.pathname, callback = config.publicUrl + 'v1/auth/callback';
  const pending = new Map<string, { nonce: string; verifier: string; expires: number }>();
  let keys: { value: unknown; at: number } | null = null;
  const stateCookie = (state: string, age: number) => `${STATE_COOKIE}=${state}; Path=${base}; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  // The browser returns from a cross-site Google document: Strict would drop the session on the callback's redirect.
  const nativeCookie = (value: string) => value.replace(/Path=\//i, `Path=${base}`).replace(/;\s*SameSite=[^;]*/ig, '').replace(/;\s*Secure\b/ig, '') + '; Secure; SameSite=Lax';
  const remote = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' });
    const text = await response.text();
    if (!response.ok) throw new Error(`Remote authentication answered ${response.status}`);
    if (text.length > 1048576) throw new Error('Remote authentication response exceeded bound');
    return JSON.parse(text);
  };
  const googleKeys = async (fresh: boolean) => {
    if (fresh || !keys || now() - keys.at > KEYS_MS) keys = { value: await remote(GOOGLE_JWKS_URL), at: now() };
    return keys.value;
  };
  const verified = async (idToken: string, nonce: string) => {
    const first = verifyGoogleIdToken(idToken, await googleKeys(false), config.google, nonce, now());
    // Google rotates its keys: an unknown key id gets one fresh read of the key set.
    return !first.ok && first.message === 'Identity signing key not found' ? verifyGoogleIdToken(idToken, await googleKeys(true), config.google, nonce, now()) : first;
  };

  return createServer(async (req, res) => {
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const page = (code: number, title: string, body: string) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kenan · ${title}</title><style>body{background:#111318;color:#eee;font:18px system-ui;display:grid;place-content:center;min-height:90vh;text-align:center}a{color:white;background:#435de7;padding:14px 22px;border-radius:8px;text-decoration:none}p{color:#aaa;margin-bottom:32px;max-width:32em}</style><main>${body}</main></html>`);
    };
    const redirect = (location: string) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end(); };
    try {
      if (req.headers['x-forwarded-host'] !== undefined && req.headers['x-forwarded-host'] !== publicUrl.host) { json(403, fail('forbidden', 'This entrance belongs to the declared public host')); return; }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) { json(400, fail('invalid_input', 'Invalid public path')); return; }
      const url = new URL(req.url, config.publicUrl);
      if (url.pathname === '/v1/auth/login' && req.method === 'GET') {
        for (const [state, value] of pending) if (value.expires <= now()) pending.delete(state);
        if (pending.size >= PENDING_MAX) { json(503, fail('capacity_wait', 'Sign-in capacity is temporarily full')); return; }
        const start = startGoogleSignIn(config.google, callback);
        pending.set(start.state, { nonce: start.nonce, verifier: start.verifier, expires: now() + PENDING_MS });
        res.setHeader('Set-Cookie', stateCookie(start.state, PENDING_MS / 1000)); redirect(start.url); return;
      }
      if (url.pathname === '/v1/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state'), code = url.searchParams.get('code');
        const held = state === null ? undefined : pending.get(state);
        if (!state || !held || held.expires <= now() || cookieValue(req.headers.cookie, STATE_COOKIE) !== state || !code || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
          page(401, 'Sign in', `<h1>Sign-in expired</h1><p>Sign-in expired or could not be verified.</p><a href="${base}">Sign in again</a>`); return;
        }
        pending.delete(state);
        const tokens = await remote(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.google.clientId, client_secret: config.google.clientSecret, code, redirect_uri: callback, code_verifier: held.verifier }).toString() });
        if (!isRecord(tokens) || typeof tokens.id_token !== 'string') { json(401, fail('unauthenticated', 'Google returned no identity')); return; }
        const identity = await verified(tokens.id_token, held.nonce);
        if (!identity.ok) { res.setHeader('Set-Cookie', stateCookie('', 0)); page(403, 'Not allowed', `<h1>Not allowed</h1><p>${identity.message}. Kenan is open to everyone with a ACME Google Workspace account.</p><a href="${base}v1/auth/login">Choose another account</a>`); return; }
        const role = classify(identity.value, config.administrator);
        if (!('kind' in role)) { res.setHeader('Set-Cookie', stateCookie('', 0)); page(403, 'Not allowed', `<h1>Not allowed</h1><p>${role.message}.</p>`); return; }
        const account = role.kind === 'administrator' ? { accountId: config.administrator.accountId, accountSecret: config.administrator.accountSecret } : await resolveAccount(identity.value);
        const login = await fetcher(new URL('/api/login?startup=1', upstream), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kenan-client': 'native' }, body: JSON.stringify({ accountId: account.accountId, secret: account.accountSecret }), redirect: 'error', signal: AbortSignal.timeout(15000) });
        const answer: unknown = await login.json(), cookie = login.headers.getSetCookie().find(v => v.startsWith(SESSION_COOKIE + '='));
        if (!login.ok || !isRecord(answer) || answer.ok !== true || !cookie) { json(503, fail('unavailable', 'Google sign-in succeeded; the work account is temporarily unavailable. Retry sign-in.')); return; }
        res.setHeader('Set-Cookie', [stateCookie('', 0), nativeCookie(cookie)]); redirect(config.publicUrl); return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
        if (url.pathname === '/api/login') { json(403, fail('forbidden', 'Use Google sign-in on this public entrance')); return; }
        // The CONTENT cadence caller authenticates with its own OIDC bearer token, never a browser cookie.
        const contentOidc = url.pathname === '/api/operations/content-cadence' && req.method === 'POST' && !url.search;
        if (!contentOidc && !['GET', 'HEAD'].includes(req.method ?? '') && req.headers.origin !== publicUrl.origin) { json(403, fail('forbidden', 'Same-origin request required')); return; }
        const headers: IncomingMessage['headers'] = { ...req.headers, host: upstream.host };
        if (!contentOidc) delete headers.authorization; else { delete headers.cookie; delete headers.origin; }
        delete headers['x-pi-stack-next-client']; delete headers['x-kenan-client']; delete headers['x-forwarded-for'];
        const proxy = request(new URL(url.pathname + url.search, upstream), { method: req.method, headers }, response => {
          const outgoing = { ...response.headers, 'cache-control': 'no-store' };
          if (outgoing['set-cookie']) outgoing['set-cookie'] = outgoing['set-cookie'].map(nativeCookie);
          res.writeHead(response.statusCode ?? 502, outgoing); response.pipe(res);
        });
        proxy.on('error', () => { if (!res.headersSent) json(502, fail('unavailable', 'Work account transport unavailable')); else res.destroy(); });
        req.on('aborted', () => proxy.destroy()); res.on('close', () => proxy.destroy()); req.pipe(proxy); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(405, fail('invalid_input', 'Unsupported public method')); return; }
      let signedIn = Boolean(cookieValue(req.headers.cookie, SESSION_COOKIE));
      if (url.pathname === '/' && signedIn) {
        const session = await fetcher(new URL('/api/bootstrap', upstream), { headers: { cookie: `${SESSION_COOKIE}=${cookieValue(req.headers.cookie, SESSION_COOKIE)}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        // An expired native cookie returns to Google sign-in; an outage never revokes it.
        if (session.status === 401) { signedIn = false; res.setHeader('Set-Cookie', nativeCookie(`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)); }
        await session.body?.cancel();
      }
      if (url.pathname === '/' && !signedIn) { page(200, 'Sign in', `<h1>Kenan</h1><p>Your Acme workspace. Sign in with your ACME Google account.</p><a href="${base}v1/auth/login">Sign in with Google</a>`); return; }
      const root = await realpath(config.webRoot), path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = await realpath(resolve(root, '.' + path));
      if (!file.startsWith(root + '/')) { json(404, fail('not_found', 'Public resource not found')); return; }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      const type = types[extname(file)]; if (!type) { json(404, fail('not_found', 'Public resource not found')); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public,max-age=31536000,immutable', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch {
      if (!res.headersSent) json(503, fail('unavailable', 'Public sign-in or resource temporarily unavailable; retry from Sign in')); else res.destroy();
    }
  });
}
