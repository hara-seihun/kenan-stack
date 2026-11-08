#!/usr/bin/env node
// Watch the sender locally: a relay on a failed remote host cannot report its own outage.
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { request } from './peer-relay.mjs';

export const OVERDUE_MS = 15 * 60 * 1000;
// A relay silent this long while messages wait is down on its own host; this host cannot restart it, so the person is
// told once per outage (2026-11-06: ResearchCo's relay sessions closed at 11:50Z, and nothing but this watchdog's
// manager-addressed event noticed, which the manager could not act on).
export const NOTIFY_SILENT_MS = 30 * 60 * 1000;
export async function checkOutboxes(config, io = {}) {
  const read = io.request ?? request;
  const emit = io.emit ?? ((id, body) => {
    const result = spawnSync('kenan-event', ['--uid', String(config.uid), '--id', id, `acme:${config.manager}:peer-relay-failed`], { input: JSON.stringify(body), encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  });
  const notify = io.notify ?? ((title, body) => {
    const result = spawnSync('kenan-notify', ['--uid', String(config.uid), title, 'normal'], { input: body, encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  });
  const now = (io.now ?? Date.now)();
  const stateFile = `${config.alertFile}.socket-failures.json`;
  const loadFailures = io.loadFailures ?? (() => {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  });
  const saveFailures = io.saveFailures ?? (failures => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(failures), { mode: 0o600 });
    renameSync(`${stateFile}.tmp`, stateFile);
  });
  const notifiedFile = `${config.alertFile}.notified.json`;
  const loadNotified = io.loadNotified ?? (() => {
    try { return JSON.parse(readFileSync(notifiedFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  });
  const saveNotified = io.saveNotified ?? (notified => {
    writeFileSync(`${notifiedFile}.tmp`, JSON.stringify(notified), { mode: 0o600 });
    renameSync(`${notifiedFile}.tmp`, notifiedFile);
  });
  const previousNotified = await loadNotified();
  const notified = {};
  const previousFailures = await loadFailures();
  const failures = {};
  const problems = [];
  for (const side of config.sides) {
    try {
      const local = { ...side, via: [] };
      const { items } = await read(local, 'GET', `/outbox?peer=${side.peer}&wait=0&probe=1`, undefined, 5);
      const overdue = items.filter(item => now - item.createdAt > OVERDUE_MS);
      // The channel remembers when the relay last polled; an older channel without GET /status says nothing.
      const relay = overdue.length ? await read(local, 'GET', `/status?peer=${side.peer}`, undefined, 5).catch(() => null) : null;
      const diagnosis = relayDiagnosis(relay, now);
      for (const item of overdue) {
        const body = { message: 'A peer message has remained unrelayed for more than 15 minutes. Repair the relay; do not resend the message.', peer: side.peer, id: item.id, createdAt: item.createdAt, socket: side.socket, ...diagnosis };
        await emit(`peer-overdue:${item.id}`, body);
        problems.push(body);
      }
      const key = `${side.socket}:${side.peer}`;
      if (overdue.length && typeof relay?.since === 'number' && now - (relay.lastPolledAt ?? relay.since) > NOTIFY_SILENT_MS) {
        // One notice per outage: an outage is named by the last poll it began after.
        const outage = String(relay.lastPolledAt ?? `since:${relay.since}`);
        notified[key] = outage;
        if (previousNotified[key] !== outage) {
          await notify('Peer relay is down', `${overdue.length} message${overdue.length === 1 ? '' : 's'} to ${side.peer} ${overdue.length === 1 ? 'is' : 'are'} waiting here, kept and unsent. ${diagnosis.diagnosis} Restart its relay service (kenan-peer-relay) on that host; the messages are then delivered once each, without resending.`);
        }
      }
    } catch (error) {
      // One failed probe can overlap the application's socket replacement during deploy.
      // Persist across timer processes, but do not defer protocol or authorization errors.
      const connectionFailure = /ENOENT|ECONNREFUSED|socket missing|curl GET .*exited 7:|Failed to connect/.test(String(error.message ?? error));
      const key = `${side.socket}:${side.peer}`;
      if (connectionFailure) {
        failures[key] = true;
        if (!previousFailures[key]) continue;
      }
      const body = { message: 'The local peer outbox cannot be checked. Repair the socket or its channel.', peer: side.peer, socket: side.socket, error: String(error.message ?? error) };
      await emit(`peer-watch-error:${side.peer}:${Math.floor(now / 3600000)}`, body);
      problems.push(body);
    }
  }
  await saveFailures(failures);
  await saveNotified(notified);
  const condition = io.condition ?? (problems => {
    if (!problems.length) return rmSync(config.alertFile, { force: true });
    writeFileSync(`${config.alertFile}.tmp`, `# Peer delivery needs repair\n\n${problems.map(p => JSON.stringify(p)).join('\n')}\n`);
    renameSync(`${config.alertFile}.tmp`, config.alertFile);
  });
  await condition(problems);
  return problems;
}
/** What the channel's record of relay polls says about an overdue message: whose host the fix is on. */
export function relayDiagnosis(relay, now) {
  if (!relay || typeof relay.since !== 'number') return { diagnosis: 'This channel does not report relay polls, so it is unknown whether the relay is polling.' };
  const at = ms => new Date(ms).toISOString();
  if (relay.lastPolledAt === null) {
    return { relayLastPolledAt: null, diagnosis: `The relay has not polled this outbox since the channel started at ${at(relay.since)}: the relay on the peer's host is not running or cannot reach this host.` };
  }
  if (now - relay.lastPolledAt > 2 * 60 * 1000) {
    return { relayLastPolledAt: at(relay.lastPolledAt), diagnosis: `The relay last polled this outbox at ${at(relay.lastPolledAt)}: the relay on the peer's host stopped or lost its connection to this host.` };
  }
  return { relayLastPolledAt: at(relay.lastPolledAt), diagnosis: `The relay polls this outbox (last at ${at(relay.lastPolledAt)}) but has not acknowledged the message: delivery into the peer's inbox is failing; read the relay's log on the peer's host.` };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkOutboxes(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
