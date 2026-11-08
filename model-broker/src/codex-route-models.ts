// GET /backend-api/codex/models on a listener: the Codex models its granted ChatGPT accounts really serve, with the
// reasoning efforts each accepts and the service tiers (speeds above standard: "priority" is Codex's Fast, "ultrafast")
// at least one serving account offers (none when the listener is granted no Codex account). Kenan Stack admits worker spawns against this answer (server/agents/model-route.ts);
import type { ServerResponse } from "node:http";
import { imageAuth } from "./image-service.js";

export const CODEX_ROUTE_MODELS_PATH = "/backend-api/codex/models";
export type RouteModel = { id: string; efforts: string[]; tiers: string[] };
export type RouteModelsLimits = { ttlMs: number; keepMs: number; timeoutMs: number; clientVersion: string };
/** chatgpt.com filters the list by client_version against each model's minimal_client_version; ask as a new client. */
export const ROUTE_MODELS: RouteModelsLimits = { ttlMs: 5 * 60_000, keepMs: 6 * 60 * 60_000, timeoutMs: 12_000, clientVersion: "99.0.0" };
type Credential = import("@earendil-works/pi-ai").ModelAuth;
type Transport = (url: string, init: RequestInit) => Promise<Response>;
type Answer = { ok: true; id: string; value: RouteModel[] } | { ok: false; error: string };
/** True when this account has refused this model (auth/model-entitlement.ts); such an account doesn't count as serving it. */
type Refused = (accountId: string, model: string) => boolean;
type Listed = { id: string; value: RouteModel[] };
type State = { value: Listed[] | null; at: number; key: string; pending: Promise<void> | null; failure: string | null };

export function parseRouteModels(value: unknown): RouteModel[] | null {
  const models = (value as { models?: unknown })?.models;
  if (!Array.isArray(models)) return null;
  return models.flatMap(m => typeof m?.slug === "string" && Array.isArray(m.supported_reasoning_levels)
    ? [{ id: m.slug, efforts: m.supported_reasoning_levels.flatMap((l: any) => typeof l?.effort === "string" ? [l.effort] : []),
      tiers: Array.isArray(m.service_tiers) ? m.service_tiers.flatMap((t: any) => typeof t?.id === "string" ? [t.id] : []) : [] }] : []);
}

async function accountModels(id: string, resolve: (id: string, signal: AbortSignal) => Promise<Credential>, transport: Transport, limits: RouteModelsLimits): Promise<Answer> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  try {
    const authorized = imageAuth(await resolve(id, signal) as any, "codex");
    if (!authorized.ok) return { ok: false, error: `${id}: ${authorized.error.message}` };
    const headers = authorized.value.headers; headers.set("accept", "application/json");
    const response = await transport(`https://chatgpt.com/backend-api/codex/models?client_version=${limits.clientVersion}`, { method: "GET", headers, signal });
    if (response.status !== 200) { await response.body?.cancel(); return { ok: false, error: `${id}: upstream_status_${response.status}` }; }
    const models = parseRouteModels(await response.json());
    return models ? { ok: true, id, value: models } : { ok: false, error: `${id}: upstream_models_malformed` };
  } catch (error) {
    return { ok: false, error: `${id}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Read at answer time, so a refusal recorded after the lists were fetched counts at once. */
export function servedModels(lists: Listed[], grantedModels: string[], refused: Refused): RouteModel[] {
  const ids = [...new Set(lists.flatMap(a => a.value.map(m => m.id)))].filter(id => grantedModels.includes(`openai-codex/${id}`));
  return ids.flatMap(id => {
    const serving = lists.flatMap(a => a.value.filter(m => m.id === id && !refused(a.id, id)));
    if (!serving.length) return [];
    // A tier counts while one serving account offers it: the broker sends a tiered request only to accounts that offer it.
    return [{ id, efforts: serving[0]!.efforts.filter(e => serving.every(m => m.efforts.includes(e))), tiers: [...new Set(serving.flatMap(m => m.tiers))] }];
  });
}

/**
 * One cache per listener. Answers from the cached list while it is younger than keepMs and refreshes it in the background
 * once older than ttlMs; only a cold or expired cache (or a changed account/model grant) waits for the upstream. A model
 * counts when the listener is granted it and at least one account that answered lists it and hasn't refused it, with the
 * efforts all such accounts accept: the broker routes each request only to accounts that serve its model, so one account
 * losing a model never hides it while another still serves it .
 */
export function codexRouteModels(transport: Transport, limits: RouteModelsLimits = ROUTE_MODELS, now: () => number = Date.now) {
  const states = new Map<string, State>();
  return async (res: ServerResponse, principal: string, accounts: string[], grantedModels: string[], resolve: (id: string, signal: AbortSignal) => Promise<Credential>, refused: Refused) => {
    const key = JSON.stringify([accounts, grantedModels]);
    let state = states.get(principal);
    if (!state || state.key !== key) { state = { value: null, at: 0, key, pending: null, failure: null }; states.set(principal, state); }
    const s = state;
    const usable = () => s.value !== null && now() - s.at <= limits.keepMs;
    if (!accounts.length) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ route: "chatgpt-codex", fetchedAt: new Date(now()).toISOString(), models: [] }));
      return;
    }
    if (!usable() || now() - s.at > limits.ttlMs) {
      s.pending ??= (async () => {
        const answers = await Promise.all(accounts.map(id => accountModels(id, resolve, transport, limits)));
        const lists = answers.flatMap(a => a.ok ? [a] : []);
        if (!lists.length) { s.failure = answers.map(a => a.ok ? "" : a.error).join("; "); return; }
        s.value = lists.map(a => ({ id: a.id, value: a.value }));
        s.at = now(); s.failure = null;
      })().finally(() => { s.pending = null; });
      if (!usable()) await s.pending;
    }
    if (!usable()) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `route_models_unavailable: ${s.failure ?? "no account answered the upstream models list"}`, type: "model_broker_error", code: "route_models_unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ route: "chatgpt-codex", fetchedAt: new Date(s.at).toISOString(), models: servedModels(s.value!, grantedModels, refused) }));
  };
}
