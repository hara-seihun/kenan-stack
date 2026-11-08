// Prompt-cache hit rates of a person's agents, from the model calls the runtime records (model_call), priced at the model catalog's list prices.
import { readFileSync } from 'node:fs';
import type { CacheFigures, CacheReport, CacheWindow } from '../../shared/contract.js';
import type { CacheGroup, Deps } from '../types.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The week's model calls are read at most this often; every person and every poll shares the read (about 0.3 s on Beta). */
const READ_EVERY_MS = 60_000;
export const CACHE_TOP = 6;

/** List prices in USD per million tokens; a tier applies to calls whose prompt exceeds inputTokensAbove. */
interface Rates { input: number; cacheRead: number; cacheWrite: number }
interface ModelPrice extends Rates { provider: string; tiers: (Rates & { inputTokensAbove: number })[] }
export type Catalog = Map<string, ModelPrice>;

export function readCatalog(modelsPath: string): Catalog {
  const source = JSON.parse(readFileSync(modelsPath, 'utf8'));
  const catalog: Catalog = new Map();
  for (const [provider, entry] of Object.entries<any>(source.catalog?.providers ?? source.providers ?? {})) {
    for (const model of entry?.models ?? []) {
      const cost = model?.cost;
      if (typeof model?.id !== 'string' || !cost) continue;
      catalog.set(model.id, { provider, input: cost.input ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0, tiers: (cost.tiers ?? []).map((t: any) => ({ inputTokensAbove: t.inputTokensAbove, input: t.input ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0 })) });
    }
  }
  return catalog;
}

/** Every tier threshold in the catalog, ascending: a group's tier index counts how many of these its calls' prompts exceeded. */
export const thresholdsOf = (catalog: Catalog): number[] => [...new Set([...catalog.values()].flatMap(m => m.tiers.map(t => t.inputTokensAbove)))].sort((a, b) => a - b);

/** What caching saved on a group's prompts: their cost with every prompt token as plain input, less what they cost. */
function saved(catalog: Catalog, thresholds: number[], g: CacheGroup): number {
  const price = catalog.get(g.model);
  if (!price) return 0;
  // Prompts in tier index k exceeded thresholds[0..k-1]; a model tier applies when its threshold is among those.
  const exceeded = g.tier > 0 ? thresholds[g.tier - 1]! : -Infinity;
  const rates = price.tiers.filter(t => t.inputTokensAbove <= exceeded).sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? price;
  return (g.cacheRead * (rates.input - rates.cacheRead) + g.cacheWrite * (rates.input - rates.cacheWrite)) / 1_000_000;
}

type Sum = { calls: number; cacheRead: number; cacheWrite: number; uncached: number; costUsd: number; savedUsd: number };
const empty = (): Sum => ({ calls: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, costUsd: 0, savedUsd: 0 });
const figures = (s: Sum): CacheFigures => {
  const promptTokens = s.cacheRead + s.cacheWrite + s.uncached;
  return { calls: s.calls, promptTokens, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, uncached: s.uncached, hitRate: promptTokens > 0 ? s.cacheRead / promptTokens : null, costUsd: s.costUsd, savedUsd: s.savedUsd };
};

/** One window from the groups that fall in it. `names` labels agents; an agent without a name shows its id. */
export function cacheWindow(groups: CacheGroup[], catalog: Catalog, thresholds: number[], names: Map<string, string>, top = CACHE_TOP): CacheWindow {
  const overall = empty();
  const keyed = { provider: new Map<string, Sum>(), model: new Map<string, Sum>(), agent: new Map<string, Sum>() };
  for (const g of groups) {
    const keys = { provider: catalog.get(g.model)?.provider ?? 'unknown', model: g.model, agent: g.agentId };
    const save = saved(catalog, thresholds, g);
    for (const s of [overall, ...(['provider', 'model', 'agent'] as const).map(k => keyed[k].get(keys[k]) ?? keyed[k].set(keys[k], empty()).get(keys[k])!)]) {
      s.calls += g.calls; s.cacheRead += g.cacheRead; s.cacheWrite += g.cacheWrite; s.uncached += g.input; s.costUsd += g.costUsd; s.savedUsd += save;
    }
  }
  const all = figures(overall);
  const list = <K extends string>(map: Map<string, Sum>, key: K) => [...map].map(([id, s]) => ({ [key]: id, ...figures(s) }) as CacheFigures & Record<K, string>)
    .sort((a, b) => b.promptTokens - a.promptTokens);
  const agents = list(keyed.agent, 'agentId').map(a => ({ ...a, name: names.get(a.agentId) ?? a.agentId }));
  const missRate = 1 - (all.hitRate ?? 1);
  return {
    overall: all,
    byProvider: list(keyed.provider, 'provider'),
    byModel: list(keyed.model, 'model'),
    topAgents: agents.slice(0, top),
    worstAgents: agents.map(a => ({ ...a, excessMiss: a.cacheWrite + a.uncached - missRate * a.promptTokens }))
      .filter(a => a.excessMiss > 0).sort((a, b) => b.excessMiss - a.excessMiss).slice(0, top),
  };
}

const reads = new WeakMap<Deps, { at: number; groups: Promise<CacheGroup[]>; catalog: Catalog; thresholds: number[] }>();
function weekOfGroups(deps: Deps, now: number) {
  const last = reads.get(deps);
  if (last && now - last.at < READ_EVERY_MS) return last;
  const catalog = readCatalog(deps.config.modelsPath), thresholds = thresholdsOf(catalog);
  const read = { at: now, catalog, thresholds, groups: deps.store.cacheGroups(now - WEEK, now - DAY, now - HOUR, thresholds) };
  read.groups.catch(() => { if (reads.get(deps) === read) reads.delete(deps); });
  reads.set(deps, read);
  return read;
}

/** Prompt caching of these agents (a person's, finished runs included) over the last hour, day and week; `top` caps the agent lists. */
export async function cacheReport(deps: Deps, agents: { id: string; name: string }[], top = CACHE_TOP): Promise<CacheReport> {
  const read = weekOfGroups(deps, deps.now());
  const groups = await read.groups;
  const names = new Map(agents.map(a => [a.id, a.name]));
  const mine = groups.filter(g => names.has(g.agentId));
  const window = (period: 0 | 1 | 2) => cacheWindow(mine.filter(g => g.period <= period), read.catalog, read.thresholds, names, top);
  return { hour: window(0), day: window(1), week: window(2) };
}
