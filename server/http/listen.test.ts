import { request } from 'node:http';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { listen, listenerFor } from './listen.js';

it('listens on a unix socket (replacing a stale one, mode 0666) and on host:port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kenan-listen-'));
  const socketPath = join(dir, 'kenan.sock');
  writeFileSync(socketPath, 'stale');
  const app = new Hono().get('/x', c => c.text('ok'));
  const server = await listen(app, { kind: 'address', address: socketPath });
  expect(statSync(socketPath).mode & 0o777).toBe(0o666);
  const body = await new Promise<string>((resolve, reject) => request({ socketPath, path: '/x' }, res => {
    let s = ''; res.on('data', d => { s += d; }).on('end', () => resolve(s));
  }).on('error', reject).end());
  expect(body).toBe('ok');
  await new Promise(r => server.close(r));
  const tcp = await listen(app, { kind: 'address', address: '127.0.0.1:0' });
  const port = (tcp.address() as { port: number }).port;
  expect(await (await fetch(`http://127.0.0.1:${port}/x`)).text()).toBe('ok');
  await new Promise(r => tcp.close(r));
  rmSync(dir, { recursive: true, force: true });
});

it('takes the socket systemd passes only when it is addressed to this process', () => {
  expect(listenerFor('/run/kenan/beta.sock', { LISTEN_PID: '42', LISTEN_FDS: '1' }, 42)).toEqual({ kind: 'systemd', fd: 3 });
  expect(listenerFor('/run/kenan/beta.sock', { LISTEN_PID: '41', LISTEN_FDS: '1' }, 42)).toEqual({ kind: 'address', address: '/run/kenan/beta.sock' });
  expect(listenerFor('/run/kenan/beta.sock', {}, 42)).toEqual({ kind: 'address', address: '/run/kenan/beta.sock' });
  expect(() => listenerFor('/run/kenan/beta.sock', { LISTEN_PID: '42', LISTEN_FDS: '2' }, 42)).toThrow(/exactly one/);
});
