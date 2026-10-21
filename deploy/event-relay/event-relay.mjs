#!/usr/bin/env node
// Forwards a remote JSON-lines event log into this host's event inbox (kenan-event) over ONE long-lived SSH session
// (`tail -F` on the remote file): each line with a string `owner` becomes a host event on topic `<topicPrefix>:<owner>`
// whose body is the line's JSON object, so the kenan-server agent with that id is woken by its `wake on: "event"`.
// Short SSH sessions have knocked acme-host over before, so the connection is reused for the life of the relay and
// reopened with backoff. The byte offset of the last forwarded line is kept in `state`, so a reconnect resumes where it
// stopped; each event's id is a hash of its line, so a line read twice is recorded once. When the session has been down
// STALL_MS, one phone alert goes to `uid`'s person through kenan-notify, and one more once it is back.
// SIGTERM/SIGINT stop it gracefully: the line being forwarded finishes and its offset is saved before exit, so a restart
// re-offers nothing. Only a crash between forwarding and saving re-offers that line (same id, recorded once).
//
// Usage: event-relay.mjs CONFIG.json     (event-relay.mjs --check CONFIG.json validates the config and exits)
// CONFIG: {"via": ["ssh", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ServerAliveInterval=30", "acme-host"],
//          "file": "/home/kenan/data/acme-releases/events.jsonl", "topicPrefix": "acme", "uid": 1000,
//          "state": "/home/kenan/.local/state/kenan-event-relay/acme.json", "startAt": "end",
//          "routine": [{"kind": ["deploy"], "outcome": ["live", "superseded"]}]}
// startAt ("end" or "beginning") applies only when the state file does not exist yet.
// routine: rules (field -> allowed values; a line matching every field of any rule) for successes and progress that
// nobody needs to act on within a minute; their events carry `routine: true`, so Kenan folds a burst of them into one
// later turn (server/agents/wakes.ts addressedSettled). [] marks nothing routine.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

export const STALL_MS = 10 * 60 * 1000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const STABLE_MS = 60_000;
const OWNER = /^[A-Za-z0-9._@-]{1,150}$/;

export function parseConfig(raw) {
  if (!Array.isArray(raw?.via) || !raw.via.length || raw.via.some(part => typeof part !== 'string' || !part)) throw new Error('via: command prefix reaching the remote host required, e.g. ["ssh", "acme-host"]');
  if (typeof raw.file !== 'string' || !raw.file.startsWith('/')) throw new Error('file: absolute remote path required');
  if (typeof raw.topicPrefix !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(raw.topicPrefix)) throw new Error('topicPrefix: 1-40 of A-Z a-z 0-9 . _ - required');
  if (!Number.isInteger(raw.uid) || raw.uid < 0) throw new Error('uid: uid of the person whose event inbox receives the events required');
  if (typeof raw.state !== 'string' || !raw.state.startsWith('/')) throw new Error('state: absolute path of the offset file required');
  if (raw.startAt !== 'end' && raw.startAt !== 'beginning') throw new Error('startAt: "end" or "beginning" (used when the state file does not exist yet) required');
  const rule = r => r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0 && Object.values(r).every(v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string'));
  if (!Array.isArray(raw.routine) || !raw.routine.every(rule)) throw new Error('routine: list of rules {field: [values]} marking routine events required ([] for none)');
  return { via: raw.via, file: raw.file, topicPrefix: raw.topicPrefix, uid: raw.uid, state: raw.state, startAt: raw.startAt, routine: raw.routine };
}

/** Whether a log object matches one of the routine rules. */
export const isRoutine = (routine, value) => routine.some(rule => Object.entries(rule).every(([field, values]) => values.includes(value[field])));

/** The forwarded event for one log line, or why it is skipped. */
export function eventOf(prefix, routine, line) {
  let value;
  try { value = JSON.parse(line); } catch { return { ok: false, error: 'not JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not a JSON object' };
  if (typeof value.owner !== 'string' || !OWNER.test(value.owner)) return { ok: false, error: 'no owner (an agent id of A-Z a-z 0-9 . _ @ -)' };
  const body = isRoutine(routine, value) ? { ...value, routine: true } : value;
  return { ok: true, value: { topic: `${prefix}:${value.owner}`, id: `${prefix}:${createHash('sha256').update(line).digest('hex')}`, body } };
}

const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
/** Remote shell: prints "@offset N" (the byte offset it starts at; N past the end restarts at 0, -1 means the current end), then follows the file. */
export const remoteCommand = (file, offset) => [
  `f=${quote(file)}; n=${offset}; s=$(stat -c %s "$f" 2>/dev/null || echo 0)`,
  `if [ "$n" -lt 0 ]; then n=$s; elif [ "$s" -lt "$n" ]; then echo "kenan-event-relay: $f is shorter than offset $n; reading it from the start" >&2; n=0; fi`,
  `echo "@offset $n"`,
  `exec tail -c +$((n+1)) -F "$f"`,
].join('; ');

const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

function readOffset(config) {
  if (!existsSync(config.state)) return config.startAt === 'end' ? -1 : 0;
  const offset = JSON.parse(readFileSync(config.state, 'utf8')).offset;
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`${config.state}: offset must be a non-negative integer`);
  return offset;
}
function saveOffset(config, offset) {
  mkdirSync(dirname(config.state), { recursive: true });
  const tmp = `${config.state}.tmp`;
  writeFileSync(tmp, JSON.stringify({ file: config.file, offset }) + '\n');
  renameSync(tmp, config.state);
}

function run(argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`${argv[0]} exited ${code}: ${err.trim().slice(0, 500)}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const forward = (config, event) => run(['kenan-event', '--uid', String(config.uid), '--id', event.id, event.topic], JSON.stringify(event.body));

/** One SSH session: resolves when it ends (with the reason), after the line in flight is forwarded and its offset saved.
 * `onHealthy` runs once the session has followed the file for STABLE_MS without a failure; `stop` ends it early. */
function session(config, onHealthy, stop) {
  return new Promise(resolve => {
    let offset = readOffset(config), header = true, ended = false, chain = Promise.resolve(), healthy = null;
    const child = spawn(config.via[0], [...config.via.slice(1), remoteCommand(config.file, offset)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const end = reason => { if (ended) return; ended = true; clearTimeout(healthy); child.kill('SIGTERM'); chain.then(() => resolve(reason)); };
    if (stop.aborted) end('stopped'); else stop.addEventListener('abort', () => end('stopped'), { once: true });
    createInterface({ input: child.stderr }).on('line', line => {
      log({ type: 'remote_stderr', line: line.slice(0, 500) });
      // A file that appears while nothing was read starts at offset 0, which tail follows correctly; anything else moved our offset.
      if (/truncated|has been replaced/.test(line) || (/has appeared/.test(line) && offset > 0)) end(`remote file changed: ${line.slice(0, 200)}`);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      chain = chain.then(async () => {
        if (ended) return;
        if (header) {
          const match = /^@offset (\d+)$/.exec(line);
          if (!match) return end(`unexpected first line: ${line.slice(0, 200)}`);
          header = false; offset = Number(match[1]); saveOffset(config, offset);
          log({ type: 'connected', file: config.file, offset });
          healthy = setTimeout(() => { if (!ended) onHealthy(); }, STABLE_MS);
          return;
        }
        const event = eventOf(config.topicPrefix, config.routine, line);
        if (event.ok) {
          try { await forward(config, event.value); } catch (error) { return end(`kenan-event failed: ${error.message}`); }
          log({ type: 'forwarded', topic: event.value.topic, id: event.value.id, offset });
        } else if (line.trim()) log({ type: 'skipped', offset, error: event.error, line: line.slice(0, 300) });
        offset += Buffer.byteLength(line) + 1;
        saveOffset(config, offset);
      });
    });
    child.on('error', error => end(`spawn failed: ${error.message}`));
    child.on('close', code => end(`session exited ${code}`));
  });
}

function alert(config, title, body) {
  run(['kenan-notify', '--uid', String(config.uid), title, 'normal'], body)
    .then(() => log({ type: 'alert', title }), error => log({ type: 'alert_failed', title, error: error.message }));
}

async function main(configPath) {
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stopping.abort());
  let failures = 0, downSince = null, alerted = false;
  while (!stopping.signal.aborted) {
    let stable = false;
    const reason = await session(config, () => {
      stable = true;
      if (alerted) alert(config, `Event relay ${config.topicPrefix} recovered`, `Following ${config.file} again; down since ${new Date(downSince).toISOString()}.`);
      downSince = null; alerted = false;
    }, stopping.signal);
    if (stopping.signal.aborted) break;
    failures = stable ? 0 : failures + 1;
    downSince ??= Date.now();
    log({ type: 'disconnected', reason, failures });
    if (!alerted && Date.now() - downSince >= STALL_MS) {
      alerted = true;
      alert(config, `Event relay ${config.topicPrefix} stalled`, `No session following ${config.file} for ${Math.round((Date.now() - downSince) / 60000)} min. Last error: ${reason}`);
    }
    await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)], undefined, { signal: stopping.signal }).catch(() => {});
  }
  log({ type: 'stopped' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--check') { parseConfig(JSON.parse(readFileSync(process.argv[3], 'utf8'))); console.log('config ok'); }
  else if (process.argv[2]) { await main(process.argv[2]); process.exit(0); }
  else { console.error('usage: event-relay.mjs [--check] CONFIG.json'); process.exit(2); }
}
