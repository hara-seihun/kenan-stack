#!/usr/bin/env node
// Relays messages between two Kenaznias' peer sockets (server/peers.ts), one on this host and one reached through a
// command prefix (e.g. `ssh acme-host`). Each side names the other by its own peer id. Both directions long-poll
// the sender's outbox, post each message to the receiver's inbox (idempotent by message id), then ack the sender.
// A failed step is retried after a pause, so nothing is lost or delivered twice across relay, host or network restarts.
// When either direction has failed for STALL_MS, one phone alert goes to alertUid's person through kenan-notify (the host
// notify outbox), and one more when relaying works again: on 2026-10-19 the remote Kenan was down 21:15-23:47Z and five
// messages sat unrelayed with nobody told. The stall is also a machine condition: alertFile (in the host's
// /var/lib/machine-alerts/inbox, which Kenaznia's heartbeat lists) exists while relaying is stalled and names each side's
// channel unit state, because on 2026-10-20 the phone alert alone went unanswered for 11.5 h. Restarting a stopped channel
// belongs to that host's kenan-runtime-recovery timer (enabled channels come back; a disabled channel is an intended hold).
//
// Usage: peer-relay.mjs CONFIG.json     (peer-relay.mjs --check CONFIG.json validates the config and exits)
// CONFIG: {"local":  {"socket": "/run/kenan/beta-peer/alice.sock", "peer": "acme", "via": []},
//          "remote": {"socket": "/run/kenan/beta-peer/acme.sock", "peer": "alice-personal", "via": ["ssh", "acme-host"]},
//          "alertUid": 1000, "alertFile": "/var/lib/machine-alerts/inbox/peer-relay-acme.md"}
// local.peer is how the local person names the remote Kenaznia, and remote.peer how the remote person names the local one.
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const WAIT_SECONDS = 25;
const RETRY_MS = 5000;
export const STALL_MS = 10 * 60 * 1000;

export function parseConfig(raw) {
  const side = (value, name) => {
    if (!value || typeof value !== 'object') throw new Error(`${name}: object required`);
    if (typeof value.socket !== 'string' || !value.socket.startsWith('/')) throw new Error(`${name}.socket: absolute path required`);
    if (typeof value.peer !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value.peer)) throw new Error(`${name}.peer: peer id required`);
    if (!Array.isArray(value.via) || value.via.some(part => typeof part !== 'string' || !part)) throw new Error(`${name}.via: command prefix list required ([] for this host)`);
    return { socket: value.socket, peer: value.peer, via: value.via };
  };
  if (!Number.isInteger(raw?.alertUid) || raw.alertUid < 0) throw new Error('alertUid: uid of the person alerted when relaying stalls required');
  if (typeof raw?.alertFile !== 'string' || !raw.alertFile.startsWith('/') || !raw.alertFile.endsWith('.md')) throw new Error('alertFile: absolute path of the machine-alert condition file (.md) required');
  return { local: side(raw?.local, 'local'), remote: side(raw?.remote, 'remote'), alertUid: raw.alertUid, alertFile: raw.alertFile };
}

/** The Kenan channel serving a peer socket (/run/kenan/CHANNEL-peer/PERSON.sock). */
export function channelOf(socket) {
  const match = /^\/run\/kenan\/(beta|production)-peer\/[^/]+\.sock$/.exec(socket);
  return match ? { ok: true, channel: match[1] } : { ok: false, error: `socket ${socket} is not a Kenan channel peer socket` };
}

/** One HTTP request to a side's peer socket through curl (run through its command prefix); resolves the parsed JSON reply or rejects. */
export function request(side, method, path, body, timeoutSeconds) {
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  const curl = ['curl', '--silent', '--show-error', '--max-time', String(timeoutSeconds), '--unix-socket', side.socket, '-X', method, ...(body === undefined ? [] : ['-H', 'content-type: application/json', '--data-binary', '@-']), `http://localhost${path}`];
  // ssh joins its arguments into one remote shell command, so a prefixed command is quoted for that shell.
  const argv = side.via.length ? [...side.via, curl.map(quote).join(' ')] : curl;
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), (timeoutSeconds + 20) * 1000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${argv[0]} ${method} ${path} exited ${code}: ${err.trim().slice(0, 500)}`));
      let parsed;
      try { parsed = JSON.parse(out); } catch { return reject(new Error(`${method} ${path} replied with non-JSON: ${out.slice(0, 300)}`)); }
      if (!parsed.ok) return reject(new Error(`${method} ${path} refused: ${JSON.stringify(parsed.error).slice(0, 500)}`));
      resolve(parsed.value);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Moves one batch from `from`'s outbox to `to`'s inbox; returns how many were delivered. */
export async function relayOnce(from, to, waitSeconds) {
  const { items } = await request(from, 'GET', `/outbox?peer=${from.peer}&wait=${waitSeconds}`, undefined, waitSeconds + 15);
  for (const [index, item] of items.entries()) {
    try {
      const received = await request(to, 'POST', '/inbox', { id: item.id, peer: to.peer, from: item.from, to: item.to, text: item.text, createdAt: item.createdAt }, 30);
      await request(from, 'POST', '/ack', { peer: from.peer, ids: [item.id] }, 30);
      log({ type: 'relayed', id: item.id, from: from.socket, to: to.socket, duplicate: received.duplicate });
    } catch (error) {
      throw Object.assign(error, { pending: items.slice(index).map(pending => ({ id: pending.id, createdAt: pending.createdAt })) });
    }
  }
  return items.length;
}

const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

/**
 * Relay health across both directions: `failed`/`succeeded` per direction return the alert to raise, if any. One alert
 * when some direction has been failing for STALL_MS, one when every direction works again after that alert.
 */
export function relayHealth(now) {
  const failing = new Map();
  let alerted = false;
  const describe = () => [...failing].map(([name, f]) => {
    const pending = f.pending.length ? `; ${f.pending.length} message(s) waiting, oldest from ${f.pending[0].createdAt}` : '';
    return `${name}: failing since ${new Date(f.since).toISOString()}${pending}; last error: ${f.error}`;
  }).join('\n');
  return {
    failed(name, error, pending) {
      const since = failing.get(name)?.since ?? now();
      failing.set(name, { since, error, pending });
      if (alerted || now() - since < STALL_MS) return null;
      alerted = true;
      return { kind: 'stalled', title: 'Peer relay stalled', body: describe() };
    },
    succeeded(name) {
      failing.delete(name);
      if (!alerted || failing.size) return null;
      alerted = false;
      return { kind: 'recovered', title: 'Peer relay recovered', body: 'Both directions relay again; held messages are delivered.' };
    },
  };
}

/** One line per side: its channel unit's state as that side's host reports it, or why it couldn't be read. */
function unitStates(config) {
  const side = (name, value) => new Promise(resolve => {
    const channel = channelOf(value.socket);
    if (!channel.ok) return resolve(`${name}: ${channel.error}`);
    const unit = `kenan@${channel.channel}.service`;
    const argv = [...value.via, 'systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'UnitFileState'];
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.on('error', error => { clearTimeout(timer); resolve(`${name} ${unit}: unreadable (${error.message})`); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? `${name} ${unit}: ${out.trim().replace(/\n/g, ', ')}` : `${name} ${unit}: unreadable (exit ${code})`); });
  });
  return Promise.all([side('local', config.local), side('remote', config.remote)]);
}

async function raise(alert, config, label) {
  if (!alert) return;
  const title = `${alert.title}: ${label}`;
  if (alert.kind === 'stalled') {
    const units = await unitStates(config);
    const text = `# ${title}\n\n${alert.body}\n\nChannel units:\n${units.map(line => `- ${line}`).join('\n')}\n\nAn enabled channel that is inactive is restarted by that host's kenan-runtime-recovery timer; disabled means someone holds it stopped on purpose. This file disappears when both directions relay again.\n`;
    try { writeFileSync(`${config.alertFile}.tmp`, text); renameSync(`${config.alertFile}.tmp`, config.alertFile); log({ type: 'alert_file', path: config.alertFile, units }); }
    catch (error) { log({ type: 'alert_failed', title, error: `alert file: ${error.message}` }); }
  } else {
    try { rmSync(config.alertFile, { force: true }); }
    catch (error) { log({ type: 'alert_failed', title, error: `alert file removal: ${error.message}` }); }
  }
  const child = spawn('kenan-notify', ['--uid', String(config.alertUid), title, 'normal'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', error => log({ type: 'alert_failed', title, error: String(error.message ?? error) }));
  child.on('close', code => log(code === 0 ? { type: 'alert', title, body: alert.body } : { type: 'alert_failed', title, error: `kenan-notify exited ${code}: ${err.trim().slice(0, 300)}` }));
  child.stdin.end(alert.body);
}

async function direction(name, from, to, health, report, signal) {
  while (!signal.aborted) {
    try { await relayOnce(from, to, WAIT_SECONDS); report(health.succeeded(name)); }
    catch (error) {
      const message = String(error.message ?? error).slice(0, 600);
      log({ type: 'retry', direction: name, error: message });
      report(health.failed(name, message, error.pending ?? []));
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv[2] === '--check';
  const path = process.argv[check ? 3 : 2];
  if (!path) { console.error('usage: peer-relay.mjs [--check] CONFIG.json'); process.exit(2); }
  const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
  if (check) process.exit(0);
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { controller.abort(); process.exit(0); });
  log({ type: 'started', local: config.local, remote: config.remote });
  const health = relayHealth(Date.now);
  const report = alert => { void raise(alert, config, `${config.local.peer} via ${config.remote.via.join(' ') || 'this host'}`); };
  await Promise.all([
    direction('local->remote', config.local, config.remote, health, report, controller.signal),
    direction('remote->local', config.remote, config.local, health, report, controller.signal),
  ]);
}
