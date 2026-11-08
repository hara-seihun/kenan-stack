// Antigravity's subscription quota comes from the same native broker route as inference.
import type { UsageSample } from '../types.js';

type QuotaWindow = { window: '5h' | 'weekly'; remainingFraction: number; resetTime?: string | null };
export type GoogleQuota = {
  available: boolean;
  exhausted: boolean;
  resetAt?: string | null;
  models: { id: string; nativeModel?: string; remainingFraction?: number | null; resetAt?: string | null }[];
  observedAt: string | number;
  error?: string;
  summary?: {
    groups?: Record<string, { windows?: QuotaWindow[] }> ;
    perModel?: { modelId: string; group: string | null }[];
  };
};
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const validDate = (value: unknown) => value == null || typeof value === 'string' && Number.isFinite(Date.parse(value));

export function parseGoogleQuota(value: unknown): GoogleQuota {
  const quota = value as GoogleQuota;
  if (!quota || typeof quota.available !== 'boolean' || typeof quota.exhausted !== 'boolean' || !validDate(quota.resetAt)
      || !Array.isArray(quota.models) || quota.models.some(model => typeof model?.id !== 'string'
        || model.remainingFraction != null && (typeof model.remainingFraction !== 'number' || !Number.isFinite(model.remainingFraction) || model.remainingFraction < 0 || model.remainingFraction > 1)
        || !validDate(model.resetAt))
      || !(typeof quota.observedAt === 'number' && Number.isFinite(quota.observedAt) || typeof quota.observedAt === 'string' && Number.isFinite(Date.parse(quota.observedAt)))) {
    throw new Error('google_antigravity_quota_invalid: the broker did not report valid Antigravity quota');
  }
  for (const group of Object.values(quota.summary?.groups ?? {})) {
    if (group.windows && (!Array.isArray(group.windows) || group.windows.some(window => !['5h', 'weekly'].includes(window.window)
      || !Number.isFinite(window.remainingFraction) || window.remainingFraction < 0 || window.remainingFraction > 1 || !validDate(window.resetTime)))) {
      throw new Error('google_antigravity_quota_invalid: the broker reported invalid quota windows');
    }
  }
  return quota;
}

/** Respect both a model's own allowance and the shared windows that the provider associates with it. */
export function exhaustedGoogleModel(quota: GoogleQuota, id: string): { exhausted: boolean; resetAt?: string | null } {
  const model = quota.models.find(model => model.id === id);
  if (!model) throw new Error(`google_antigravity_model_unavailable: the broker did not report quota for ${id}`);
  const group = quota.summary?.perModel?.find(row => row.modelId === id || row.modelId === model.nativeModel || row.modelId === model.nativeModel?.replace(/^antigravity-/, ''))?.group;
  const empty = group ? quota.summary?.groups?.[group]?.windows?.filter(window => window.remainingFraction === 0) ?? [] : [];
  const resetAt = empty.map(window => window.resetTime).filter((time): time is string => !!time).sort().at(-1) ?? model.resetAt ?? quota.resetAt;
  return { exhausted: quota.exhausted || model.remainingFraction === 0 || empty.length > 0, resetAt };
}

/** The broker coalesces requests and refreshes its live subscription reading at least once a minute. */
export async function googleQuota(port: number, fetchImpl: Fetch = fetch): Promise<GoogleQuota> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/antigravity/quota`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`google_antigravity_quota_unavailable: HTTP ${response.status}`);
  return parseGoogleQuota(await response.json());
}

export function parseGoogleUsage(value: unknown, at: number): UsageSample[] {
  const quota = parseGoogleQuota(value);
  const readingAt = typeof quota.observedAt === 'number' ? quota.observedAt : Date.parse(quota.observedAt);
  // Effort variants share one native-model quota. Do not count their capacity three times,
  // or assign a five-hour/weekly window that the provider has not reported.
  const models = new Map<string, GoogleQuota['models'][number]>();
  for (const model of quota.models) {
    const id = model.id.replace(/-(high|medium|low)$/, '');
    const previous = models.get(id);
    if (!previous || model.remainingFraction != null && (previous.remainingFraction == null || model.remainingFraction < previous.remainingFraction)) models.set(id, model);
  }
  const samples: UsageSample[] = [...models].map(([id, model]) => ({
    provider: 'google', account: 'google-ultra', metric: id,
    percentLeft: model.remainingFraction == null ? null : model.remainingFraction * 100,
    resetAt: model.resetAt ? Date.parse(model.resetAt) : null, windowHours: null, readingAt, at,
  }));
  for (const [name, group] of Object.entries(quota.summary?.groups ?? {})) for (const window of group.windows ?? []) {
    const label = name === 'gemini' ? 'Gemini' : name === 'non-gemini' ? 'Third-party models' : name;
    samples.push({ provider: 'google', account: 'google-ultra', metric: `${name === 'gemini' ? '' : `${label} `}${window.window === '5h' ? 'five-hour' : 'weekly'}`,
      percentLeft: window.remainingFraction * 100, resetAt: window.resetTime ? Date.parse(window.resetTime) : null,
      windowHours: window.window === '5h' ? 5 : 168, readingAt, at });
  }
  return samples;
}

export async function googleUsage(now: number, port: number): Promise<UsageSample[]> {
  return parseGoogleUsage(await googleQuota(port), now);
}
