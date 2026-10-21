// Serve a Hono app on a unix socket path or host:port, or on the socket systemd holds for it (deploy/kenan@.socket).
import { chmod, unlink } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';

/** sd_listen_fds(3): systemd passes the channel's listening socket as fd 3 when the socket unit started this process.
 *  It stays open in systemd across restarts, so requests that arrive meanwhile wait in its queue instead of failing. */
export type Listener = { kind: 'systemd'; fd: number } | { kind: 'address'; address: string };
export function listenerFor(address: string, env: NodeJS.ProcessEnv, pid: number): Listener {
  if (env.LISTEN_PID !== String(pid)) return { kind: 'address', address };
  if (env.LISTEN_FDS !== '1') throw new Error(`systemd passed ${env.LISTEN_FDS} sockets; the channel socket unit passes exactly one`);
  return { kind: 'systemd', fd: 3 };
}

export async function listen(app: Hono<any>, listener: Listener): Promise<Server> {
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  server.keepAliveTimeout = 65_000;
  if (listener.kind === 'systemd') {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ fd: listener.fd }, resolve); });
    return server;
  }
  const { address } = listener;
  const hostPort = /^(.*):(\d+)$/.exec(address);
  if (!hostPort) await unlink(address).catch(e => { if (e.code !== 'ENOENT') throw e; });   // stale socket
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (hostPort) server.listen(Number(hostPort[2]), hostPort[1] || '127.0.0.1', resolve);
    else server.listen(address, resolve);
  });
  if (!hostPort) await chmod(address, 0o666);
  return server;
}
