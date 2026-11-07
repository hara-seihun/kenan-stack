import { request } from 'node:http';
import { appendFile } from 'node:fs/promises';
import type { SlackObservation } from './meeting-slack.js';
import { namesKenan } from './slack-addressee.js';
const KENAN = 'U000EXAMPLE0';
const SOCKET = '/run/kenan-slack-reactions/reactions.sock';
const LATENCY = '/home/kenan/data/slack-lane/request-latency.jsonl';
/** Socket Mode delivers live events within seconds; anything older is a replay or a fixture, never a new request. */
export const MAX_SOURCE_AGE_SECONDS = 300;
/** The production socket and latency file are reachable only from the real runtime: a test run must inject its own
 * paths explicitly, so fixtures built from real Slack messages can never add a real reaction (2026-10-29 incident). */
export function reactionTargets(env: NodeJS.ProcessEnv = process.env): { socket: string; latency: string } | undefined {
  const underTest = !!(env.VITEST || env.NODE_ENV === 'test');
  const socket = env.KENAN_SLACK_REACTION_SOCKET ?? (underTest ? undefined : SOCKET);
  const latency = env.KENAN_SLACK_LATENCY_FILE ?? (underTest ? undefined : LATENCY);
  return socket && latency ? { socket, latency } : undefined;
}
export function reactionAddressed(message: SlackObservation): boolean {
  if (!message.user || [KENAN, 'U000EXAMPLE0', 'USLACKBOT'].includes(message.user) || message.bot_id || message.subtype === 'bot_message') return false;
  // A plain-text "@Kenan" or "Kenan, could you" (some Slack apps send no mention token) addresses him too.
  const mention = namesKenan(message.text);
  const dm = message.directMessageWithKenan && /^D[A-Z0-9]+$/.test(message.channel);
  const otherMention = [...message.text.matchAll(/<@(U[A-Z0-9]+)>/g)].some(match => match[1] !== KENAN);
  return mention || dm || (message.parent_user_id === KENAN && !!message.thread_ts && !otherMention);
}
/** Dispatch on the existing socket callback, independent of persistence, models and text delivery.
 * The warm writer rechecks audience, opt-outs, live invocation and effect authority.
 */
export function immediateReaction(message: SlackObservation, now = Date.now()): void {
  const targets = reactionTargets();
  if (!targets) return;
  const age = now / 1000 - Number(message.ts);
  if (!Number.isFinite(age) || age > MAX_SOURCE_AGE_SECONDS) return;
  const source = `slack:${message.channel}/${message.ts}`;
  const started = Date.now();
  const payload = JSON.stringify({ channel: message.channel, timestamp: message.ts,
    threadTs: message.thread_ts ?? message.ts, emoji: 'eyes', dryRun: false });
  let finished = false;
  const record = (status: string) => {
    if (finished) return; finished = true;
    const at = Date.now() / 1000;
    void appendFile(targets.latency, JSON.stringify({ source,
      stage: 'reaction-receipt', status, at, fromSlackSeconds: +(at - Number(message.ts)).toFixed(6),
      elapsedSeconds: (Date.now() - started) / 1000, path: 'socket-event', observed: status !== 'unknown' }) + '\n', { mode: 0o600 }).catch(() => {});
  };
  const req = request({ socketPath: targets.socket, path: '/react', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => {
    let body = '';
    response.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 65536) req.destroy(); });
    response.on('end', () => {
      try {
        const result = JSON.parse(body) as { reacted?: boolean; alreadyPresent?: boolean };
        record(response.statusCode !== 200 ? 'unknown' : result.alreadyPresent ? 'already-present' : result.reacted ? 'added' : 'unknown');
      } catch { record('unknown'); }
    });
    response.on('error', () => record('unknown'));
  });
  req.on('error', () => record('unknown'));
  req.setTimeout(1900, () => { record('unknown'); req.destroy(); });
  req.end(payload);
}
