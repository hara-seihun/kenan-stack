import { request as httpsRequest } from "node:https";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { Store } from "./store.js";
import type { SharedOAuthAuth } from "./auth/shared-oauth.js";
import { meterCredential, meterRequestSignal } from "./auth/meter-credential.js";
import { claimCodexReset, setCreditFunded, codexResetAttempt, confirmCodexReset, recordCodexResetResult, resetReason } from "./codex-resets.js";

/**
 * Codex meter sampling.
 *
 * Anthropic publishes its unified meters as headers on every response, so
 * the usage-logger extension records them for free. Codex publishes none:
 * pi's Codex transport is a WebSocket by default, so there is no HTTP
 * response to carry headers at all, and the SSE fallback is not where the
 * fleet lives. Codex accounts therefore had no meter source whatsoever —
 * every one of them sat permanently uncalibrated, which the broker correctly
 * reads as bootstrap and holds to exactly one concurrent session per
 * account. Seven Pro accounts running one agent each, at 8–23% of their
 * weekly plans, was the whole fleet's ceiling until this sampler existed.
 *
 * The source is the same account-usage endpoint the Codex client reads:
 * `GET /backend-api/codex/usage` returns the account's rate-limit windows
 * with an integer used-percent, the window length, and the reset instant.
 * Window length is what names the meter — the operator config declares
 * meters by window hours, and a window the config does not declare is
 * reported rather than guessed at, because a mis-named meter would calibrate
 * one plan's drain against another's allowance.
 *
 * History cannot be backfilled, so readings are captured continuously.
 * Credentials resolve through the shared OAuth lock, including refresh for
 * idle accounts, just as they do for interactive and fleet sessions.
 */

export const CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
// OpenAI rejects the unversioned User-Agent on newly activated Pro accounts.
const CLIENT_NAME = "pi-orchestrator";
const USER_AGENT = `${CLIENT_NAME}/1.0`;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The same request, issued with node's own HTTPS client instead of `fetch`.
 *
 * This endpoint is behind a bot filter that judges how a connection is
 * opened, not who is calling: the first request on a fresh undici connection
 * is answered 403 with perfectly good credentials (a second request on the
 * same warm socket then succeeds, which is what makes the failure look
 * intermittent and per-account when a poller walks a fleet). Node's own
 * client — the same TLS shape every other non-browser HTTP client on the box
 * presents — is answered 200 on a cold connection, every time. So the
 * transport is the fix, not a retry: a retry would double every poll and
 * still fail whenever the socket had gone idle. A default `User-Agent: node`
 * is refused the same way, which is why one is named above.
 */
function httpsFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      String(input),
      {
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>), "Accept-Encoding": "identity" },
        signal: init?.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              // A status outside Response's legal range would throw here and
              // lose the real outcome; 502 says "upstream, unusable".
              status: res.statusCode !== undefined && res.statusCode >= 200 ? res.statusCode : 502,
              headers: Object.fromEntries(Object.entries(res.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init?.body as string | undefined);
  });
}

export interface CodexWindowUsage {
  /** Percent of this window's allowance consumed, as Codex reports it. */
  readonly usedPercent: number;
  /** Length of the rolling window, which is what identifies the meter. */
  readonly windowSeconds: number;
  /** When this window rolls over. */
  readonly resetAt: number | undefined;
}

export type CodexSampleOutcome =
  | "recorded"
  | "cancelled"
  | "reset-credits-unreadable"
  | "reset-pending"
  | "reset-failed"
  | "not-due"
  | "no-credential"
  | "credential-failed"
  | "request-failed"
  | "unreadable-response"
  | "unmapped-window"
  | "stale-reading";

export interface CodexSampleReport {
  readonly accountId: string;
  readonly meterId?: string;
  readonly outcome: CodexSampleOutcome;
  readonly usedPercent?: number;
  readonly detail?: string;
  /** Banked resets counted by this pass, when the balance was readable. */
  readonly bankedResets?: number;
}

/** A meter this deployment knows by the length of the window it measures. */
export interface CodexMeterSpec {
  readonly id: string;
  readonly windowHours: number;
}

function window(value: unknown, now: number): CodexWindowUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usedPercent = raw.used_percent;
  const windowSeconds = raw.limit_window_seconds;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  if (typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return undefined;
  }
  // `reset_at` is epoch seconds; `reset_after_seconds` is the same instant
  // expressed relative to this response, and is the fallback when the
  // absolute form is missing.
  const resetAt = typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at)
    ? raw.reset_at * 1000
    : typeof raw.reset_after_seconds === "number" && Number.isFinite(raw.reset_after_seconds)
      ? now + raw.reset_after_seconds * 1000
      : undefined;
  return { usedPercent, windowSeconds, resetAt };
}

/**
 * Reads the rate-limit windows out of a Codex usage response. An empty list
 * means the response carried no usable window — a gap in evidence, never a
 * zero reading. Model-scoped `additional_rate_limits` are deliberately not
 * read: they meter one model's allowance, not the account plan the broker
 * paces against.
 */
export function parseCodexUsage(value: unknown, now = Date.now()): CodexWindowUsage[] {
  if (value === null || typeof value !== "object") return [];
  const limit = (value as Record<string, unknown>).rate_limit;
  if (limit === null || typeof limit !== "object") return [];
  const raw = limit as Record<string, unknown>;
  return [window(raw.primary_window, now), window(raw.secondary_window, now)].filter(
    (w): w is CodexWindowUsage => w !== undefined,
  );
}

/**
 * Banked rate-limit resets the account can spend.
 *
 * A reset returns a quota window to zero, so the balance says how much an
 * exhausted account can still be given back today. The endpoint answers with
 * a count alongside the credit list; the list is what carries expiry, and a
 * credit the provider has already spent stays in it, so both are read.
 */
export interface CodexResetCredits {
  readonly available: number;
  /** Expiry of the first live credit, the one a redemption spends. */
  readonly nextExpiresAt: number | undefined;
  /** Live (available, unexpired) credits, soonest expiry first. */
  readonly live: readonly { readonly id: string; readonly expiresAt: number | undefined }[];
}

export async function fetchCodexResetCredits(
  accessToken: string,
  chatgptAccountId: string,
  fetchFn: FetchLike = httpsFetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CodexResetCredits> {
  signal?.throwIfAborted();
  const response = await fetchFn(RESET_CREDITS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": chatgptAccountId,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      originator: CLIENT_NAME,
    },
    signal: meterRequestSignal(requestTimeoutMs, signal),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`codex reset credits HTTP ${response.status}`);
  return parseCodexResetCredits(await response.json());
}

export function parseCodexResetCredits(value: unknown, now = Date.now()): CodexResetCredits {
  if (value === null || typeof value !== "object") throw new Error("codex reset credits response is not an object");
  const raw = value as Record<string, unknown>;
  const credits = Array.isArray(raw.credits) ? (raw.credits as Record<string, unknown>[]) : [];
  const spendable = credits.filter((credit) => credit !== null && typeof credit === "object" && (credit.status ?? "available") === "available");
  // `available_count` is the provider's own answer and stays authoritative
  // when the list is paged or elided; the list only refines it.
  const counted = typeof raw.available_count === "number" && Number.isFinite(raw.available_count)
    ? Math.max(0, Math.round(raw.available_count))
    : spendable.length;
  const live = spendable
    .filter((credit): credit is Record<string, unknown> & { id: string } => typeof credit.id === "string")
    .map((credit) => ({ id: credit.id, expiresAt: typeof credit.expires_at === "string" ? Date.parse(credit.expires_at) : undefined }))
    .filter((credit) => credit.expiresAt === undefined || (Number.isFinite(credit.expiresAt) && credit.expiresAt > now))
    .sort((x, y) => (x.expiresAt ?? Infinity) - (y.expiresAt ?? Infinity));
  return { available: counted, nextExpiresAt: live[0]?.expiresAt, live };
}

/**
 * Spends one banked reset: the durable claim first, then the POST.
 *
 * The claim is the fence shared by the broker's meter poll and the `codex-reset` command: an attempt that is not yet
 * confirmed by a drop in the weekly reading blocks every further spend on the account, so an interrupted or ambiguous
 * redemption never spends a second credit.
 */
export async function redeemCodexReset(
  ledger: Store,
  accountId: string,
  access: string,
  chatgptAccountId: string,
  creditId: string,
  weekly: { usedPercent: number; resetAt: number | undefined },
  fetchFn: FetchLike = httpsFetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ outcome: "reset-pending" | "reset-failed" | "not-claimed"; detail: string }> {
  const attempt = claimCodexReset(ledger, accountId, creditId, weekly.resetAt, weekly.usedPercent);
  if (!attempt) return { outcome: "not-claimed", detail: "an earlier attempt on this account is unconfirmed, or already spent this credit or window" };
  try {
    const response = await fetchFn(`${RESET_CREDITS_URL}/consume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "chatgpt-account-id": chatgptAccountId, Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT, originator: CLIENT_NAME },
      body: JSON.stringify({ credit_id: creditId, redeem_request_id: attempt.requestId, account_id: chatgptAccountId }),
      signal: AbortSignal.timeout(requestTimeoutMs), redirect: "error",
    });
    const value = await response.json() as { code?: string };
    const accepted = response.ok && (value.code === "reset" || value.code === "already_redeemed");
    const detail = accepted ? "awaiting provider quota drop" : `reset HTTP ${response.status}${typeof value.code === "string" ? ` ${value.code}` : ""}`;
    recordCodexResetResult(ledger, accountId, attempt, accepted, detail);
    return { outcome: accepted ? "reset-pending" : "reset-failed", detail };
  } catch {
    const detail = "redemption outcome unknown; waiting for quota evidence, no automatic POST retry";
    recordCodexResetResult(ledger, accountId, attempt, false, detail);
    return { outcome: "reset-failed", detail };
  }
}

/** A usage request the provider refused on the credential, not the request. */
export class CodexUnauthorizedError extends Error {
  constructor(readonly status: number, detail = "") {
    super(`codex usage HTTP ${status}${detail}`);
    this.name = "CodexUnauthorizedError";
  }
}

/** Provider-side credit balance an account may spend once its weekly window is full. */
export interface CodexCreditBalance { readonly balance: number; readonly spendable: boolean }

export function parseCodexCredits(value: unknown): CodexCreditBalance | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const credits = (value as Record<string, unknown>).credits;
  if (credits === null || typeof credits !== "object") return undefined;
  const raw = credits as Record<string, unknown>;
  const balance = typeof raw.balance === "string" || typeof raw.balance === "number" ? Number(raw.balance) : Number.NaN;
  if (!Number.isFinite(balance) || typeof raw.has_credits !== "boolean") return undefined;
  return { balance, spendable: raw.has_credits && balance > 0 && raw.overage_limit_reached !== true };
}

export async function fetchCodexUsage(
  accessToken: string,
  chatgptAccountId: string,
  fetchFn: FetchLike = httpsFetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = Date.now(),
  signal?: AbortSignal,
  onCredits?: (credits: CodexCreditBalance | undefined) => void,
): Promise<CodexWindowUsage[]> {
  signal?.throwIfAborted();
  const response = await fetchFn(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": chatgptAccountId,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      originator: CLIENT_NAME,
    },
    signal: meterRequestSignal(requestTimeoutMs, signal),
    redirect: "error",
  });
  if (!response.ok) {
    const body = (await response.text()).replaceAll(accessToken, "[credential]").replaceAll(chatgptAccountId, "[account]").replace(/\s+/g, " ").trim().slice(0, 512);
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("cf-ray");
    const detail = `${requestId ? ` request-id=${requestId}` : ""}${body ? `: ${body}` : ""}`;
    // This fixed account route returned 404 for an unexpired rejected token on 2026-09-15.
    if (response.status === 401 || response.status === 404) throw new CodexUnauthorizedError(response.status, detail);
    throw new Error(`codex usage HTTP ${response.status}${detail}`);
  }
  const body = await response.json();
  onCredits?.(parseCodexCredits(body));
  return parseCodexUsage(body, now);
}

export interface CodexMeterSamplerOptions {
  readonly auth: SharedOAuthAuth;
  /** Meters this deployment declares for Codex, from operator config. */
  readonly meters: readonly CodexMeterSpec[];
  /** Minimum spacing between readings for one account. */
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
  readonly autoReset?: boolean;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** A declared meter claims a window whose length is within 10% of its own. */
const WINDOW_TOLERANCE = 0.1;

export class CodexMeterSampler {
  private readonly auth: SharedOAuthAuth;
  private readonly attemptedAt = new Map<string, number>();
  private readonly meters: readonly CodexMeterSpec[];
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly autoReset: boolean;
  private readonly credits = new Map<string, CodexCreditBalance | undefined>();

  constructor(
    private readonly ledger: Store,
    options: CodexMeterSamplerOptions,
  ) {
    this.auth = options.auth;
    this.meters = options.meters;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? httpsFetch;
    this.autoReset = options.autoReset ?? false;
  }

  /** The meter that measures this window, or undefined if none is declared. */
  private meterFor(windowSeconds: number): string | undefined {
    for (const meter of this.meters) {
      const declared = meter.windowHours * 3_600;
      if (Math.abs(windowSeconds - declared) <= declared * WINDOW_TOLERANCE) return meter.id;
    }
    return undefined;
  }

  /**
   * One usage read, repairing the credential if the provider rejects it.
   *
   * The sampler is the fleet's standing health check on Codex credentials:
   * it touches every account every few minutes whether or not anyone is
   * using it. So it is also where a token invalidated ahead of its stated
   * expiry gets noticed first, and refreshing it here returns the account to
   * service without waiting for a session to fail on it. A second 401 after
   * a successful refresh is a real authorization problem — a revoked grant,
   * a closed account — and is reported rather than retried again.
   */
  private async read(
    accountId: string,
    credential: OAuthCredential,
    chatgptAccountId: string,
    now: number,
    signal?: AbortSignal,
  ): Promise<{ windows: CodexWindowUsage[]; access: string }> {
    const onCredits = (credits: CodexCreditBalance | undefined) => { this.credits.set(accountId, credits); };
    try {
      return { windows: await fetchCodexUsage(credential.access, chatgptAccountId, this.fetchFn, this.requestTimeoutMs, now, signal, onCredits), access: credential.access };
    } catch (thrown) {
      signal?.throwIfAborted();
      if (!(thrown instanceof CodexUnauthorizedError)) throw thrown;
      try {
        const repaired = await this.auth.refreshRejected(
          accountId,
          credential.access,
          meterRequestSignal(this.requestTimeoutMs, signal),
          AbortSignal.timeout(this.requestTimeoutMs),
        );
        signal?.throwIfAborted();
        // The repaired token is what the rest of this pass reads with; the
        // rejected one would only earn a second refusal.
        try {
          return { windows: await fetchCodexUsage(repaired.access, chatgptAccountId, this.fetchFn, this.requestTimeoutMs, now, signal, onCredits), access: repaired.access };
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof CodexUnauthorizedError) await this.auth.reject(accountId, repaired.access, meterRequestSignal(this.requestTimeoutMs, signal));
          throw error;
        }
      } catch (error) {
        throw new Error(`${thrown.message}; after shared OAuth repair: ${String(error)}`);
      }
    }
  }

  /**
   * Samples every Codex account with a readable credential whose last
   * reading is older than the sampling interval, and records one reading per
   * declared window. Never throws: a provider outage is a gap in evidence,
   * not a controller fault.
   */
  async sample(now = Date.now(), signal?: AbortSignal): Promise<CodexSampleReport[]> {
    const reports: CodexSampleReport[] = [];
    for (const account of this.ledger.accounts()) {
      if (signal?.aborted) break;
      if (account.provider !== CODEX_PROVIDER) continue;
      // A disabled account cannot be admitted, so its meters measure nothing
      // schedulable. Polling one only keeps its last failure alive in status:
      // a lapsed subscription reports windows this deployment does not
      // declare, and that report would sit in `meterErrors` for good.
      if (!account.enabled) continue;
      // Response headers do not carry prepaid balances. Poll on our own schedule
      // regardless of automatic reset policy or fresh request-header quota readings.
      const attempted = this.attemptedAt.get(account.id);
      if (attempted !== undefined && now - attempted < this.intervalMs) {
        reports.push({ accountId: account.id, outcome: "not-due" });
        continue;
      }
      this.attemptedAt.set(account.id, now);
      reports.push(...await this.sampleAccount(account.id, now, signal));
      if (signal?.aborted) this.attemptedAt.delete(account.id);
    }
    return reports;
  }

  /**
   * Records the account's banked reset balance beside its meters.
   *
   * The balance is read on the same pass because it is part of the same
   * answer an operator wants from an exhausted account: how much is left, and
   * how much can be handed back. A refused balance leaves the last known one
   * in place and is reported without raising a meter alarm, because metering
   * itself is unaffected.
   */
  private async readResetCredits(accountId: string, accessToken: string, chatgptAccountId: string, signal?: AbortSignal): Promise<{ report: CodexSampleReport; credits?: CodexResetCredits }> {
    try {
      const credits = await fetchCodexResetCredits(accessToken, chatgptAccountId, this.fetchFn, this.requestTimeoutMs, signal);
      signal?.throwIfAborted();
      this.ledger.recordResetCredits(accountId, { at: Date.now(), available: credits.available, nextExpiresAt: credits.nextExpiresAt });
      return { report: { accountId, outcome: "recorded", bankedResets: credits.available }, credits };
    } catch (thrown) {
      return { report: { accountId, outcome: signal?.aborted ? "cancelled" : "reset-credits-unreadable", detail: String(thrown) } };
    }
  }

  private async resetExhausted(accountId: string, access: string, chatgptAccountId: string, windows: CodexWindowUsage[], credits: CodexResetCredits | undefined, observedAt: number, signal?: AbortSignal): Promise<CodexSampleReport | undefined> {
    if (signal?.aborted) return { accountId, outcome: "cancelled" };
    if (!this.autoReset || !this.ledger.accounts().some((account) => account.id === accountId && account.enabled)) return;
    const weekly = windows.find((usage) => Math.abs(usage.windowSeconds - 604800) <= 60480);
    if (!weekly) return;
    confirmCodexReset(this.ledger, accountId, weekly.usedPercent, observedAt);
    const credit = credits?.live[0];
    if (!credit || !resetReason(weekly, credit.expiresAt, Date.now())) return;
    const standing = codexResetAttempt(this.ledger, accountId);
    if (standing && standing.status !== "confirmed") {
      const overdue = Date.now() - standing.at > 2 * this.intervalMs;
      return { accountId, outcome: standing.status === "failed" || overdue ? "reset-failed" : "reset-pending", detail: overdue ? "redemption has not produced quota recovery; automatic spending remains fenced" : standing.detail ?? "awaiting provider quota drop" };
    }
    // After the durable claim, redemption owns its result through shutdown.
    const result = await redeemCodexReset(this.ledger, accountId, access, chatgptAccountId, credit.id, weekly, this.fetchFn, this.requestTimeoutMs);
    if (result.outcome === "not-claimed") return;
    return { accountId, outcome: result.outcome, detail: result.detail };
  }

  /** Banked resets cover weekly exhaustion; prepaid credits also cover shorter exhausted windows that a weekly reset cannot restore. */
  private recordCreditFunding(accountId: string, windows: CodexWindowUsage[], now: number): void {
    const weekly = windows.find((usage) => Math.abs(usage.windowSeconds - 604800) <= 60480);
    const balance = this.credits.get(accountId);
    const unresettableWindowFull = windows.some(usage => usage !== weekly && usage.usedPercent >= 100);
    const needsCredits = unresettableWindowFull || (weekly !== undefined && weekly.usedPercent >= 100);
    setCreditFunded(this.ledger, accountId, this.autoReset && needsCredits && balance?.spendable === true, now, balance?.balance, balance?.spendable === true);
  }

  async sampleAccount(accountId: string, now = Date.now(), signal?: AbortSignal): Promise<CodexSampleReport[]> {
      const reports: CodexSampleReport[] = [];
      const credential = await meterCredential(this.auth, accountId, this.requestTimeoutMs, signal);
      if (!credential.ok) return [{ accountId, outcome: credential.outcome, detail: credential.detail }];
      const chatgptAccountId = credential.credential.accountId;
      if (typeof chatgptAccountId !== "string" || !chatgptAccountId) return [{ accountId, outcome: "credential-failed", detail: "missing ChatGPT account id" }];
      let read: { windows: CodexWindowUsage[]; access: string };
      try {
        read = await this.read(accountId, credential.credential, chatgptAccountId, now, signal);
        signal?.throwIfAborted();
      } catch (thrown) {
        return [{ accountId, outcome: signal?.aborted ? "cancelled" : "request-failed", detail: String(thrown) }];
      }
      const windows = read.windows;
      const resetCredits = await this.readResetCredits(accountId, read.access, chatgptAccountId, signal);
      reports.push(resetCredits.report);
      if (signal?.aborted) return reports;
      const reset = await this.resetExhausted(accountId, read.access, chatgptAccountId, windows, resetCredits.credits, now, signal);
      if (reset) reports.push(reset);
      this.recordCreditFunding(accountId, windows, now);
      if (signal?.aborted) return [...reports, { accountId, outcome: "cancelled" }];
      if (windows.length === 0) return [...reports, { accountId, outcome: "unreadable-response" }];
      for (const usage of windows) {
        const meterId = this.meterFor(usage.windowSeconds);
        if (meterId === undefined) {
          reports.push({
            accountId,
            outcome: "unmapped-window",
            detail: `no meter declared for a ${Math.round(usage.windowSeconds / 3_600)}h window`,
          });
          continue;
        }
        const previous = this.ledger.latestReading(accountId, meterId);
        const at = Date.now();
        if (previous && at < previous.at) {
          reports.push({ accountId, meterId, outcome: "stale-reading" });
          continue;
        }
        this.ledger.recordReading(accountId, meterId, {
          at,
          usedPercent: Math.round(Math.max(0, Math.min(100, usage.usedPercent))),
          resetAt: usage.resetAt,
        });
        reports.push({
          accountId,
          meterId,
          outcome: "recorded",
          usedPercent: usage.usedPercent,
        });
      }
    return reports;
  }
}
