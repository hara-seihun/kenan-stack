import { installBrokerNetworking, isConnectFailure, retryConnect } from "./broker-network.js";
import { brokerErrorDiagnostic } from "./broker-error-diagnostic.js";
import { setDefaultResultOrder, getDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily, getDefaultAutoSelectFamily } from "node:net";
import { CacheDiffer } from "./cache-diff.js";
import { ORCHESTRATOR_CATALOG } from "./catalog.js";
import { ExperimentCustody, validExperimentPolicy, type ExperimentPolicy, type ExperimentAttempt } from "./experiment-custody.js";
import { createHash, randomUUID } from "node:crypto";
import { CODEX_ROUTE_MODELS_PATH, codexRouteModels } from "./codex-route-models.js";
import { allowanceRefusal, BROKER_USAGE_PATH, brokerUsageAcrossStores, BrokerUsageThread, WeeklyAllowances, type BrokerUsageJob } from "./broker-usage.js";
import { weekResetsAt } from "./person-usage.js";
import { zstdDecompressSync } from "node:zlib";
import { once } from "node:events";
import cluster from "node:cluster";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Server as NetServer } from "node:net";
import { modelsWithCustomDefinitions } from "./models.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createParser } from "eventsource-parser";
import { Store } from "./store.js";
import { ServedModelWatch, servedModelOf } from "./served-model.js";
import { CompletionService, completionModel } from "./completion.js";
import { COMPLETION_OPENAPI } from "./completion-openapi.js";
import type { CompletionOutcome, CompletionRecord } from "./completion-contract.js";
interface ProviderController { store: Store; completions: CompletionService; tick(): unknown }
import { completionHttpStatus, isCompletionInput, isCompletionRequestId } from "./completion-contract.js";
import { modelDrainsMeter } from "./catalog.js";
import { claudeCooldownRefusal, claudeWeeklyPool } from "./auth/claude-cooldown.js";
import { allowsAccountUse, type UsageComponent } from "./domain.js";
import { imageAuth } from "./image-service.js";
import { chooseInteractiveAccount, eligibleInteractiveAccounts, interactiveQuotaExhausted, shouldLeaveRetained } from "./auth/account-selection.js";
import { candidateSummary, routeBackground } from "./auth/background-routing.js";
import { accountModelExcluded, noEntitledAccountError, recordAccountModelUnsupported } from "./auth/model-entitlement.js";
import { codexTierExclusions } from "./auth/codex-capabilities.js";
import { modelSpeedModes } from "./threads/speed.js";
import { providerOAuth } from "./auth/shared-oauth.js";
import { repairProviderCredential, providerResponseFailure, quarantineProviderCredential, isIdentityVerificationRequired } from "./auth/provider-rejection.js";
import { isRejectedTokenError } from "./provider-errors.js";
import { BROKER_ROUTES, validateBrokerBody, type BrokerFamily } from "./model-broker-contract.js";
import { anthropicMeterReadings } from "./extension/usage-logger.js";
import { AnthropicMeterSampler } from "./meters-anthropic.js";
import { CodexMeterSampler } from "./meters-codex.js";
import { creditFunded } from "./codex-resets.js";
import { AnthropicThreads, ReplyRecorder, type ThreadAttempt } from "./anthropic-threads.js";
import { recordMeterOutcomes } from "./meter-outcomes.js";
import { forwardVoiceRequest } from "./voice-broker.js";
import { attachMeetRecognitionBroker } from "./meet-recognition-broker.js";

import { ModelAvailabilityStore, modelAvailabilityPath, sharedModelRefusal, type SharedModelRefusal } from "./threads/model-availability.js";
/** A conversation is checked against its account's pace at most every 30 minutes, and stays put 2 hours after moving. */
const PACE_CHECK_MS = 30 * 60_000;
const METER_POLL_TICK_MS = 60_000;
const PACE_SETTLE_MS = 2 * 3_600_000;

export interface BrokerListener {
  principal: string;
  port: number;
  accounts: string[];
  models: string[];
  maxInFlight: number;
  /** Most this principal may spend in any trailing seven days, in subscription dollars. */
  weeklyUsd?: number;
  /** Set: Claude requests from this principal are refused while the Claude weekly pool has less than this percent left (or can't be read). Unset: no cool-down. */
  claudeWeeklyFloorPercent?: number;
  /** Percent of this principal's Claude conversations (chosen by conversation) sent as Anthropic message threads. Unset: 100. */
  anthropicThreadsPercent?: number;
}
export interface ModelBrokerConfig {
  ledgerPath: string;
  authPath: string;
  listeners: BrokerListener[];
  grantOwner?: string;
  experimentPolicy?: ExperimentPolicy;
  /** Set: requests marked x-kenan-work-class: background use use-it-or-lose-it routing (auth/background-routing.ts). Unset: they route like any other. */
  backgroundRouting?: { fiveHourReservePercent: number };
  /** Set: a response from a model other than the requested one also writes a host alert in this directory. Unset: it is only logged. */
  servedModelAlertDir?: string;
  /** Set true: when a Codex account's weekly window reaches 100%, the meter poll redeems its banked reset credit that expires first. Unset: no automatic redemption. */
  codexAutoReset?: boolean;
}
/** An exhausted account stays out of routing until the next reading shows a reset, so readings are a minute apart. */
const CODEX_METER_INTERVAL_MS = 50_000;
export function validateBrokerConfig(value: unknown): value is ModelBrokerConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as ModelBrokerConfig;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.length > 0 && items.every(item => typeof item === "string" && item.length > 0);
  return typeof config.ledgerPath === "string" && config.ledgerPath.startsWith("/")
    && typeof config.authPath === "string" && config.authPath.startsWith("/")
    && (config.grantOwner === undefined || typeof config.grantOwner === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(config.grantOwner))
    && (config.experimentPolicy === undefined || validExperimentPolicy(config.experimentPolicy))
    && (config.servedModelAlertDir === undefined || typeof config.servedModelAlertDir === "string" && config.servedModelAlertDir.startsWith("/"))
    && (config.codexAutoReset === undefined || typeof config.codexAutoReset === "boolean")
    && (config.backgroundRouting === undefined || typeof config.backgroundRouting === "object" && config.backgroundRouting !== null
      && Object.keys(config.backgroundRouting).length === 1 && typeof config.backgroundRouting.fiveHourReservePercent === "number"
      && config.backgroundRouting.fiveHourReservePercent >= 0 && config.backgroundRouting.fiveHourReservePercent <= 100)
    && Array.isArray(config.listeners) && config.listeners.length > 0
    && config.listeners.every(listener => listener && /^[a-z_][a-z0-9_-]*$/.test(listener.principal)
      && Number.isInteger(listener.port) && listener.port > 1023 && listener.port <= 65535
      && strings(listener.accounts) && strings(listener.models)
      && listener.models.every(model => /^(openai-codex|anthropic|xai)\/[^/]+$/.test(model))
      && Number.isInteger(listener.maxInFlight) && listener.maxInFlight > 0
      && (listener.weeklyUsd === undefined || (typeof listener.weeklyUsd === "number" && Number.isFinite(listener.weeklyUsd) && listener.weeklyUsd >= 0))
      && (listener.claudeWeeklyFloorPercent === undefined || (typeof listener.claudeWeeklyFloorPercent === "number" && listener.claudeWeeklyFloorPercent >= 0 && listener.claudeWeeklyFloorPercent <= 100))
      && (listener.anthropicThreadsPercent === undefined || (typeof listener.anthropicThreadsPercent === "number" && listener.anthropicThreadsPercent >= 0 && listener.anthropicThreadsPercent <= 100)))
    && new Set(config.listeners.map(listener => listener.port)).size === config.listeners.length
    && new Set(config.listeners.map(listener => listener.principal)).size === config.listeners.length;
}

/** Honor provider delay without silently shortening a long quota reset. */
export function brokerRetryDelay(headers: Headers, attempt: number, now = Date.now()): number {
  const milliseconds = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  const value = headers.get("retry-after");
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 1000 * 2 ** attempt;
}
const MAX_BODY = 64 * 1024 * 1024;
const scoped = (principal: string, value: unknown) => createHash("sha256").update(`${principal}\0${String(value ?? "")}`).digest("hex");
const MAX_TRANSPORT_RETRIES = 3;
const TRANSPORT_RETRY_MS = 750;

/** fetch rejects with a TypeError whose cause is the socket, TLS, DNS or timeout failure; nothing reached the client yet. */
export const isTransportFailure = (error: unknown): boolean => error instanceof TypeError && error.cause instanceof Error;

/** Bounded diagnostics without provider messages, URLs, request data or credentials. */
export const describeError = (error: unknown): string => JSON.stringify(brokerErrorDiagnostic(error));

/** retryAt (epoch ms) is the moment a hold lifts; a worker that gets it in the body parks until then instead of ending. */
const json = (res: ServerResponse, status: number, error: string, code?: string, retryAt?: number) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: error, type: "model_broker_error", ...(code === undefined ? {} : { code }), ...(retryAt === undefined ? {} : { retry_at: retryAt }) } }));
};

/**
 * A zstd body may expand past MAX_BODY. 2026-10-31 04:16Z: a Codex request carrying 37 inline images (71 MB of base64,
 * about 53 MB compressed) overflowed the decompression limit and was answered "Invalid JSON", so the agent could not
 * tell it was a size problem. Too large is now its own typed 413.
 */
export function decodeRequestBody(bytes: Buffer, encoding: string | undefined):
  { ok: true; bytes: Buffer } | { ok: false; status: 400 | 413; code: string; message: string } {
  if (encoding !== "zstd") return { ok: true, bytes };
  try { return { ok: true, bytes: zstdDecompressSync(bytes, { maxOutputLength: MAX_BODY }) }; }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      return { ok: false, status: 413, code: "request_too_large", message: `Model request exceeds ${MAX_BODY / 1024 / 1024} MiB once decompressed (${bytes.length} bytes compressed). Send fewer or smaller images.` };
    return { ok: false, status: 400, code: "invalid_encoding", message: `Request body is not valid zstd: ${(error as Error).message}` };
  }
}

const refuseModel = (res: ServerResponse, refusal: SharedModelRefusal) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(completionHttpStatus(refusal.code), { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { ...refusal, type: "model_broker_error" } }));
};

interface DispatchReceipt {
  id: string; requestId: string; principal: string; accountId: string; model: string;
  serviceTier: string; at: number; updatedAt: number; httpStatus?: number;
  outcome: "dispatched" | "accepted" | "rejected" | "completed" | "incomplete" | "failed" | "cancelled" | "indeterminate";
}

export type BrokerTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface RetainedCompletionOwner {
  id: string;
  store: Store;
  controller?: ProviderController;
}
interface CompletionAlias { state: "adopting" | "ready"; ownerId: string; requestId: string }
export type BrokerRequestAuthorization = { ok: true } | { ok: false; status: 403 | 503; message: string };
export type BrokerRequestAuthority = (principal: string, request: IncomingMessage) => Promise<BrokerRequestAuthorization>;
export interface EmbeddedBrokerOptions {
  store: Store;
  authorizeRequest?: BrokerRequestAuthority;
  /** Core publishes complete original owner partitions with their exact footprints. */
  grantPublication?: { kind: "borrowed" };
  controller?: ProviderController;
  completionOwners?: readonly RetainedCompletionOwner[];
}
export function createModelBroker(config: ModelBrokerConfig, availability: ModelAvailabilityStore, transport: BrokerTransport = fetch, embedded?: EmbeddedBrokerOptions) {
  const store = embedded?.store ?? Store.open(config.ledgerPath);
  if (store.path !== config.ledgerPath) {
    const actual = statSync(store.path, { bigint: true }), configured = statSync(config.ledgerPath, { bigint: true });
    if (actual.dev !== configured.dev || actual.ino !== configured.ino) throw new Error("Broker store differs from its configured ledger custody");
  }
  if (embedded?.controller && embedded.controller.store !== store) throw new Error("Broker and provider controller must share one Store");
  // Grants are desired state the broker owns for every declared ledger consumer.
  // Reloading the grant file republishes them for retained and new completion custody.
  const servedModels = new ServedModelWatch(config.servedModelAlertDir);
  const threads = new AnthropicThreads();
  const cacheDiffer = new CacheDiffer();
  const threadPercent = new Map(config.listeners.map(listener => [listener.principal, listener.anthropicThreadsPercent ?? 100]));
  const grants = new Map(config.listeners.map(listener => [listener.principal, { accounts: listener.accounts, models: listener.models, weeklyUsd: listener.weeklyUsd, claudeWeeklyFloorPercent: listener.claudeWeeklyFloorPercent }]));
  const completionOwners = new Map<string, { store: Store; service: CompletionService; controller?: ProviderController }>();
  completionOwners.set("current", { store, service: embedded?.controller?.completions ?? new CompletionService(store, process.cwd()), controller: embedded?.controller });
  for (const owner of embedded?.completionOwners ?? []) {
    if (!/^[A-Za-z0-9._-]+$/.test(owner.id) || completionOwners.has(owner.id) || [...completionOwners.values()].some(value => value.store.path === owner.store.path)) throw new Error("Retained completion owner must have a unique declared identity and ledger");
    if (owner.controller && owner.controller.store !== owner.store) throw new Error("Retained completion controller has different ledger custody");
    completionOwners.set(owner.id, { store: owner.store, service: owner.controller?.completions ?? new CompletionService(owner.store, process.cwd()), controller: owner.controller });
  }
  const allowanceLedgers = [...completionOwners.values()].map(owner => new WeeklyAllowances(owner.store));
  const allowances = { spent: (principal: string, maxAgeMs?: number) => allowanceLedgers.reduce((total, owner) => total + owner.spent(principal, maxAgeMs), 0) };
  const overAllowance = (principal: string) => {
    const weeklyUsd = grants.get(principal)!.weeklyUsd;
    if (weeklyUsd === undefined) return null;
    const used = allowances.spent(principal);
    return used >= weeklyUsd ? allowanceRefusal(weeklyUsd) : null;
  };
  /**
   * Last /v1/usage answer per principal. Answers are computed on the usage thread (a week of ledger rows; see
   * BrokerUsageThread) for every granted principal from start-up and every USAGE_REFRESH_MS, so a poll is served from
   * memory and never waits for a scan; only an answer older than USAGE_STALE_MS (a broken thread) is waited for.
   */
  const usageThread = new BrokerUsageThread();
  // Answers are also kept in the ledger, so a new generation serves its predecessor's answers while its own thread
  // is still reading the week (a cold read took over a minute on 2026-10-31 and failed the install health check).
  const USAGE_ANSWER_KEY = "broker-usage-answer:";
  const usageAnswers = new Map<string, { body: string; at: number }>(
    (store.db.prepare("SELECT key, value FROM control WHERE key >= ? AND key < ?").all(USAGE_ANSWER_KEY, "broker-usage-answer;") as { key: string; value: string }[])
      .map(row => [row.key.slice(USAGE_ANSWER_KEY.length), JSON.parse(row.value) as { body: string; at: number }]));
  const usageRuns = new Map<string, Promise<string>>();
  const USAGE_REFRESH_MS = 30_000, USAGE_STALE_MS = 30 * 60_000;
  const refreshUsage = (principal: string): Promise<string> => {
    const running = usageRuns.get(principal);
    if (running) return running;
    const grant = grants.get(principal);
    if (!grant) return Promise.reject(new Error("Principal has no model grant"));
    const stores = [...completionOwners.values()].map(owner => owner.store);
    const job: BrokerUsageJob = { ledgers: stores.map(owner => owner.path), principal, accounts: [...grant.accounts], now: Date.now(),
      allowance: grant.weeklyUsd === undefined ? null : { weeklyUsd: grant.weeklyUsd, usedUsd: allowances.spent(principal), resetsAt: new Date(weekResetsAt()).toISOString() } };
    // An in-memory ledger (tests, embedded hosts) has no file another thread could open.
    const work = (job.ledgers.includes(":memory:")
      ? Promise.resolve().then(() => JSON.stringify(brokerUsageAcrossStores(stores, principal, job.accounts, job.now, job.allowance)))
      : usageThread.compute(job))
      .then(body => {
        const answer = { body, at: Date.now() };
        usageAnswers.set(principal, answer);
        store.setControl(USAGE_ANSWER_KEY + principal, JSON.stringify(answer));
        return body;
      })
      .finally(() => usageRuns.delete(principal));
    usageRuns.set(principal, work);
    return work;
  };
  const refreshAllUsage = () => {
    for (const principal of grants.keys()) refreshUsage(principal).catch(error =>
      console.error(`Model broker usage refresh failed for ${principal}: ${describeError(error)}`));
  };
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  const publish = () => {
    if (embedded?.grantPublication?.kind === "borrowed") return;
    for (const owner of completionOwners.values()) owner.store.publishBrokerGrants([...grants].map(([principal, grant]) => ({ principal, ...grant })), config.grantOwner);
  };
  const mappedOwner = (principal: string, requestId: string) => {
    const ownedId = `broker-${scoped(principal, requestId)}`;
    const encoded = store.control(`completion-alias:${ownedId}`);
    if (!encoded) return { id: ownedId, owner: completionOwners.get("current")! };
    const alias = JSON.parse(encoded) as CompletionAlias;
    const owner = completionOwners.get(alias.ownerId);
    if (alias.state !== "ready" || !owner || !isCompletionRequestId(alias.requestId)) return undefined;
    return { id: alias.requestId, owner };
  };
  const providers = new Map(builtinProviders().filter(provider => provider.id in BROKER_ROUTES).map(provider => [provider.id, provider]));
  const auth = new Map([...providers].map(([id, provider]) => [id, providerOAuth(provider, config.authPath)]));
  const routeModels = codexRouteModels(transport);
  // Response headers only report accounts that are serving requests; an account the router is not using would keep a frozen
  // reading and pace routing would be blind to it. Standalone, the broker polls every account's usage itself; embedded, its
  // provider controller does.
  const meterSamplers = embedded?.controller ? [] : [
    new AnthropicMeterSampler(store, { auth: auth.get("anthropic")! }),
    new CodexMeterSampler(store, { auth: auth.get("openai-codex")!, meters: ORCHESTRATOR_CATALOG.meters.filter(meter => meter.provider === "openai-codex"), autoReset: config.codexAutoReset === true, intervalMs: CODEX_METER_INTERVAL_MS,
      // An injected transport (tests) carries the meter polls too, so nothing reaches chatgpt.com with a fixture token.
      ...(transport === fetch ? {} : { fetch: transport as typeof fetch }) }),
  ];
  let meterPoll: ReturnType<typeof setInterval> | undefined;
  let meterPolling = false;
  const pollMeters = async () => {
    if (!meterSamplers.length || retiring || meterPolling) return;
    meterPolling = true;
    try {
      const samples = (await Promise.all(meterSamplers.map(sampler => sampler.sample(Date.now(), shutdown.signal)))).flat();
      if (!retiring) recordMeterOutcomes(store, samples);
    } finally { meterPolling = false; }
  };
  const experiments = config.experimentPolicy ? new ExperimentCustody(store, config.experimentPolicy) : undefined;
  const experimentCancels = new Map<string, AbortController>();
  const active = new Set<Promise<void>>();
  const inflight = new Map<string, number>();
  const sticky = new Map<string, string>();
  const paceCheckAt = new Map<string, number>();
  const shutdown = new AbortController();
  const servers: Server[] = [];
  let draining = false;
  let retiring = false;
  let closed: Promise<void> | undefined;
  let listening: Promise<number[]> | undefined;
  // The last 128 Codex dispatches per principal, for GET /v1/dispatches. Kept in memory: rewriting them into the ledger
  // cost three 40 kB commits per request on the event loop (2026-10-31), and nothing reads them across generations.
  const dispatchLog = new Map<string, DispatchReceipt[]>();
  const dispatches = (principal: string): DispatchReceipt[] => dispatchLog.get(principal) ?? [];
  const saveDispatch = (receipt: DispatchReceipt) => {
    receipt.updatedAt = Date.now();
    const log = dispatchLog.get(receipt.principal) ?? [];
    if (!log.includes(receipt)) { log.push(receipt); if (log.length > 128) log.shift(); }
    dispatchLog.set(receipt.principal, log);
  };

  const request = async (listener: BrokerListener, req: IncomingMessage, res: ServerResponse) => {
    const grant = grants.get(listener.principal)!;
    if((req.headers['x-pi-experiment-id']!==undefined || req.headers['x-pi-logical-request-id']!==undefined) && req.url!==BROKER_ROUTES['openai-codex'].path){json(res,400,'Tagged scientific requests require the counted Codex ingress','experiment_route_invalid');return;}
    const experimentRoute = /^\/v1\/experiments\/([A-Za-z0-9._-]+)(?:\/(stop|requests\/[^/?]+))?$/.exec(req.url ?? '');
    if (experimentRoute) {
      const reply = (status:number,value:unknown) => {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
      if (!experiments || listener.principal!==experiments.policy.principal || experimentRoute[1]!==experiments.policy.experimentId) {json(res,403,'Experiment is not admitted by the owning root policy','experiment_not_admitted');return;}
      if(req.method==='GET' && !experimentRoute[2]){const r=experiments.summary();reply(r?200:404,r??{error:{code:'experiment_not_registered'},policy:experiments.policy});return;}
      if(req.method==='GET' && experimentRoute[2]?.startsWith('requests/')){let logical:string;try{logical=decodeURIComponent(experimentRoute[2]!.slice(9));}catch{json(res,400,'Invalid logical ID encoding','experiment_logical_id_invalid');return;}const r=experiments.get()?.attempts.find(a=>a.logicalId===logical);reply(r?200:404,r??{error:{code:'experiment_request_unset'}});return;}
      if(req.method==='POST' && experimentRoute[2]==='stop'){const result=experiments.stop();for(const cancel of experimentCancels.values())cancel.abort();reply(result.ok?200:409,result);return;}
      if(req.method==='PUT' && !experimentRoute[2]){
        try{let n=0;const chunks:Buffer[]=[];for await(const chunk of req){n+=chunk.length;if(n>4096){json(res,413,'Binding exceeds4096 bytes');return;}chunks.push(Buffer.from(chunk));}const result=experiments.register(JSON.parse(Buffer.concat(chunks).toString('utf8')));reply(result.ok?200:409,result);}catch{json(res,400,'Invalid experiment binding','experiment_binding_invalid');}return;
      }
      json(res,405,'Unsupported experiment operation');return;
    }
    if (req.method === "GET" && req.url === "/v1/dispatches") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ dispatches: dispatches(listener.principal) }));
      return;
    }
    if (req.url?.startsWith("/v1/voice/")) {
      const count = inflight.get(listener.principal) ?? 0;
      if (count >= listener.maxInFlight) { json(res, 503, "Your shared request limit is full"); return; }
      inflight.set(listener.principal, count + 1);
      try {
        await forwardVoiceRequest(listener.principal, req, res, shutdown.signal, transport);
      } finally {
        inflight.set(listener.principal, (inflight.get(listener.principal) ?? 1) - 1);
      }
      return;
    }
    if (req.method === "GET" && req.url === BROKER_USAGE_PATH) {
      const cached = usageAnswers.get(listener.principal);
      let body: string;
      if (cached && Date.now() - cached.at < USAGE_STALE_MS) body = cached.body;
      else {
        try { body = await refreshUsage(listener.principal); }
        catch (error) { console.error(`Model broker usage failed for ${listener.principal}: ${describeError(error)}`); json(res, 500, "Usage is unavailable"); return; }
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/v1/completions/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(COMPLETION_OPENAPI));
      return;
    }
    const completionRoute = /^\/v1\/completions\/([^/?]+)(\/(?:cancel|retry|attempts))?$/.exec(req.url ?? "");
    if (completionRoute) {
      const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const error = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
      let requestId: string;
      try { requestId = decodeURIComponent(completionRoute[1]!); }
      catch { return error(400, "invalid-request", "Invalid completion request ID encoding."); }
      if (!isCompletionRequestId(requestId)) return error(400, "invalid-request", "Invalid completion request ID.");
      const mapped = mappedOwner(listener.principal, requestId);
      if (!mapped) return error(503, "invalid-state", "Completion custody adoption is unfinished or its declared ledger owner is unavailable; reuse this ID after reconciliation.");
      const ownedId = mapped.id, completions = mapped.owner.service;
      const outcomeReply = (outcome: CompletionOutcome<CompletionRecord>, status = 200) => outcome.ok
        ? reply(status, { ...outcome.value, requestId })
        : error(completionHttpStatus(outcome.error.code), outcome.error.code, outcome.error.message);
      if (req.method === "GET" && completionRoute[2] === "/attempts") {
        const attempts = completions.attempts(ownedId);
        return attempts ? reply(200, { attempts }) : error(404, "not-found", "Completion not found.");
      }
      if (req.method === "POST" && completionRoute[2] === "/cancel") {
        const outcome = completions.cancel(ownedId);
        mapped.owner.controller?.tick();
        return outcomeReply(outcome);
      }
      if (req.method === "POST" && completionRoute[2] === "/retry") return outcomeReply(completions.retry(ownedId));
      if (req.method === "GET" && !completionRoute[2]) {
        const record = completions.get(ownedId);
        return record ? reply(200, { ...record, requestId }) : error(404, "not-found", "Completion not found.");
      }
      if (req.method !== "PUT" || completionRoute[2]) return error(405, "invalid-request", "Unsupported completion operation.");
      let input: unknown;
      try {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) return error(413, "invalid-request", "Completion request exceeds 64 MiB."); chunks.push(Buffer.from(chunk)); }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { return error(400, "invalid-request", "Invalid completion JSON."); }
      if (!isCompletionInput(input)) return error(400, "invalid-request", "Invalid completion input.");
      const model = completionModel(input.model);
      if (!model) return error(400, "invalid-request", "The selected model is not in Pi's Codex catalogue.");
      const previous = completions.get(ownedId);
      if (previous) return outcomeReply(completions.submit(ownedId, input, { principal: listener.principal, accounts: grant.accounts, models: grant.models }));
      const unavailable = sharedModelRefusal(availability, `${model.provider}/${model.model}`);
      if (unavailable) return reply(completionHttpStatus(unavailable.code), { error: { code: unavailable.code, message: unavailable.message } });
      if (!grant.models.includes(`${model.provider}/${model.model}`)) return error(403, "invalid-request", "This model is not shared with your Unix account.");
      const refusal = overAllowance(listener.principal);
      if (refusal) return error(403, "invalid-state", refusal);
      const outcome = mapped.owner.store.transaction<CompletionOutcome<CompletionRecord>>(() => {
        const outstanding = [...completionOwners.values()].flatMap(owner => owner.store.db.prepare("SELECT c.value FROM control c JOIN run r ON c.key='completion:'||(SELECT value FROM control WHERE key='completion-run:'||r.id) WHERE r.state IN ('queued','starting','running')").all() as { value: string }[]).filter(row => JSON.parse(row.value).access?.principal === listener.principal).length;
        if (!completions.get(ownedId) && outstanding >= listener.maxInFlight) return { ok: false as const, error: { code: "invalid-state", message: "Your completion request limit is full." } };
        return completions.submit(ownedId, input, { principal: listener.principal, accounts: grant.accounts, models: grant.models });
      });
      return outcomeReply(outcome, 202);
    }
    if (req.method === "GET" && req.url?.split("?")[0] === CODEX_ROUTE_MODELS_PATH) {
      const codex = auth.get("openai-codex");
      const accounts = codex ? store.accounts().filter(account => account.provider === "openai-codex" && account.enabled && grant.accounts.includes(account.id) && allowsAccountUse(account, "interactive")).map(account => account.id) : [];
      await routeModels(res, listener.principal, accounts, grant.models, (id, signal) => codex!.resolve(id, signal),
        (id, model) => accountModelExcluded(store, id, model));
      return;
    }
    const family = (Object.keys(BROKER_ROUTES) as BrokerFamily[]).find(id => req.url === BROKER_ROUTES[id].path || id === "anthropic" && req.url === `${BROKER_ROUTES[id].path}?beta=true`);
    if (req.method !== "POST" || !family) { json(res, 404, "Only new model requests are available"); return; }
    if (!String(req.headers["content-type"]).startsWith("application/json")) { json(res, 415, "Expected application/json"); return; }
    const count = inflight.get(listener.principal) ?? 0;
    if (count >= listener.maxInFlight) { json(res, 503, "Your shared model request limit is full. Wait for an active request to finish."); return; }
    inflight.set(listener.principal, count + 1);
    const experimentId = req.headers['x-pi-experiment-id'];
    const logicalId = req.headers['x-pi-logical-request-id'];
    const scientific = experimentId !== undefined || logicalId !== undefined;
    if(scientific && (!experiments || listener.principal!==experiments.policy.principal || experimentId!==experiments.policy.experimentId || typeof logicalId!=='string')) {inflight.set(listener.principal,count);json(res,403,'Experiment is not admitted by the owning root policy','experiment_not_admitted');return;}
    const cancel = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, cancel.signal, AbortSignal.timeout(30 * 60_000)]);
    const disconnected = () => { if (!scientific && !res.writableFinished) cancel.abort(); };
    let experimentAttempt: ExperimentAttempt | undefined;
    let observedCharge: ExperimentAttempt['charge'] = {kind:'unknown'};
    let experimentTerminal = false;
    let experimentRates: {input:number;output:number;cacheRead:number;cacheWrite:number;tiers?:{inputTokensAbove:number;input:number;output:number;cacheRead:number;cacheWrite:number}[]} | undefined;
    res.on("close", disconnected);
    let lease: string | undefined;
    let dispatchReceipt: DispatchReceipt | undefined;
    let dispatchAttempt = 0;
    let usageReceipt: { accountId: string; model: string; tokens: Record<UsageComponent, number> } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) { json(res, 413, "Model request exceeds 64 MiB. Send fewer or smaller images.", "request_too_large"); return; }
        chunks.push(Buffer.from(chunk));
      }
      const encoding = req.headers["content-encoding"];
      if (encoding && encoding !== "identity" && encoding !== "zstd") { json(res, 415, "Unsupported request encoding"); return; }
      let body: Record<string, any>;
      let requestBytes: Buffer;
      const decoded = decodeRequestBody(Buffer.concat(chunks), encoding);
      if (!decoded.ok) { json(res, decoded.status, decoded.message, decoded.code); return; }
      requestBytes = decoded.bytes;
      try { body = JSON.parse(requestBytes.toString("utf8")); }
      catch { json(res, 400, "Invalid JSON"); return; }
      const invalid = validateBrokerBody(family, body);
      if (invalid) { json(res, 400, invalid); return; }
      const unavailable = sharedModelRefusal(availability, `${family}/${body.model}`);
      if (unavailable) { refuseModel(res, unavailable); return; }
      if (!grant.models.includes(`${family}/${body.model}`)) { json(res, 403, "This model is not shared with your Unix account"); return; }
      if (family === "anthropic" && grant.claudeWeeklyFloorPercent !== undefined) {
        const shared = auth.get(family)!;
        const ids = store.accounts().filter(account => account.provider === family && grant.accounts.includes(account.id) && shared.has(account.id)).map(account => account.id);
        const cooled = claudeCooldownRefusal(claudeWeeklyPool(store, ids, body.model), grant.claudeWeeklyFloorPercent);
        if (cooled) { res.setHeader("retry-after", "3600"); json(res, cooled.status, cooled.message, cooled.code); return; }
      }
      const ultrafast = body.service_tier === "ultrafast";
      if (ultrafast && !modelSpeedModes(family, body.model).includes("ultrafast")) { json(res, 400, "Ultrafast is only available for Codex Astra or Sol models"); return; }
      const refusal = overAllowance(listener.principal);
      if (refusal) { json(res, 403, refusal); return; }
      if(scientific){
        if(family!=='openai-codex' || body.service_tier!==undefined && !['auto','default'].includes(body.service_tier)) {json(res,400,'Scientific route requires Codex standard tier','experiment_route_invalid');return;}
        const provider=providers.get(family);
        const rates=provider?modelsWithCustomDefinitions(provider).find(model=>model.id===body.model)?.cost:undefined;
        if(!rates || rates.input<=0 || rates.output<=0 || !(['input','output','cacheRead','cacheWrite'] as const).every(key=>Number.isFinite(rates[key]) && rates[key]>=0)){json(res,400,'Scientific cost rates are unset','experiment_rates_unset');return;}
        experimentRates={input:rates.input,output:rates.output,cacheRead:rates.cacheRead,cacheWrite:rates.cacheWrite,...(rates.tiers?{tiers:rates.tiers}:{})};
        const reservation=experiments!.reserve(logicalId as string,requestBytes);
        if(!reservation.ok){json(res,409,reservation.error.message,reservation.error.code);return;}
        if(reservation.value.kind==='saved'){const saved=reservation.value.response;res.writeHead(saved.status,{...saved.headers,'x-pi-experiment-replay':'saved-response','x-pi-physical-attempt-id':reservation.value.attempt.physicalId});res.end(Buffer.from(saved.bodyBase64,'base64'));return;}
        experimentAttempt=reservation.value.attempt;experimentCancels.set(experimentAttempt.physicalId,cancel);
      }
      const shared = auth.get(family)!;
      let exclude = new Set(store.accounts().filter(account => !grant.accounts.includes(account.id)
        || !allowsAccountUse(account, "interactive")
        || store.latestMeters(account.id).some(meter => modelDrainsMeter(family, body.model, meter.meter_id)
          && Number(meter.used_percent) >= 100 && (!meter.reset_at || Number(meter.reset_at) > Date.now())) && !creditFunded(store, account.id)).map(account => account.id));
      if (family === "openai-codex") exclude = await codexTierExclusions(store, shared, body.model, body.service_tier, exclude, signal, transport as typeof fetch);
      const session = body.prompt_cache_key ?? req.headers["session-id"] ?? req.headers["session_id"] ?? req.headers["x-claude-code-session-id"];
      const affinity = scoped(listener.principal, session);
      const retained = sticky.get(affinity);
      const workClass = req.headers["x-kenan-work-class"];
      if (workClass !== undefined && workClass !== "interactive" && workClass !== "background") { json(res, 400, "x-kenan-work-class must be interactive or background", "work_class_invalid"); return; }
      const background = workClass === "background" && config.backgroundRouting
        ? routeBackground(store, shared, family, exclude, body.model, retained, config.backgroundRouting.fiveHourReservePercent) : undefined;
      const logBackground = (accountId: string | null) => {
        if (!background) return;
        const decision = background.decision;
        console.log(JSON.stringify({ type: "broker_route", principal: listener.principal, workClass: "background", model: body.model,
          accountId, kind: decision.kind, reason: decision.reason, reservePercent: config.backgroundRouting!.fiveHourReservePercent,
          ...(decision.kind === "account" ? { wastePercent: Math.round(decision.wastePercent * 10) / 10, weeklyResetAt: new Date(decision.weeklyResetAt).toISOString(), fiveHourLeftPercent: decision.fiveHourLeftPercent } : {}),
          ...(decision.kind === "held" ? { retryAt: new Date(decision.retryAt).toISOString() } : {}),
          ...(decision.kind === "pace" || decision.kind === "current" ? { retained: accountId !== null && accountId === retained } : {}),
          candidates: candidateSummary(background.candidates, Date.now()) }));
      };
      if (background?.kind === "held") {
        logBackground(null);
        res.setHeader("retry-after", String(Math.max(1, Math.ceil((background.decision.retryAt - Date.now()) / 1000))));
        json(res, 429, `Background work is held: every shared account's five-hour window is below the reserve kept for human-facing turns. Retry after the five-hour reset at ${new Date(background.decision.retryAt).toISOString()}.`, "background_reserve", background.decision.retryAt);
        return;
      }
      const routingExclude = background?.kind === "spread" ? background.exclude : exclude;
      const kept = background?.kind === "account" ? undefined : eligibleInteractiveAccounts(store, shared, family, routingExclude, body.model).find(account => account.id === retained);
      const leave = kept !== undefined && (paceCheckAt.get(affinity) ?? 0) <= Date.now()
        && shouldLeaveRetained(store, shared, family, kept.id, routingExclude, body.model, Math.random);
      if (kept && (paceCheckAt.get(affinity) ?? 0) <= Date.now()) {
        if (paceCheckAt.size >= 4096) paceCheckAt.delete(paceCheckAt.keys().next().value!);
        paceCheckAt.set(affinity, Date.now() + (leave ? PACE_SETTLE_MS : PACE_CHECK_MS));
      }
      const firstAccount = background?.kind === "account" ? background.account
        : (leave ? undefined : kept)
        ?? chooseInteractiveAccount(store, shared, family, leave ? new Set([...routingExclude, kept!.id]) : routingExclude, { includeCooling: true, model: body.model })
        ?? kept;
      logBackground(firstAccount?.id ?? null);
      const granted = store.accounts().filter(candidate => candidate.provider === family && !exclude.has(candidate.id) && shared.has(candidate.id));
      if (!firstAccount && granted.length && granted.every(candidate => accountModelExcluded(store, candidate.id, body.model))) {
        json(res, 400, noEntitledAccountError(family, body.model));
        return;
      }
      if (!firstAccount) {
        const verification = store.accounts().filter(candidate => candidate.provider === family && grant.accounts.includes(candidate.id)
          && shared.rejection(candidate.id)?.state === "identity-verification-required");
        if (verification.length) {
          json(res, 503, `Identity verification is required for ${verification.map(candidate => candidate.id).join(", ")}; no other eligible account is available. The account holder must complete verification.`, "identity_verification_required");
          return;
        }
        const tier = family === "openai-codex" && typeof body.service_tier === "string" && !["auto", "default"].includes(body.service_tier) ? body.service_tier : undefined;
        json(res, 503, tier
          ? `No eligible shared model account offers service tier ${tier} for this model. The granted pool is unavailable, out of quota, or not entitled; no slower tier was used.`
          : "No eligible shared model account. The granted pool is unavailable or out of quota.");
        return;
      }
      let account = firstAccount;
      if (sticky.size >= 4096) sticky.delete(sticky.keys().next().value!);
      sticky.set(affinity, account.id);
      lease = `broker:${listener.principal}:${randomUUID()}`;
      store.createLease(lease, account.id, "interactive");
      usageReceipt = { accountId: account.id, model: body.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      timer = setInterval(() => { try { store.heartbeatLease(lease!); } catch { cancel.abort(); } }, 30_000);
      if (family === "openai-codex" && body.prompt_cache_key !== undefined) body.prompt_cache_key = affinity;
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
      for (const key of ["anthropic-version", "anthropic-beta", "x-codex-beta-features", "user-agent", "x-app", "openai-beta", "originator", "x-stainless-retry-count", "x-stainless-runtime-version", "x-stainless-package-version", "x-stainless-runtime", "x-stainless-lang", "x-stainless-arch", "x-stainless-os", "x-stainless-timeout"]) {
        const value = req.headers[key];
        if (typeof value === "string") headers.set(key, value);
      }
      headers.set("session_id", affinity);
      headers.set("session-id", affinity);
      headers.set("x-client-request-id", affinity);
      if (family === "anthropic") headers.set("x-claude-code-session-id", affinity);
      let credential = await shared.resolve(account.id, signal);
      const authorize = () => {
        if (family === "openai-codex") {
          const resolved = imageAuth(credential, "codex");
          if (!resolved.ok) throw new Error("Codex account identity is missing");
          headers.set("chatgpt-account-id", resolved.value.headers.get("chatgpt-account-id")!);
        }
        if (family === "xai") {
          // This is Kenan's Pi 1.1.0 subscription client, not the official Grok CLI.
          // The proxy requires a client version even for third-party OAuth clients.
          headers.set("x-grok-client-version", "1.1.0");
          headers.set("x-grok-client-identifier", "kenan-stack-pi");
          headers.set("user-agent", "Kenan-Stack-Pi/1.1.0");
        }
        headers.set("authorization", `Bearer ${credential.apiKey}`);
        for (const [key, value] of Object.entries(credential.headers ?? {})) if (typeof value === "string") headers.set(key, value);
      };
      authorize();
      let startedAt = 0;
      // Anthropic message threads (anthropic-threads.ts): each attempt is planned for the account it goes to.
      const clientBeta = typeof req.headers["anthropic-beta"] === "string" ? req.headers["anthropic-beta"] : undefined;
      const threaded = family === "anthropic" && !scientific && session !== undefined
        && parseInt(affinity.slice(0, 8), 16) % 100 < (threadPercent.get(listener.principal) ?? 100);
      let threadAttempt = { mode: "off", reason: "not_anthropic" } as ThreadAttempt;
      let threadForce: "create" | "off" | undefined;
      let threadFallbacks = 0;
      const threadLog: string[] = [];
      const send = async () => {
        startedAt = Date.now();
        if (family === "anthropic") {
          threadAttempt = threads.plan({ enabled: threaded, conversation: session === undefined ? undefined : affinity, accountId: account.id, body, betaHeader: clientBeta, force: threadForce });
          if (threadAttempt.mode === "off") { if (clientBeta === undefined) headers.delete("anthropic-beta"); else headers.set("anthropic-beta", clientBeta); }
          else headers.set("anthropic-beta", threadAttempt.beta);
        }
        const outgoingBody = family === "anthropic" ? (threadAttempt.mode === "off" ? Uint8Array.from(requestBytes) : threadAttempt.bytes) : JSON.stringify(body);
        if (family === "openai-codex") {
          const wire = JSON.parse(outgoingBody as string);
          dispatchReceipt = { id: `${lease}:${++dispatchAttempt}`, requestId: headers.get("x-client-request-id")!,
            principal: listener.principal, accountId: account.id, model: wire.model,
            serviceTier: typeof wire.service_tier === "string" ? wire.service_tier : "auto",
            at: startedAt, updatedAt: startedAt, outcome: "dispatched" };
          saveDispatch(dispatchReceipt);
        }
        if(experimentAttempt){
          if(Buffer.byteLength(outgoingBody)>32768)throw Object.assign(new Error('Complete upstream request exceeds32768 UTF8bytes'),{code:'experiment_request_bytes_exceeded'});
          if(experiments!.get()?.state!=='active')throw Object.assign(new Error('Experiment stopped'),{code:'experiment_stopped'});
          headers.set('x-client-request-id',experimentAttempt.physicalId);
        }
        const forward = (attemptSignal = signal) => transport(BROKER_ROUTES[family].upstream, { method: "POST", headers, body: outgoingBody, signal: attemptSignal, redirect: "error" });
        const pendingResponse = scientific ? forward() : retryConnect(forward, signal);
        if(experimentAttempt){const marked=experiments!.forwarded(experimentAttempt.physicalId);if(!marked.ok){cancel.abort();await pendingResponse.catch(()=>undefined);throw Object.assign(new Error(marked.error.message),{code:marked.error.code});}}
        const response = await pendingResponse;
        if (dispatchReceipt) { dispatchReceipt.httpStatus = response.status; dispatchReceipt.outcome = response.ok ? "accepted" : "rejected"; saveDispatch(dispatchReceipt); }
        return response;
      };
      let response: Response;
      let repaired = false, streamRejection: string | undefined, streamVerification = false;
      const refusedAccounts = new Set<string>();
      const retryDeadline = Date.now() + 25_000;
      let sameAccountRetries = 0, transportFailures = 0;
      const switchAccount = async (alternate: NonNullable<typeof firstAccount>) => {
        store.endLease(lease!);
        account = alternate;
        sticky.set(affinity, account.id);
        lease = `broker:${listener.principal}:${randomUUID()}`;
        store.createLease(lease, account.id, "interactive");
        usageReceipt!.accountId = account.id;
        credential = await shared.resolve(account.id, signal);
        authorize();
        repaired = false;
      };
      for (;;) {
        // DNS and connect failures already retry on this account for a minute in retryConnect.
        // Other transport failures keep the existing bounded account retry policy.
        try { response = await send(); }
        catch (error) {
          if (scientific || signal.aborted || isConnectFailure(error) || !isTransportFailure(error) || ++transportFailures > MAX_TRANSPORT_RETRIES || Date.now() >= retryDeadline) throw error;
          if (dispatchReceipt?.outcome === "dispatched") { dispatchReceipt.outcome = "indeterminate"; saveDispatch(dispatchReceipt); }
          const alternate = chooseInteractiveAccount(store, shared, family, new Set([...exclude, ...refusedAccounts, account.id]), { model: body.model });
          console.log(JSON.stringify({ type: "broker_transport_retry", principal: listener.principal, model: body.model,
            accountId: account.id, retryAccountId: alternate?.id ?? account.id, attempt: transportFailures, error: describeError(error) }));
          if (alternate) await switchAccount(alternate);
          else await delay(TRANSPORT_RETRY_MS * transportFailures, undefined, { signal });
          continue;
        }
        if(scientific) break;
        if (!response.ok && credential.apiKey) {
          const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
          const repair = await repairProviderCredential(shared, account.id, await providerResponseFailure(response),
            family === "openai-codex" && response.status === 404, repairSignal, credential.apiKey);
          res.setHeader("x-pi-credential-repair", encodeURIComponent(repair.detail));
          if (repair.outcome === "repaired") {
            repaired = true;
            await response.body?.cancel();
            credential = await shared.resolve(account.id, signal);
            authorize();
            response = await send();
            await quarantineProviderCredential(shared, account.id, await providerResponseFailure(response),
              family === "openai-codex" && response.status === 404, repairSignal, credential.apiKey);
          }
        }
        if (!response.ok && isIdentityVerificationRequired(await providerResponseFailure(response))) {
          await shared.reject(account.id, credential.apiKey!, signal, "identity-verification-required");
          refusedAccounts.add(account.id);
          const alternate = chooseInteractiveAccount(store, shared, family, new Set([...exclude, ...refusedAccounts]), { includeCooling: true, model: body.model });
          console.log(JSON.stringify({ type: "broker_account_unavailable", code: "identity_verification_required",
            principal: listener.principal, accountId: account.id, retryAccountId: alternate?.id ?? null }));
          await response.body?.cancel();
          threads.forget(threadAttempt);
          if (!alternate) {
            json(res, 503, `${account.id} requires identity verification by the account holder; no other eligible account is available.`, "identity_verification_required");
            return;
          }
          await switchAccount(alternate);
          threadForce = undefined;
          threadFallbacks = 0;
          continue;
        }
        // A thread the API can't continue (expired, unknown, spent) or won't take: nothing has reached the client, so the
        // whole conversation goes again as a new thread, or without one.
        if (threadAttempt.mode !== "off" && (response.status === 400 || response.status === 404) && threadFallbacks < 2) {
          const failure = threads.fallback(threadAttempt, response.status, await response.clone().text());
          if (failure) {
            await response.body?.cancel();
            threadLog.push(`${threadAttempt.mode}:${response.status}:${failure.code}`);
            threadForce = failure.next;
            threadFallbacks++;
            continue;
          }
        }
        const moveTo = async (alternate: NonNullable<typeof firstAccount>) => {
          await response.body?.cancel();
          await switchAccount(alternate);
        };
        // An account that refuses this model ("not supported when using Codex with a ChatGPT account") is a fact about
        // that account and model: it is recorded, and the same request goes to an account that has not refused it.
        if (!response.ok && response.status !== 429
          && recordAccountModelUnsupported(store, account.id, body.model, await providerResponseFailure(response))) {
          refusedAccounts.add(account.id);
          const alternate = chooseInteractiveAccount(store, shared, family, new Set([...exclude, ...refusedAccounts]), { includeCooling: true, model: body.model });
          console.log(JSON.stringify({ type: "broker_model_unsupported", principal: listener.principal, model: body.model,
            accountId: account.id, retryAccountId: alternate?.id ?? null }));
          if (!alternate) break;
          await moveTo(alternate);
          continue;
        }
        // Only explicit pre-stream refusal is replayable. Once any successful
        // response reaches the client, its stream is owned by that one attempt.
        if (response.status !== 429) break;
        for (const { meterId, reading } of anthropicMeterReadings(Object.fromEntries(response.headers), Date.now())) {
          store.recordMeter(account.id, meterId, reading.usedPercent, reading.resetAt, reading.at);
        }
        const waitMs = brokerRetryDelay(response.headers, sameAccountRetries);
        store.setCooldown(account.id, Math.max(account.cooldownUntil ?? 0, Date.now() + waitMs), { model: body.model });
        refusedAccounts.add(account.id);
        const alternate = chooseInteractiveAccount(store, shared, family, new Set([...exclude, ...refusedAccounts]), { model: body.model });
        if (alternate) {
          await moveTo(alternate);
          continue;
        }
        if (sameAccountRetries >= 2 || Date.now() + waitMs > retryDeadline
          || response.headers.get("x-should-retry") === "false"
          || interactiveQuotaExhausted(store, account.id, family, body.model)) break;
        await response.body?.cancel();
        await delay(waitMs, undefined, { signal });
        sameAccountRetries++;
      }
      if (!response.ok && response.status !== 429) recordAccountModelUnsupported(store, account.id, body.model, await providerResponseFailure(response));
      // The provider admitted this request past its quota checks; a stream that fails later is not a quota refusal.
      if (response.ok) store.recordProviderSuccess(account.id, { model: body.model, startedAt, source: "model-broker" });
      for (const { meterId, reading } of anthropicMeterReadings(Object.fromEntries(response.headers), Date.now())) {
        store.recordMeter(account.id, meterId, reading.usedPercent, reading.resetAt, reading.at);
      }
      const outgoing: Record<string, string> = dispatchReceipt ? { "x-pi-broker-dispatch-id": dispatchReceipt.id } : {};
      for (const key of ["content-type", "retry-after", "retry-after-ms", "x-should-retry", "x-request-id", "request-id"]) {
        const value = response.headers.get(key);
        if (value) outgoing[key] = value;
      }
      if(experimentAttempt){outgoing['x-pi-experiment-id']=experiments!.policy.experimentId;outgoing['x-pi-logical-request-id']=experimentAttempt.logicalId;outgoing['x-pi-physical-attempt-id']=experimentAttempt.physicalId;}
      if(!scientific)res.writeHead(response.status, outgoing);
      const savedChunks:Buffer[]=[];
      let savedLength=0;
      const parser = createParser({ onEvent(event) {
        let value: any;
        try { value = JSON.parse(event.data); } catch { return; }
        if (dispatchReceipt && ["response.completed", "response.incomplete", "response.failed"].includes(value.type)) {
          dispatchReceipt.outcome = value.type.slice("response.".length) as "completed" | "incomplete" | "failed";
          saveDispatch(dispatchReceipt);
        }
        if (family === "anthropic") reply.observe(value);
        const served = servedModelOf(family, value);
        if (served !== undefined) servedModels.observe({ principal: listener.principal, accountId: account.id, requested: body.model, served });
        const failure = value.error ?? value.response?.error ?? (value.type === "error" ? value : undefined);
        if (failure) {
          const detail = `${failure.code ?? ""} ${failure.message ?? ""}`;
          recordAccountModelUnsupported(store, account.id, body.model, detail);
          if (isRejectedTokenError(detail)) streamRejection = detail;
          if (isIdentityVerificationRequired(detail)) streamVerification = true;
        }
        const usage = value.type === "response.completed" ? value.response?.usage : value.type === "message_start" ? value.message?.usage : value.type === "message_delta" ? value.usage : undefined;
        if(value.type==='response.completed')experimentTerminal=true;
        if (!usage) return;
        if(experimentAttempt && value.type==='response.completed' && Number.isInteger(usage.input_tokens) && Number.isInteger(usage.output_tokens) && usage.input_tokens>=0 && usage.output_tokens>=0){
          const cached=usage.input_tokens_details?.cached_tokens ?? 0;
          if(Number.isInteger(cached) && cached>=0 && cached<=usage.input_tokens){
            const selectedTier=experimentRates!.tiers?.filter(tier=>usage.input_tokens>tier.inputTokensAbove).sort((a,b)=>b.inputTokensAbove-a.inputTokensAbove)[0];
            const rates=selectedTier ?? experimentRates!;
            const usd=((usage.input_tokens-cached)*rates.input+usage.output_tokens*rates.output+cached*rates.cacheRead)/1_000_000;
            if(Number.isFinite(usd) && usd>=0)observedCharge={kind:'observed',usd,usage:{providerUsage:usage,model:body.model,ratesPerMillion:rates,selectedInputTierAbove:selectedTier?.inputTokensAbove ?? null,costDefinitionSha256:createHash('sha256').update(JSON.stringify(experimentRates)).digest('hex'),basis:'observed-usage-catalog-list-usd'}};
          }
        }
        const cached = Number(usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
        const input = Number(usage.input_tokens ?? 0) - (family !== "anthropic" ? cached : 0);
        for (const [component, tokens] of Object.entries({ input, output: Number(usage.output_tokens ?? 0), cacheRead: cached, cacheWrite: Number(usage.cache_creation_input_tokens ?? 0) })) {
          const key = component as UsageComponent;
          if (Number.isFinite(tokens)) usageReceipt!.tokens[key] = Math.max(usageReceipt!.tokens[key], tokens);
        }
      }, maxBufferSize: 96 * 1024 * 1024 });
      const reply = new ReplyRecorder();
      const headersAt = Date.now();
      const decoder = new TextDecoder();
      if (response.body) for await (const chunk of response.body) {
        if (response.ok) parser.feed(decoder.decode(chunk, { stream: true }));
        if(scientific){savedChunks.push(Buffer.from(chunk));savedLength+=chunk.length;if(savedLength>MAX_BODY)throw new Error('Experiment response exceeds64MiB retained limit');}
        else if (!res.write(chunk)) await once(res, "drain", { signal });
      }
      if(scientific){
        if(!experimentTerminal)observedCharge={kind:'unknown'};
        const value={status:response.status,headers:outgoing,bodyBase64:Buffer.concat(savedChunks).toString('base64')};
        const settled=experiments!.settle(experimentAttempt!.physicalId,value,observedCharge);
        if(!settled.ok)throw Object.assign(new Error(settled.error.message),{code:settled.error.code});
        if(!res.destroyed){res.writeHead(response.status,outgoing);res.end(Buffer.concat(savedChunks));}
      }
      if (streamVerification && !scientific) {
        await shared.reject(account.id, credential.apiKey!, AbortSignal.timeout(30_000), "identity-verification-required");
        console.log(JSON.stringify({ type: "broker_account_unavailable", code: "identity_verification_required", principal: listener.principal, accountId: account.id, retryAccountId: null }));
      }
      if (streamRejection && !streamVerification && !scientific) {
        const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        if (repaired) await quarantineProviderCredential(shared, account.id, streamRejection, false, repairSignal, credential.apiKey);
        else await repairProviderCredential(shared, account.id, streamRejection, false, repairSignal, credential.apiKey);
      }
      if(!scientific)res.end();
      if (family === "anthropic" && !scientific) {
        const outcome = response.ok ? threads.settle(threadAttempt, reply) : (threads.forget(threadAttempt), `http_${response.status}`);
        const wireBytes = threadAttempt.mode === "off" ? requestBytes.length : threadAttempt.bytes.length;
        console.log(JSON.stringify({ type: "broker_anthropic_call", principal: listener.principal, model: body.model, accountId: account.id,
          conversation: session === undefined ? null : affinity.slice(0, 16),
          cacheDiff: session === undefined ? null : cacheDiffer.observe(`${affinity}\n${body.model}`, body, clientBeta),
          thread: threadAttempt.mode, reason: threadAttempt.reason, fallbacks: threadLog, outcome, status: response.status,
          clientBytes: requestBytes.length, wireBytes, messages: Array.isArray(body.messages) ? body.messages.length : 0,
          sentMessages: threadAttempt.mode === "off" ? (Array.isArray(body.messages) ? body.messages.length : 0) : threadAttempt.sent,
          headersMs: headersAt - startedAt, ttftMs: reply.firstTokenAt === undefined ? null : reply.firstTokenAt - startedAt, totalMs: Date.now() - startedAt,
          input: reply.usage.input_tokens ?? null, cacheRead: reply.usage.cache_read_input_tokens ?? null, cacheWrite: reply.usage.cache_creation_input_tokens ?? null, output: reply.usage.output_tokens ?? null }));
      }
    } catch (error) {
      if (!signal.aborted) console.error(`Model broker request failed for ${listener.principal}: ${describeError(error)}`);
      const experimentError = error instanceof Error && 'code' in error && String(error.code).startsWith('experiment_');
      if(experimentError){json(res,409,error.message,String(error.code));return;}
      const policy = error instanceof Error && "code" in error && ["metered_inference_forbidden", "subscription_credential_unset", "subscription_credential_invalid"].includes(String(error.code));
      json(res, policy ? 403 : signal.aborted ? 499 : 502, policy ? error.message : signal.aborted ? "Model request cancelled" : "Model broker request failed; inspect the broker service and account authentication", policy ? String(error.code) : undefined);
    } finally {
      if (dispatchReceipt && ["dispatched", "accepted"].includes(dispatchReceipt.outcome)) {
        dispatchReceipt.outcome = signal.aborted ? "cancelled" : "indeterminate";
        saveDispatch(dispatchReceipt);
      }
      if(experimentAttempt)experimentCancels.delete(experimentAttempt.physicalId);
      clearInterval(timer);
      if (lease && usageReceipt) for (const [component, tokens] of Object.entries(usageReceipt.tokens)) {
        if (tokens > 0) store.recordUsage({ accountId: usageReceipt.accountId, hour: Math.floor(Date.now() / 3_600_000) * 3_600_000, source: "interactive", runId: lease, model: usageReceipt.model, component: component as UsageComponent, tokens });
      }
      if (lease) store.endLease(lease);
      res.off("close", disconnected);
      inflight.set(listener.principal, (inflight.get(listener.principal) ?? 1) - 1);
    }
  };
  publish();
  const trackedRequest = (principal: string, req: IncomingMessage, res: ServerResponse, listenerAuthority?: BrokerRequestAuthority): Promise<void> => {
    if (draining) { json(res, 503, "Broker custody is draining; reconcile accepted IDs with its successor"); return Promise.resolve(); }
    if (retiring) { res.shouldKeepAlive = false; res.setHeader("connection", "close"); }
    const listener = config.listeners.find(candidate => candidate.principal === principal);
    if (!listener) { json(res, 403, "Principal has no model grant"); return Promise.resolve(); }
    const work = (async () => {
      for (const authority of [listenerAuthority, embedded?.authorizeRequest]) {
        if (!authority) continue;
        const authorized = await authority(principal, req);
        if (!authorized.ok) { json(res, authorized.status, authorized.message); return; }
      }
      if (draining) { json(res, 503, "Broker custody is draining"); return; }
      await request(listener, req, res);
    })().catch(error => {
      console.error(`Model broker request failed: ${describeError(error)}`);
      json(res, 500, "Broker request failed");
    });
    active.add(work);
    void work.finally(() => active.delete(work));
    return work;
  };
  return {
    request: trackedRequest,
    /** Trusted adoption binds an exact old stored identity; it never submits provider work. */
    adoptCompletion(principal: string, requestId: string, storedRequestId: string, ownerId = "current"): CompletionOutcome<CompletionRecord> {
      if (!isCompletionRequestId(requestId) || !isCompletionRequestId(storedRequestId)) return { ok: false, error: { code: "invalid-request", message: "Invalid adoption identity" } };
      const grant = grants.get(principal);
      if (!grant) return { ok: false, error: { code: "invalid-request", message: "Principal has no broker grant" } };
      const owner = completionOwners.get(ownerId);
      if (!owner) return { ok: false, error: { code: "invalid-state", message: "Retained ledger owner is not registered" } };
      const ownedId = `broker-${scoped(principal, requestId)}`, aliasKey = `completion-alias:${ownedId}`;
      const reverseKey = `completion-public-owner:${JSON.stringify([ownerId, storedRequestId])}`;
      const reserved = store.transaction<CompletionOutcome<void>>(() => {
        const encoded = store.control(aliasKey), alias = encoded ? JSON.parse(encoded) as CompletionAlias : undefined;
        if (alias && (alias.requestId !== storedRequestId || alias.ownerId !== ownerId) || !alias && completionOwners.get("current")!.service.get(ownedId) && (ownerId !== "current" || ownedId !== storedRequestId)) return { ok: false, error: { code: "request-conflict", message: "Public ID already has different custody" } };
        const reverse = store.control(reverseKey);
        if (reverse && reverse !== ownedId) return { ok: false, error: { code: "request-conflict", message: "Stored completion already has another public identity" } };
        store.setControl(aliasKey, JSON.stringify({ state: "adopting", ownerId, requestId: storedRequestId } satisfies CompletionAlias));
        store.setControl(reverseKey, ownedId);
        return { ok: true, value: undefined };
      });
      if (!reserved.ok) return reserved;
      const adopted = owner.service.adoptAccess(storedRequestId, { principal, accounts: grant.accounts, models: grant.models });
      if (!adopted.ok) return adopted;
      store.setControl(aliasKey, JSON.stringify({ state: "ready", ownerId, requestId: storedRequestId } satisfies CompletionAlias));
      return { ok: true, value: { ...adopted.value, requestId } };
    },
    /** Apply a reloaded grant file. Listener principals and ports are process topology; only what
     * each principal may spend changes here. */
    applyGrants(listeners: readonly BrokerListener[]): void {
      for (const listener of listeners) {
        if (!grants.has(listener.principal)) continue;
        grants.set(listener.principal, { accounts: listener.accounts, models: listener.models, weeklyUsd: listener.weeklyUsd, claudeWeeklyFloorPercent: listener.claudeWeeklyFloorPercent });
        threadPercent.set(listener.principal, listener.anthropicThreadsPercent ?? 100);
        const configured = config.listeners.find(value => value.principal === listener.principal)!;
        configured.maxInFlight = listener.maxInFlight;
      }
      publish();
    },
    applyBackgroundRouting(routing: ModelBrokerConfig["backgroundRouting"]): void {
      config.backgroundRouting = routing;
    },
    listen(principals?: readonly string[], listenerAuthority?: BrokerRequestAuthority): Promise<number[]> {
      if (draining) return Promise.reject(new Error("Broker custody is draining"));
      if (listening) return listening;
      if (principals && (new Set(principals).size !== principals.length || principals.some(principal => !config.listeners.some(listener => listener.principal === principal)))) return Promise.reject(new Error("Unknown or duplicate retained listener principal"));
      listening = (async () => { try {
        publish();
        for (const listener of config.listeners.filter(listener => principals === undefined || principals.includes(listener.principal))) {
          const server = createServer((req, res) => { void trackedRequest(listener.principal, req, res, listenerAuthority); });
          attachMeetRecognitionBroker(server, shutdown.signal, () => {
            const count = inflight.get(listener.principal) ?? 0;
            if (count >= listener.maxInFlight) return false;
            inflight.set(listener.principal, count + 1);
            return true;
          }, () => inflight.set(listener.principal, Math.max(0, (inflight.get(listener.principal) ?? 1) - 1)), async req => {
            if (draining) return false;
            for (const authority of [listenerAuthority, embedded?.authorizeRequest]) {
              if (authority && !(await authority(listener.principal, req)).ok) return false;
            }
            return !draining;
          });
          servers.push(server);
          // A predecessor without SO_REUSEPORT (or one still releasing the port) holds it for moments
          // during a supervisor handover; keep trying for a bounded time, then fail the generation.
          for (const deadline = Date.now() + BIND_RETRY_MS; ;) {
            const bound = await new Promise<NodeJS.ErrnoException | undefined>(resolve => {
              const failed = (error: NodeJS.ErrnoException) => resolve(error);
              server.once("error", failed);
              server.listen({ port: listener.port, host: "127.0.0.1", reusePort: true }, () => { server.off("error", failed); resolve(undefined); });
            });
            if (!bound) break;
            if (bound.code !== "EADDRINUSE" || Date.now() > deadline) throw bound;
            await delay(20);
          }
        }
        if (meterSamplers.length) {
          const poll = () => { void pollMeters().catch(error => console.error(`Meter poll failed: ${error instanceof Error ? error.message : String(error)}`)); };
          meterPoll = setInterval(poll, METER_POLL_TICK_MS);
          meterPoll.unref();
          poll();
        }
        usageTimer = setInterval(refreshAllUsage, USAGE_REFRESH_MS);
        usageTimer.unref();
        refreshAllUsage();
        const ports = servers.map(server => (server.address() as { port: number }).port);
        // Each generation binds its own SO_REUSEPORT sockets (a cluster worker listening with reusePort
        // doesn't go through the primary), so the supervisor learns readiness from this message.
        if (cluster.isWorker) process.send?.({ type: "broker_listening", ports });
        return ports;
      } catch (error) { await this.close(); throw error; } })();
      return listening;
    },
    close(): Promise<void> {
      if (!closed) closed = (async () => {
        // Retire before draining: stop accepting, keep serving whatever still arrives on open
        // connections (answered with Connection: close), and let idle keep-alive sockets expire on
        // the timeout clients were told. http.Server.close would close idle sockets at once and race
        // a client sending on one; under the supervisor a successor already accepts new connections.
        retiring = true;
        clearInterval(meterPoll);
        clearInterval(usageTimer);
        const connectionsClosed = Promise.all(servers.map(server => new Promise<void>(resolve => NetServer.prototype.close.call(server, () => resolve()))));
        const keepAliveMs = Math.max(0, ...servers.map(server => server.keepAliveTimeout));
        do {
          while (active.size) await Promise.all([...active]);
          await Promise.race([connectionsClosed, delay(keepAliveMs + 1_000, undefined, { ref: false })]);
        } while (active.size);
        draining = true;
        for (const server of servers) server.closeIdleConnections();
        shutdown.abort();
        await connectionsClosed;
        await usageThread.close();
        if (!embedded) store.close();
      })();
      return closed;
    },
  };
}

const BIND_RETRY_MS = 15_000;

export function loadBrokerConfig(path: string): ModelBrokerConfig {
  const info = statSync(path);
  if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("Model broker grants must be in a root-owned file without group/other write access");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validateBrokerConfig(config)) throw new Error("Invalid model broker configuration");
  return config;
}

export async function runModelBroker(path: string): Promise<void> {
  // Match the service's Node options on graceful reloads from an older supervisor.
  // Do not race a slow IPv4 connection against an unroutable IPv6 address.
  setDefaultResultOrder("ipv4first");
  setDefaultAutoSelectFamily(false);
  installBrokerNetworking();
  console.log(JSON.stringify({ type: "broker_network_family", dnsResultOrder: getDefaultResultOrder(), autoSelectFamily: getDefaultAutoSelectFamily() }));
  const config = loadBrokerConfig(path);
  const broker = createModelBroker(config, new ModelAvailabilityStore(modelAvailabilityPath()));
  await broker.listen();
  console.log(JSON.stringify({ type: "broker_background_routing", backgroundRouting: config.backgroundRouting ?? null }));
  const topology = (listeners: readonly BrokerListener[]) => listeners.map(listener => `${listener.principal}:${listener.port}`).sort().join(",");
  // An edited grant file reaches queued completions and live routing without cancelling active
  // requests. A change this process can't apply in place (listeners, grant owner) asks the
  // supervisor for a new generation, which takes over without refusing a call.
  const swapGeneration = (why: string) => {
    if (cluster.isWorker) {
      console.log(JSON.stringify({ type: "broker_generation_requested", why }));
      process.kill(process.ppid, "SIGHUP");
    } else console.error(`Model broker ${why}; run it under the supervisor (systemctl reload kenan-model-broker) to apply it`);
  };
  watchFile(path, { interval: 2_000 }, () => {
    let reloaded: ModelBrokerConfig;
    try { reloaded = loadBrokerConfig(path); }
    catch (error) { console.error(`Model broker kept its current grants: ${error instanceof Error ? error.message : "unreadable grant file"}`); return; }
    if (reloaded.grantOwner !== config.grantOwner) { swapGeneration(`grant owner changed in ${path}`); return; }
    if (topology(reloaded.listeners) !== topology(config.listeners)) { swapGeneration(`listeners changed in ${path}`); return; }
    broker.applyGrants(reloaded.listeners);
    if (JSON.stringify(reloaded.backgroundRouting) !== JSON.stringify(config.backgroundRouting)) {
      broker.applyBackgroundRouting(reloaded.backgroundRouting);
      console.log(JSON.stringify({ type: "broker_background_routing", backgroundRouting: reloaded.backgroundRouting ?? null }));
    }
  });
  await new Promise<void>(resolve => {
    const stop = () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  unwatchFile(path);
  await broker.close();
  // Under the restart supervisor the IPC channel would keep a drained generation alive.
  if (cluster.isWorker) cluster.worker?.disconnect();
}
