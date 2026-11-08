import type { ModelAuth } from "@earendil-works/pi-ai";

/** Read-only OAuth subscription endpoint used by xai-org/grok-build's billing extension. */
export const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export type XaiBillingTransport = (url: string, init: RequestInit) => Promise<Response>;
export type XaiBillingErrorCode = "xai_billing_auth" | "xai_billing_http" | "xai_billing_response" | "xai_billing_transport";
export class XaiBillingError extends Error {
  constructor(readonly code: XaiBillingErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "XaiBillingError";
  }
}
export interface XaiBilling {
  prepaidUsd: number;
  onDemandRemainingUsd: number;
  /** Included allowance only; null when purchased/on-demand credits have no shared denominator. */
  percentLeft: number | null;
  /** Current weekly/monthly allowance period end, in Unix milliseconds. */
  resetAt: number | null;
  available: boolean;
  exhausted: boolean;
}

export async function readXaiBilling(
  transport: XaiBillingTransport,
  credential: ModelAuth,
  signal: AbortSignal,
): Promise<XaiBilling> {
  if (typeof credential.apiKey !== "string" || !credential.apiKey) {
    throw new XaiBillingError("xai_billing_auth", "Grok billing requires a subscription OAuth credential.");
  }
  // The CLI sends its authenticated user ID. OAuth access tokens supply it as the JWT subject.
  let subject: unknown;
  try { subject = JSON.parse(Buffer.from(credential.apiKey.split(".")[1] ?? "", "base64url").toString("utf8")).sub; } catch { /* Opaque access tokens may omit the optional identity hint. */ }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.apiKey}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": "1.1.0",
    "x-grok-client-mode": "headless",
    "x-grok-client-identifier": "kenan-stack-pi",
    "user-agent": "Kenan-Stack-Pi/1.1.0",
    Accept: "application/json",
  };
  if (typeof subject === "string" && subject) headers["x-userid"] = subject;
  let response: Response;
  try {
    response = await transport(XAI_BILLING_URL, { method: "GET", headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  } catch {
    throw new XaiBillingError("xai_billing_transport", "Grok subscription billing request failed.");
  }
  if (!response.ok) {
    throw new XaiBillingError(response.status === 401 || response.status === 403 ? "xai_billing_auth" : "xai_billing_http",
      `Grok subscription billing returned HTTP ${response.status}.`, response.status);
  }
  let body: any;
  try { body = await response.json(); } catch {
    throw new XaiBillingError("xai_billing_response", "Grok subscription billing returned invalid JSON.");
  }
  const used = body?.config?.creditUsagePercent;
  const end = body?.config?.currentPeriod?.end;
  const reset = typeof end === "string" ? Date.parse(end) : NaN;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 || !Number.isFinite(reset)) {
    throw new XaiBillingError("xai_billing_response", "Grok subscription billing omitted a valid usage percentage or period end.");
  }
  const cents = (value: unknown): number => {
    if (value === undefined) return 0;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new XaiBillingError("xai_billing_response", "Grok subscription billing returned an invalid credit balance.");
    }
    // Proto3 JSON omits zero-valued scalar fields, so {} means zero cents.
    const val = (value as { val?: unknown }).val ?? 0;
    if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) {
      throw new XaiBillingError("xai_billing_response", "Grok subscription billing returned an invalid credit balance.");
    }
    return val;
  };
  const prepaid = cents(body.config.prepaidBalance);
  const onDemandRemaining = Math.max(0, cents(body.config.onDemandCap) - cents(body.config.onDemandUsed));
  const extraCredits = prepaid > 0 || onDemandRemaining > 0;
  const available = used < 100 || extraCredits;
  return { percentLeft: 100 - used, resetAt: reset, available, exhausted: !available, prepaidUsd: prepaid / 100, onDemandRemainingUsd: onDemandRemaining / 100 };
}
