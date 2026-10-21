import { expect, it } from 'vitest';
import { ApiError, readResult } from './client.js';
import { readSnapshot, writeSnapshot } from './snapshot.js';

const NGINX_502 = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.28.0</center>\r\n</body>\r\n</html>\r\n';

it('turns a page from the entrance (a restart) into a typed unreachable error that never carries the page', async () => {
  const failure = await readResult<never>(new Response(NGINX_502, { status: 502, headers: { 'content-type': 'text/html' } })).catch((e: ApiError) => e);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure.code).toBe('unreachable');
  expect(failure.message).not.toMatch(/<|html|JSON/i);
  const broken = await readResult<never>(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'application/json' } })).catch((e: ApiError) => e);
  expect([broken.code, /</.test(broken.message)]).toEqual(['unreachable', false]);
  const refused = await readResult<never>(new Response(JSON.stringify({ ok: false, error: { code: 'unauthenticated', message: 'Login required' } }), { status: 401, headers: { 'content-type': 'application/json' } })).catch((e: ApiError) => e);
  expect([refused.code, refused.message]).toEqual(['unauthenticated', 'Login required']);
  expect(await readResult(new Response(JSON.stringify({ ok: true, value: 7 }), { headers: { 'content-type': 'application/json; charset=utf-8' } }))).toBe(7);
});

it('draws a saved screen only for the build that saved it', () => {
  const items = new Map<string, string>();
  const localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } } as Storage;
  const screen = { bootstrap: { conversations: [], agents: [] } as never, page: null };
  expect(writeSnapshot(localStorage, 'index-old.js', screen)).toEqual({ ok: true, written: true });
  expect(readSnapshot(localStorage, 'index-old.js')).toEqual({ kind: 'found', snapshot: screen });
  expect(readSnapshot(localStorage, 'index-new.js')).toMatchObject({ kind: 'invalid' });
  expect(readSnapshot(localStorage, 'index-old.js')).toEqual({ kind: 'none' });
});
