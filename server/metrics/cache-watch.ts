// Host alert when prompt caching falls off: over the last hour, every agent on this channel together under 90% (with enough
// volume that a quiet hour can't trip it), or one busy agent under 90% on its own. The file names the providers, models and
// agents dragging it down, lives in each configured alertDir (Kenaznia's heartbeat lists it) and is removed once it recovers.
import { rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheFigures, CacheWindow } from '../../shared/contract.js';
import { hit, tokens } from '../../shared/cache-summary.js';
import type { Deps } from '../types.js';
import { cacheReport } from './cache.js';
import { causeSummary, conversationOf, readBrokerCalls, type BrokerCall } from './cache-cause.js';

export const LOW_HIT = 0.9;
/** An hour with fewer prompt tokens than this (all agents) is too quiet to judge; a busy hour is 200M–1.5B. */
export const MIN_OVERALL_TOKENS = 20_000_000;
/** One agent's hour counts on its own from this many prompt tokens (a busy Opus worker sends 3–15M an hour). */
export const MIN_AGENT_TOKENS = 5_000_000;
const CHECK_MS = 5 * 60_000;

const low = (f: CacheFigures, min: number) => f.promptTokens >= min && f.hitRate !== null && f.hitRate < LOW_HIT;
const fig = (f: CacheFigures) => `${hit(f.hitRate)} of ${tokens(f.promptTokens)} prompt tokens (${tokens(f.cacheWrite + f.uncached)} sent fresh)`;

/** The alert's markdown for the last hour's window of every agent (`topAgents` uncapped), or null when caching is fine. */
/** `causes` maps an agent id to why its calls missed the cache (causeSummary), where the broker's journal says. */
export function cacheAlert(w: CacheWindow, channel: string, causes: ReadonlyMap<string, string> = new Map()): string | null {
  const overallLow = low(w.overall, MIN_OVERALL_TOKENS);
  const agents = w.topAgents.filter(a => low(a, MIN_AGENT_TOKENS));
  if (!overallLow && !agents.length) return null;
  const lines = [overallLow
    ? `# Prompt cache hit rate is ${hit(w.overall.hitRate)} over the last hour on Kenan ${channel}`
    : `# ${agents.length === 1 ? 'An agent is' : `${agents.length} agents are`} missing the prompt cache on Kenan ${channel}`, '',
    `Last hour, every agent: ${fig(w.overall)}. Alert threshold ${hit(LOW_HIT)}.`, ''];
  const providers = w.byProvider.filter(p => p.hitRate !== null && p.hitRate < LOW_HIT);
  const models = w.byModel.filter(m => low(m, MIN_AGENT_TOKENS));
  if (providers.length) lines.push(`Providers under ${hit(LOW_HIT)}: ${providers.map(p => `${p.provider} ${fig(p)}`).join('; ')}.`);
  if (models.length) lines.push(`Models under ${hit(LOW_HIT)}: ${models.map(m => `${m.model} ${fig(m)}`).join('; ')}.`);
  const named = agents.length ? agents : w.worstAgents.slice(0, 5);
  if (named.length) lines.push('', agents.length ? `Agents under ${hit(LOW_HIT)} with at least ${tokens(MIN_AGENT_TOKENS)} prompt tokens:` : 'Agents sending the most fresh tokens:',
    ...named.map(a => `- ${a.name} (${a.agentId}): ${fig(a)}${causes.has(a.agentId) ? `. Cause: ${causes.get(a.agentId)}` : ''}`));
  lines.push('', 'Usual causes: an agent whose context is rewritten every turn (compaction, edited history, changing system prompt or tools), calls rotating across accounts, or a cache key that changes per call. Owner: server/metrics/cache-watch.ts. This file clears itself when the hour recovers.');
  return lines.join('\n') + '\n';
}

/** Why the agents the alert would name missed, from the broker's journal; empty when there is nothing to name or the journal can't be read. */
async function causesFor(deps: Deps, agents: { id: string; ownerId: string }[], w: CacheWindow): Promise<Map<string, string>> {
  const causes = new Map<string, string>();
  if (cacheAlert(w, deps.config.channel) === null) return causes;
  let calls: Map<string, BrokerCall[]>;
  try { calls = await readBrokerCalls(3600_000, deps.now()); } catch (e) { await deps.store.logError('cache-watch', `broker journal: ${String(e)}`); return causes; }
  for (const a of agents) {
    const summary = causeSummary(calls.get(conversationOf(a.ownerId, a.id)) ?? []);
    if (summary) causes.set(a.id, summary);
  }
  return causes;
}

export async function checkCache(deps: Deps): Promise<void> {
  const dirs = [...new Set(deps.config.people.flatMap(p => p.alertDir ? [p.alertDir] : []))];
  if (!dirs.length) return;
  const agents = await deps.store.listAgents(undefined, { includeArchived: true });
  const people = new Map(deps.config.people.map(p => [p.id, p.name]));
  const named = agents.map(a => ({ id: a.id, name: a.role === 'manager' ? `${people.get(a.ownerId) ?? a.ownerId}'s Kenaznia` : `${a.name} (${people.get(a.ownerId) ?? a.ownerId})` }));
  const hour = (await cacheReport(deps, named, Infinity)).hour;
  const text = cacheAlert(hour, deps.config.channel, await causesFor(deps, agents, hour));
  for (const dir of dirs) {
    const file = join(dir, `prompt-cache-${deps.config.channel}.md`);
    if (text === null) { await rm(file, { force: true }); continue; }
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
  }
}

/** Check now and every 5 minutes. Returns a stop function. */
export function startCacheWatch(deps: Deps): () => void {
  const run = () => void checkCache(deps).catch(e => deps.store.logError('cache-watch', String(e)));
  const timer = setInterval(run, CHECK_MS);
  timer.unref();
  run();
  return () => clearInterval(timer);
}
