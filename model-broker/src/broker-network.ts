import * as dns from "node:dns";
import { globalAgent as httpsAgent } from "node:https";
import type { LookupFunction } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, setGlobalDispatcher } from "undici";

const DNS_ERRORS = new Set(["EAI_AGAIN", "ENOTFOUND", "EAI_FAIL", "ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"]);
const CONNECT_ERRORS = new Set([...DNS_ERRORS, "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]);

/** Only failures known to precede request upload. Never replay a cut response here. */
export function isConnectFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 6) return false;
  const e = error as { code?: string; syscall?: string; cause?: unknown; errors?: unknown[] };
  if (e.code && (CONNECT_ERRORS.has(e.code) || e.syscall === "connect" && ["ETIMEDOUT", "ECONNRESET"].includes(e.code))) return true;
  if (Array.isArray(e.errors) && e.errors.length) return e.errors.every(item => isConnectFailure(item, depth + 1));
  return isConnectFailure(e.cause, depth + 1);
}

/** Resolve normally; on resolver failure reuse the last successful answer, for at most a day. */
export function createCachedLookup(resolve = dns.lookup): LookupFunction {
  const answers = new Map<string, { addresses: dns.LookupAddress[]; at: number }>();
  return (hostname, options, callback) => {
    const key = JSON.stringify([hostname, options.family ?? 0, options.hints ?? 0, options.order ?? options.verbatim ?? dns.getDefaultResultOrder()]);
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (!error && addresses.length) {
        if (answers.size >= 1024) answers.delete(answers.keys().next().value!);
        answers.set(key, { addresses, at: Date.now() });
      } else if (error && DNS_ERRORS.has(error.code ?? "")) {
        const saved = answers.get(key);
        if (saved && Date.now() - saved.at < 24 * 3_600_000) {
          console.warn(JSON.stringify({ type: "broker_dns_cached", code: error.code }));
          error = null;
          addresses = saved.addresses;
        }
      }
      if (error) callback(error, "", 0);
      else if (options.all) (callback as unknown as (err: null, values: dns.LookupAddress[]) => void)(null, addresses);
      else if (addresses.length) callback(null, addresses[0].address, addresses[0].family);
      else callback(Object.assign(new Error("DNS returned no addresses"), { code: "ENOTFOUND" }), "", 0);
    });
  };
}

let installed = false;
export function installBrokerNetworking(): void {
  if (installed) return;
  installed = true;
  const lookup = createCachedLookup();
  setGlobalDispatcher(new Agent({ connect: { lookup, autoSelectFamily: false } }));
  // The Codex meter uses node:https rather than fetch. Share the same DNS answers.
  httpsAgent.options.lookup = lookup;
}

/** Same account and bytes, exponential backoff, one minute total, and immediate client cancellation. */
export async function retryConnect<T>(send: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, budgetMs = 60_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = new AbortController();
    // Do not impose a new response timeout on a healthy first connection or on its response stream.
    if (attempt) timer = setTimeout(() => cancel.abort(), Math.max(1, deadline - Date.now()));
    try {
      return await send(attempt ? (signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal) : signal);
    } catch (error) {
      const remaining = deadline - Date.now();
      if (signal?.aborted || !isConnectFailure(error) || remaining <= 0) throw error;
      const waitMs = Math.min(500 * 2 ** Math.min(attempt, 4) * (0.8 + Math.random() * 0.4), remaining);
      console.warn(JSON.stringify({ type: "broker_connect_retry", attempt: ++attempt, waitMs: Math.round(waitMs) }));
      // The attempt's timer must not expire during backoff or survive a successful response.
      if (timer) { clearTimeout(timer); timer = undefined; }
      await delay(waitMs, undefined, { signal });
      if (Date.now() >= deadline) throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
