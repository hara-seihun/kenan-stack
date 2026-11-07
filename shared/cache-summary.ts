// Plain-text figures for prompt caching, shared by the Usage screen and the usage tool.
import type { CacheFigures, CacheReport, CacheWindow } from './contract.js';

/** 9.2B, 120M, 45k, 800. */
export function tokens(n: number): string {
  for (const [unit, size] of [['B', 1e9], ['M', 1e6], ['k', 1e3]] as const) if (Math.abs(n) >= size) return `${(n / size).toFixed(n / size < 10 ? 1 : 0)}${unit}`;
  return String(Math.round(n));
}
export const hit = (rate: number | null): string => rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
export const usd = (n: number): string => `$${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
/** The share of what the calls would have cost with no cache that caching saved. */
export const savedShare = (f: CacheFigures): number | null => f.costUsd + f.savedUsd > 0 ? f.savedUsd / (f.costUsd + f.savedUsd) : null;

function line(name: string, w: CacheWindow, offenders: boolean): string {
  const o = w.overall;
  if (!o.promptTokens) return `${name}: no model calls`;
  const share = savedShare(o);
  const parts = [`${name}: ${hit(o.hitRate)} of ${tokens(o.promptTokens)} prompt tokens read from cache over ${o.calls} calls; caching saved ${usd(o.savedUsd)}${share === null ? '' : ` (${Math.round(share * 100)}% of list-price spend)`}`,
    `by provider ${w.byProvider.map(p => `${p.provider} ${hit(p.hitRate)}`).join(', ')}`,
    `by model ${w.byModel.map(m => `${m.model} ${hit(m.hitRate)} of ${tokens(m.promptTokens)}`).join(', ')}`];
  if (offenders && w.worstAgents.length) parts.push(`worst agents ${w.worstAgents.map(a => `${a.name} (${a.agentId}) ${hit(a.hitRate)} of ${tokens(a.promptTokens)}, ${tokens(a.excessMiss)} extra fresh`).join('; ')}`);
  return parts.join('; ');
}

/** One line per window; worst offenders for the hour and day. */
export const cacheLines = (r: CacheReport): string[] => [line('last hour', r.hour, true), line('last 24 h', r.day, true), line('last 7 days', r.week, false)];
