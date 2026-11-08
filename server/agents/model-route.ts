// What a spawn may ask for: the models and thinking levels this host's subscription route really serves.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { AgentProfile, ModelProvider, PersonConfig } from '../config.js';
import { speedsOf, type Speed } from './speed.js';
import type { UsagePlan } from '../../shared/contract.js';
import { googleQuota, exhaustedGoogleModel } from '../metrics/google-usage.js';

export type Thinking = AgentProfile['thinking'];
export const THINKING_LEVELS: readonly Thinking[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export type RouteChoice = { provider: ModelProvider; model: string; thinking: Thinking[]; speeds: Speed[] };
export type RouteRefusal = { code: 'model_unavailable' | 'model_route_unavailable' | 'model_route_stale' | 'google_antigravity_exhausted'; message: string };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
/** The broker's answer for the openai-codex route (model broker src/codex-route-models.ts; deploy/acme-model-broker.mjs serveRouteModels). tiers: the service tiers above standard an account serving the model offers; a broker that doesn't list them offers none. */
type CodexRoute = { route: string; fetchedAt: string; models: { id: string; efforts: string[]; tiers?: string[] }[] };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type CatalogModel = Model<Api> & { thinkingLevelMap?: Partial<Record<Thinking, string | null>> };

/** The reasoning effort Pi's Codex provider sends for a level (openai-codex-responses buildRequest). */
function codexEffort(model: CatalogModel, level: Thinking): string | null {
  const mapped = model.thinkingLevelMap?.[level];
  if (level === 'off') return mapped === undefined ? 'none' : mapped;
  return mapped === undefined ? level : mapped;
}

/**
 * One listing per broker port, read by every spawn from memory. A listing younger than FRESH_MS is used as it is; an older
 * one is still used at once while one shared request refreshes it in the background, until it is STALE_MS old. With no
 * listing, or only a stale one, the spawn waits for a refresh of up to routeRetries tries (spawn admission timed out on a busy
 * broker under swarm load, 2026-10-28) and is refused with a typed model_route_unavailable or model_route_stale. Failures
 * are never cached. Each good listing is also written to the snapshot directory, so a restart starts with it.
 */
const FRESH_MS = 60_000;
const STALE_MS = 6 * 3600_000;
/** The tries a refresh makes; tests shorten the pauses. */
export const routeRetries: { timeoutMs: number; pauseMs: number }[] = [{ timeoutMs: 5_000, pauseMs: 0 }, { timeoutMs: 10_000, pauseMs: 500 }, { timeoutMs: 15_000, pauseMs: 1_500 }];
type RouteSlot = { value: CodexRoute | null; at: number; pending: Promise<Result<CodexRoute, RouteRefusal>> | null };
const routeSlots = new Map<number, RouteSlot>();
let snapshotDir: string | null = null;
export const forgetRouteListings = () => { routeSlots.clear(); snapshotDir = null; };
/** Where good listings are kept across restarts (the channel's data directory). */
export function keepRouteSnapshots(dir: string): void { snapshotDir = dir; }
const snapshotPath = (port: number) => snapshotDir === null ? null : join(snapshotDir, `codex-route-${port}.json`);

function loadSnapshot(port: number): RouteSlot {
  const path = snapshotPath(port);
  if (path === null) return { value: null, at: 0, pending: null };
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { at: unknown; route: unknown };
    const route = validRoute(saved.route);
    if (typeof saved.at === 'number' && route) return { value: route, at: saved.at, pending: null };
  } catch { /* no snapshot yet */ }
  return { value: null, at: 0, pending: null };
}
function saveSnapshot(port: number, route: CodexRoute, at: number): void {
  const path = snapshotPath(port);
  if (path === null) return;
  void (async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify({ at, route }));
    await rename(`${path}.tmp`, path);
  })().catch(e => console.log(JSON.stringify({ type: 'route_snapshot_not_saved', port, error: String(e) })));
}

async function codexRoute(person: PersonConfig, fetchImpl: Fetch, now: () => number = Date.now, fresh = false): Promise<Result<CodexRoute, RouteRefusal>> {
  let slot = routeSlots.get(person.brokerPort);
  if (!slot) { slot = loadSnapshot(person.brokerPort); routeSlots.set(person.brokerPort, slot); }
  const held = slot;
  const refresh = () => held.pending ??= fetchWithRetries(person, fetchImpl).then(result => {
    if (result.ok) { held.value = result.value; held.at = now(); saveSnapshot(person.brokerPort, result.value, held.at); }
    else console.log(JSON.stringify({ type: 'model_route_refresh_failed', port: person.brokerPort, listingAgeMs: held.value ? now() - held.at : null, error: result.error.message }));
    return result;
  }).finally(() => { held.pending = null; });
  const age = now() - held.at;
  if (held.value && age < FRESH_MS) return { ok: true, value: held.value };
  if (fresh && held.value && age < STALE_MS) { const result = await refresh(); return result.ok ? result : { ok: true, value: held.value }; }
  if (held.value && age < STALE_MS) { void refresh(); return { ok: true, value: held.value }; }
  const result = await refresh();
  if (result.ok || !held.value) return result;
  const hours = Math.round((now() - held.at) / 360_000) / 10;
  return { ok: false, error: { code: 'model_route_stale', message: `model_route_stale: the last list of models the subscription broker on port ${person.brokerPort} serves is ${hours} h old, older than the ${STALE_MS / 3600_000} h a spawn trusts, and refreshing it failed (${result.error.message.replace(/^model_route_unavailable: /, '')}); nothing was launched. Try again in a minute.` } };
}

async function fetchWithRetries(person: PersonConfig, fetchImpl: Fetch): Promise<Result<CodexRoute, RouteRefusal>> {
  let last: Result<CodexRoute, RouteRefusal> | null = null;
  for (const [i, attempt] of routeRetries.entries()) {
    if (attempt.pauseMs) await new Promise(resolve => setTimeout(resolve, attempt.pauseMs));
    last = await fetchCodexRoute(person, fetchImpl, attempt.timeoutMs);
    if (last.ok) return last;
    if (i === routeRetries.length - 1) break;
  }
  return { ok: false, error: { ...last!.error, message: `${last!.error.message} (${routeRetries.length} tries)` } };
}

function validRoute(body: unknown): CodexRoute | null {
  const route = body as CodexRoute;
  return Array.isArray(route?.models) && !route.models.some(m => typeof m?.id !== 'string' || !Array.isArray(m.efforts) || m.efforts.some(e => typeof e !== 'string') || (m.tiers !== undefined && (!Array.isArray(m.tiers) || m.tiers.some(t => typeof t !== 'string')))) ? route : null;
}

async function fetchCodexRoute(person: PersonConfig, fetchImpl: Fetch, timeoutMs: number): Promise<Result<CodexRoute, RouteRefusal>> {
  const url = `http://127.0.0.1:${person.brokerPort}/backend-api/codex/models`;
  const unavailable = (why: string): Result<CodexRoute, RouteRefusal> => ({ ok: false, error: { code: 'model_route_unavailable', message: `model_route_unavailable: the subscription broker on port ${person.brokerPort} did not say which models it serves (${why}); nothing was launched` } });
  let response: Response;
  try { response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { return unavailable(e instanceof Error ? e.message : String(e)); }
  const text = await response.text().catch(() => '');
  if (response.status !== 200) return unavailable(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return unavailable('the answer was not JSON'); }
  const route = validRoute(body);
  return route ? { ok: true, value: route } : unavailable('the answer had no valid models list');
}

/**
 * Every model and thinking level this host can launch for the person: catalog models of the allowed providers that the
 * subscription route serves, at the levels Pi supports for them that the route accepts. openai-codex asks the person's
 * broker, which lists what the ChatGPT accounts serve; anthropic serves the pool's granted models (the `models` list
 * the broker's listeners are provisioned from), at every level Pi supports for them.
 */
/**
 * fresh: a listing older than FRESH_MS is fetched again before answering (a failed fetch answers from it). Spawn admission
 * asks for this before refusing a model: on 2026-10-31 at 20:55Z Beta restarted onto a snapshot saved while a free-plan
 * account without Sol was pooled (the broker then listed only what every account served), and refused a Sol spawn the
 * broker already served again; the background refresh fixed the listing only after the refusal.
 */
export async function routeChoices(modelsPath: string, allowedProviders: readonly ModelProvider[], person: PersonConfig, fetchImpl: Fetch = fetch, fresh = false): Promise<Result<RouteChoice[], RouteRefusal>> {
  const source = JSON.parse(await readFile(modelsPath, 'utf8'));
  const providers = source.catalog?.providers ?? source.providers;
  const granted: unknown = source.models;
  const choices: RouteChoice[] = [];
  for (const provider of allowedProviders) {
    const catalog: CatalogModel[] = providers?.[provider]?.models ?? [];
    if (!catalog.length) continue;
    if (provider === 'anthropic' || provider === 'xai') {
      if (provider === 'xai' && person.id !== 'alice') continue;
      const grants = Array.isArray(granted) ? granted : [];
      for (const model of catalog) if (grants.includes(`${provider}/${model.id}`)) choices.push({ provider, model: model.id, thinking: getSupportedThinkingLevels(model) as Thinking[], speeds: speedsOf(provider, []) });
      continue;
    }
    if (provider === 'openrouter') {
      if (person.id === 'alice') for (const model of catalog) if (model.id === 'stealth/crouton-alpha') choices.push({ provider, model: model.id, thinking: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], speeds: ['normal'] });
      continue;
    }
    if (provider === 'google-cli') {
      if (person.id === 'alice') for (const model of catalog) choices.push({ provider, model: model.id, thinking: [model.id.split('-').at(-1) as Thinking], speeds: ['normal'] });
      continue;
    }
    if (provider === 'nvidia') {
      if (person.id === 'alice') for (const model of catalog) choices.push({ provider, model: model.id, thinking: getSupportedThinkingLevels(model) as Thinking[], speeds: ['normal'] });
      continue;
    }
    const route = await codexRoute(person, fetchImpl, Date.now, fresh);
    if (!route.ok) return route;
    for (const model of catalog) {
      const served = route.value.models.find(m => m.id === model.id);
      if (!served) continue;
      const thinking = (getSupportedThinkingLevels(model) as Thinking[]).filter(level => { const effort = codexEffort(model, level); return effort !== null && served.efforts.includes(effort); });
      if (thinking.length) choices.push({ provider, model: model.id, thinking, speeds: speedsOf(provider, served.tiers ?? []) });
    }
  }
  return { ok: true, value: choices };
}

const describeChoices = (choices: RouteChoice[]) => choices.length ? choices.map(c => `${c.model} (${c.thinking.join(', ')})`).join('; ') : 'none';

/** A requested model and thinking level is admitted only as the route serves it; there is no fallback to another model or level. */
export function admitModel(choices: RouteChoice[], model: string, thinking: string): Result<RouteChoice & { level: Thinking }, RouteRefusal> {
  const choice = choices.find(c => c.model === model);
  if (!choice) return { ok: false, error: { code: 'model_unavailable', message: `model_unavailable: ${model} is not served by this host's subscription route. Supported choices (model (thinking levels)): ${describeChoices(choices)}. Nothing was launched and there is no fallback; spawn again with one of these.` } };
  if (!choice.thinking.includes(thinking as Thinking)) return { ok: false, error: { code: 'model_unavailable', message: `model_unavailable: ${model} does not accept thinking ${thinking} on this host's subscription route; it accepts ${choice.thinking.join(', ')}. Supported choices (model (thinking levels)): ${describeChoices(choices)}. Nothing was launched and there is no fallback.` } };
  return { ok: true, value: { ...choice, level: thinking as Thinking } };
}

/** Availability is operational state, not a model listing: every Grok admission reads it anew. */
export function xaiAvailability(body: unknown): NonNullable<UsagePlan['availability']> | null {
  const value = (body as { providers?: { xai?: NonNullable<UsagePlan['availability']> } })?.providers?.xai;
  return value && typeof value.available === 'boolean' && typeof value.exhausted === 'boolean'
    && (value.percentLeft == null || typeof value.percentLeft === 'number' && Number.isFinite(value.percentLeft) && value.percentLeft >= 0 && value.percentLeft <= 100)
    && (value.reason === null || typeof value.reason === 'string')
    && (value.resetAt === null || typeof value.resetAt === 'string' && Number.isFinite(Date.parse(value.resetAt)))
    && (value.nextProbeAt === null || typeof value.nextProbeAt === 'string' && Number.isFinite(Date.parse(value.nextProbeAt))) ? value : null;
}

/** Read the selected provider’s live availability; other providers never depend on these endpoints. */
export async function admitProviderAvailability(choice: RouteChoice, person: PersonConfig, fetchImpl: Fetch = fetch): Promise<Result<RouteChoice, RouteRefusal>> {
  if (choice.provider === 'google-cli') {
    try {
      const quota = await googleQuota(person.brokerPort, fetchImpl);
      const availability = exhaustedGoogleModel(quota, choice.model);
      if (availability.exhausted) {
        const { resetAt } = availability;
        return { ok: false, error: { code: 'google_antigravity_exhausted', message: `google_antigravity_exhausted: ${choice.model} has no Antigravity subscription quota${resetAt ? `; resets at ${resetAt}` : ''}. Nothing was launched or changed; choose another model.` } };
      }
      if (!quota.available) throw new Error(quota.error ?? 'the Antigravity subscription is unavailable');
      return { ok: true, value: choice };
    } catch (error) {
      return { ok: false, error: { code: 'model_route_unavailable', message: `model_route_unavailable: Antigravity quota could not be read (${error instanceof Error ? error.message : String(error)}); nothing was launched or changed` } };
    }
  }
  if (choice.provider !== 'xai') return { ok: true, value: choice };
  const refuse = (reason: string): Result<RouteChoice, RouteRefusal> => ({ ok: false, error: {
    code: 'model_unavailable', message: `model_unavailable: ${choice.model} is unavailable: ${reason}. Nothing was launched or changed; choose another model.`,
  } });
  try {
    const response = await fetchImpl(`http://127.0.0.1:${person.brokerPort}/v1/availability`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return refuse(`Grok availability could not be read (HTTP ${response.status})`);
    const availability = xaiAvailability(await response.json());
    if (!availability) return refuse('the broker did not report valid Grok availability');
    if (!availability.available) return refuse(`${availability.reason ?? 'the Grok subscription is unavailable'}${availability.resetAt ? `; resets at ${availability.resetAt}` : ''}${availability.nextProbeAt ? `; next probe at ${availability.nextProbeAt}` : ''}`);
    return { ok: true, value: choice };
  } catch (error) { return refuse(`Grok availability could not be read (${error instanceof Error ? error.message : String(error)})`); }
}
