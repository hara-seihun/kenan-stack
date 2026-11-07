// Where a call's media bridge runs. `local`: a transient systemd unit on this host. `edge`: the same unit on the phone edge,
// a small machine in US-west near the carrier's US network and GPT Live's US media, so call audio no longer
// crosses the Atlantic twice per exchange (Europe added ~0.37 s per exchange; machine/phone-calling.md). The server,
// database and agents stay here: the bridge reaches the database over the household mesh and its logs and recordings are
// pulled back here after each call (deploy/phone-edge/). Either way the bridge gets everything it needs as one spec, so
// the edge holds no configuration or keys on disk: the spec lives in /run (RAM) and the bridge deletes it once read.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PersonConfig, ServerConfig as Config } from '../config.js';
import type { AriConfig } from './phone-ari.js';

const run = promisify(execFile);

/** Everything a bridge process needs, written by the server for one call. */
export type BridgeSpec = {
  /** Rendered in memory on the owner host; the existing one-use spec lives only in /run. */
  brief: string;
  callId: string;
  channel: Config['channel'];
  databaseUrl: string;
  dataDir: string;
  person: PersonConfig;
  /** The person's `media` settings (telephone, live, voice), as in their extension config. */
  media: Record<string, unknown>;
  /** Asterisk's ARI: Asterisk runs on the host where the bridge runs. */
  ari: AriConfig;
  liveKey: string;
  host: BridgeHost['kind'];
};

export type EdgeConfig = { host: string; user: string; sshKeyPath: string; knownHostsPath: string; databaseHost: string; databasePort: number; releaseRoot: string; dataRoot: string };
/** media.telephone.bridge as configured; the edge's own settings are read only where the server uses them. */
export type BridgeChoice = { kind: 'local' } | { kind: 'edge'; path: string };
export type BridgeHost = { kind: 'local' } | { kind: 'edge'; edge: EdgeConfig };

/** media.telephone.bridge: `{"kind":"local"}` or `{"kind":"edge","path":"/etc/kenan/phone-edge.json"}`. Required, no default. */
export function bridgeChoice(raw: unknown): BridgeChoice {
  const b = raw as Record<string, unknown> | undefined;
  if (b?.kind === 'local' && Object.keys(b).length === 1) return { kind: 'local' };
  if (b?.kind === 'edge' && typeof b.path === 'string' && b.path.startsWith('/') && Object.keys(b).length === 2) return { kind: 'edge', path: b.path };
  throw new Error('media.telephone.bridge must be {"kind":"local"} or {"kind":"edge","path":"/etc/kenan/phone-edge.json"}');
}
export const bridgeHost = (choice: BridgeChoice): BridgeHost => choice.kind === 'local' ? choice : { kind: 'edge', edge: edgeConfig(choice.path) };

export function edgeConfig(path: string): EdgeConfig {
  const e = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const text = ['host', 'user', 'sshKeyPath', 'knownHostsPath', 'databaseHost', 'releaseRoot', 'dataRoot'] as const;
  if (text.some(k => typeof e[k] !== 'string' || !e[k]) || !Number.isInteger(e.databasePort)) throw new Error(`${path} must set ${text.join(', ')} (strings) and databasePort (integer)`);
  return e as EdgeConfig;
}

export const bridgeUnit = (id: string) => `kenan-call-${id}`;

const sshArgs = (edge: EdgeConfig) => ['-i', edge.sshKeyPath, '-o', `UserKnownHostsFile=${edge.knownHostsPath}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
  // One shared connection: a fresh SSH handshake to US-west costs ~0.7 s, which an inbound call would wait for.
  '-o', 'ControlMaster=auto', '-o', 'ControlPath=/run/kenan/phone-edge-%C', '-o', 'ControlPersist=6h', '-o', 'ServerAliveInterval=15', `${edge.user}@${edge.host}`];

/** Runs the edge's bridge launcher (deploy/phone-edge/kenan-edge-bridge) with input on stdin. */
function onEdge(edge: EdgeConfig, args: string[], input: string | null): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(edge), 'kenan-edge-bridge', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** The spec for a call, with the database and data directory as the bridge's host sees them. */
export function bridgeSpec(config: Config, person: PersonConfig, media: Record<string, unknown>, host: BridgeHost, callId: string, ari: AriConfig, liveKey: string): Omit<BridgeSpec, 'brief'> {
  if (host.kind === 'local') return { callId, channel: config.channel, databaseUrl: config.databaseUrl, dataDir: config.dataDir, person, media, ari, liveKey, host: 'local' };
  const database = new URL(config.databaseUrl).pathname.replace(/^\//, '');
  if (!database) throw new Error(`databaseUrl names no database: ${config.databaseUrl}`);
  return { callId, channel: config.channel, databaseUrl: `postgresql://kenan_phone_edge@${host.edge.databaseHost}:${host.edge.databasePort}/${database}`, dataDir: join(host.edge.dataRoot, config.channel), person, media, ari, liveKey, host: 'edge' };
}

const UNIT_PROPERTIES = ['--expand-environment=no', '--collect', '--quiet', '--property=KillMode=mixed', '--property=TimeoutStopSec=15'];

export async function startBridge(host: BridgeHost, spec: BridgeSpec): Promise<void> {
  if (host.kind === 'edge') {
    const r = await onEdge(host.edge, ['start', spec.channel, spec.callId], JSON.stringify(spec));
    if (r.code !== 0) throw new Error(`phone edge refused the bridge (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return;
  }
  const dir = '/run/kenan/phone-bridge';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${spec.callId}.json`);
  writeFileSync(path, JSON.stringify(spec), { mode: 0o600 });
  try {
    await run('systemd-run', [...UNIT_PROPERTIES, '--unit', bridgeUnit(spec.callId), process.execPath, fileURLToPath(new URL('./phone-bridge.js', import.meta.url)), path]);
  } catch (e) {
    try { unlinkSync(path); } catch { /* the bridge may have read and removed it */ }
    throw e;
  }
}

export async function stopBridge(host: BridgeHost, id: string): Promise<void> {
  if (host.kind === 'local') { await run('systemctl', ['stop', bridgeUnit(id)]); return; }
  const r = await onEdge(host.edge, ['stop', id], null);
  if (r.code !== 0) throw new Error(`phone edge could not stop ${bridgeUnit(id)} (exit ${r.code}): ${r.stderr.trim()}`);
}

/** Brings a finished edge call's log and recording home now, rather than at the puller's next minute
 *  (kenan-phone-edge-pull.service, deploy/phone-edge/pull-logs.sh; its timer stays as the retry), and resolves once
 *  the pull has run. A local bridge's log is home already. */
export async function pullEdgeLogs(host: BridgeHost): Promise<void> {
  if (host.kind === 'edge') await run('systemctl', ['start', 'kenan-phone-edge-pull.service']);
}

export type BridgeState = { kind: 'running' } | { kind: 'gone' } | { kind: 'unknown'; why: string };
/** Whether the call's bridge unit still runs. Only a definite answer from systemd ("inactive" or "failed") means it is
 *  gone; a query that was killed or answered nothing is `unknown`, because the call may still be live. (2026-11-02, call
 *  d16adef8: a Beta restart killed the sweep's ssh query mid-call, its empty output read as "gone", and the call was settled
 *  as "bridge exited without recording an end" four seconds before the running bridge recorded the real one.) */
export async function bridgeState(host: BridgeHost, id: string): Promise<BridgeState> {
  if (host.kind === 'local') {
    // `systemctl is-active` exits 3 or 4 for an inactive or unknown unit and still prints its state; a killed one prints nothing.
    const out = await run('systemctl', ['is-active', bridgeUnit(id)]).then(r => r.stdout,
      (e: { code?: unknown; stdout?: string }) => typeof e.code === 'number' ? String(e.stdout ?? '') : null);
    return readBridgeState(out, 'systemctl on this host');
  }
  // The edge script always exits 0 with systemd's answer; 255 is ssh failing, -1 the query killed.
  const r = await onEdge(host.edge, ['state', id], null).catch(() => null);
  if (r === null || r.code === 255) return { kind: 'unknown', why: 'phone edge unreachable' };
  return readBridgeState(r.code === 0 ? r.stdout : null, `the phone edge (exit ${r.code})`);
}

export function readBridgeState(stdout: string | null, where: string): BridgeState {
  const state = stdout?.trim() ?? '';
  if (['active', 'activating', 'deactivating', 'reloading'].includes(state)) return { kind: 'running' };
  if (state === 'inactive' || state === 'failed') return { kind: 'gone' };
  return { kind: 'unknown', why: state ? `${where} answered "${state}"` : `${where} gave no answer` };
}

/** Reads and deletes a bridge spec (it holds keys; /run is RAM). */
export function takeSpec(path: string): BridgeSpec {
  const spec = JSON.parse(readFileSync(path, 'utf8')) as BridgeSpec;
  unlinkSync(path);
  return spec;
}
