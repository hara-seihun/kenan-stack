import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { StreamFunction } from './refusal.js';

type StreamOptions = NonNullable<Parameters<StreamFunction>[2]>;

/** Where a model stream stood: waiting for the response headers, for the first provider event after them, or between events. */
export type StreamPhase = 'awaiting_headers' | 'awaiting_first_event' | 'streaming';
/**
 * The typed cause a failed model stream is recorded with. `no_headers`, `no_first_event` and `stalled` are this watchdog's
 * own limits; `network` is a transport failure the provider reported (fetch failed, socket closed, terminated).
 */
export type StreamFailureCause = 'no_headers' | 'no_first_event' | 'stalled' | 'network';
export interface StreamFailure { cause: StreamFailureCause; phase: StreamPhase; afterMs: number; model: string; message: string }
export interface StreamLimits { headersMs: number; firstEventMs: number; idleMs: number }

/**
 * Backstops behind the brokers' own limits (Acme's broker answers a silent upstream with a typed error after 60 s without
 * headers, 15 s without a complete event after them, 120 s without one mid-stream, counting whole events as this watchdog does;
 * deploy/acme-model-broker.mjs). They catch a broker
 * that itself went silent, and assistant-host's broker, which may hold a request up to 25 s for a rate-limited account.
 */
export const STREAM_LIMITS: StreamLimits = { headersMs: 120_000, firstEventMs: 90_000, idleMs: 180_000 };
/** After the watchdog aborts a request, how long the provider gets to end its stream before the failure is written for it. */
export const ABORT_GRACE_MS = 5_000;

const NETWORK = /fetch failed|terminated|other side closed|socket|ECONNRESET|ECONNREFUSED|EPIPE|network|connection error/i;
const WAITED_FOR: Record<StreamPhase, { cause: StreamFailureCause; what: string; limit: keyof StreamLimits }> = {
  awaiting_headers: { cause: 'no_headers', what: 'response headers', limit: 'headersMs' },
  awaiting_first_event: { cause: 'no_first_event', what: 'stream event after the response headers', limit: 'firstEventMs' },
  streaming: { cause: 'stalled', what: 'further stream event', limit: 'idleMs' },
};

/** undici reports every transport failure as "fetch failed" and keeps the reason in `cause`; the record gets both. */
export function describeFetchFailure(error: unknown): unknown {
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') return error;
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = [cause?.code, cause?.message].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
  return detail ? new TypeError(`fetch failed: ${detail}`, { cause }) : error;
}
export const typedFetch: typeof fetch = async (input, init) => {
  try { return await fetch(input, init); } catch (error) { throw describeFetchFailure(error); }
};

/**
 * Every model request is watched from send to its terminal event. A request that gets no response headers, no first event
 * or no further event within its limit is aborted and ends as a retryable error naming the cause ("timed out"), so Pi's
 * transient retry sends it again at once on the same broker, model and thinking. Transport failures the provider reports
 * themselves get the same typed prefix with phase and elapsed time. Requests the caller aborts and provider errors with a
 * response (rate limits, refusals, overflow) pass through unchanged.
 */
export function installStreamWatchdog(session: AgentSession, failed: (failure: StreamFailure) => void, limits: StreamLimits = STREAM_LIMITS, now: () => number = Date.now): void {
  const base = session.agent.streamFunction;
  session.agent.streamFunction = watchStreams(base, failed, limits, now);
}

export function watchStreams(base: StreamFunction, failed: (failure: StreamFailure) => void, limits: StreamLimits = STREAM_LIMITS, now: () => number = Date.now): StreamFunction {
  return async (model, context, options) => {
    const started = now();
    const inner = new AbortController();
    const caller = options?.signal;
    const forward = () => inner.abort(caller?.reason);
    if (caller?.aborted) forward(); else caller?.addEventListener('abort', forward, { once: true });
    let phase: StreamPhase = 'awaiting_headers';
    let responseStatus: number | undefined;
    let fired: StreamPhase | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const out = createAssistantMessageEventStream();
    const failure = (cause: StreamFailureCause, at: StreamPhase, message: string): StreamFailure =>
      ({ cause, phase: at, afterMs: now() - started, model: model.id, message });
    const terminal = (partial: AssistantMessage | null, f: StreamFailure): Extract<AssistantMessageEvent, { type: 'error' }> => ({
      type: 'error', reason: 'error', error: {
        ...(partial ?? { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: started,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
        stopReason: 'error', errorMessage: f.message,
      },
    });
    const watchdogFailure = (at: StreamPhase) => {
      const { cause, what, limit } = WAITED_FOR[at];
      return failure(cause, at, `model_stream_${cause}: no ${what} within ${Math.round(limits[limit] / 1000)}s (timed out); the request was aborted`);
    };
    let latest: AssistantMessage | null = null;
    let settled = false;
    const finish = (event: AssistantMessageEvent, typed?: StreamFailure) => {
      clearTimeout(timer); clearTimeout(grace);
      caller?.removeEventListener('abort', forward);
      if (settled) return;
      settled = true;
      if (typed) failed(typed);
      out.push(event);
    };
    const arm = (next: StreamPhase) => {
      phase = next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        fired = phase;
        inner.abort(new Error(`model stream watchdog: ${WAITED_FOR[phase].cause}`));
        grace = setTimeout(() => {
          const f = watchdogFailure(fired!);
          finish(terminal(latest, f), f);
        }, ABORT_GRACE_MS);
      }, limits[WAITED_FOR[next].limit]);
    };
    const advance = () => { if (fired === null && !caller?.aborted) arm('streaming'); };
    arm('awaiting_headers');
    const watched = {
      ...options,
      signal: inner.signal,
      ...(model.api === 'openai-codex-responses' ? { fetch: typedFetch } : {}),
      onResponse: async (...args: Parameters<NonNullable<StreamOptions['onResponse']>>) => {
        responseStatus = args[0].status;
        if (fired === null && phase === 'awaiting_headers') arm('awaiting_first_event');
        await options?.onResponse?.(...args);
      },
      onProviderStreamEvent: async (...args: Parameters<NonNullable<StreamOptions['onProviderStreamEvent']>>) => {
        advance();
        await options?.onProviderStreamEvent?.(...args);
      },
    };
    let response: Awaited<ReturnType<StreamFunction>>;
    try { response = await base(model, context, watched); } catch (error) {
      clearTimeout(timer); caller?.removeEventListener('abort', forward);
      throw error;
    }
    void (async () => {
      for await (const event of response) {
        if (event.type === 'done') { finish(event); return; }
        if (event.type === 'error') {
          if (fired !== null && !caller?.aborted) {
            const f = watchdogFailure(fired);
            finish(terminal(event.error, f), f);
          } else if (!caller?.aborted && event.error.errorMessage && NETWORK.test(event.error.errorMessage)) {
            const cause = WAITED_FOR[phase];
            const f = failure('network', phase, `model_stream_network (${phase}, after ${Math.round((now() - started) / 100) / 10}s, waiting for ${cause.what}): ${event.error.errorMessage}`);
            finish({ ...event, error: { ...event.error, errorMessage: f.message } }, f);
          } else if (!caller?.aborted && (responseStatus !== undefined && responseStatus >= 500 && responseStatus <= 599 || /\bno healthy upstream\b|\bno (?:available|healthy) (?:upstreams?|accounts?)\b|\b(?:broker|pool) (?:temporarily )?unavailable\b/i.test(event.error.errorMessage ?? ''))) {
            // Codex drops the HTTP status when turning a plain-text response into an error (503: "no healthy upstream").
            // Keep it so Pi's same-session retry sees the outage, not a permanent error. Never replay an input or tool.
            finish({ ...event, error: { ...event.error, errorMessage: `${responseStatus && responseStatus >= 500 ? responseStatus : 503} broker unavailable: ${event.error.errorMessage ?? 'upstream request failed'}` } });
          } else finish(event);
          return;
        }
        if ('partial' in event) latest = event.partial;
        if (event.type === 'start' && phase === 'awaiting_headers') arm('awaiting_first_event');
        else if (event.type !== 'start') advance();
        out.push(event);
      }
      const result = await response.result();
      clearTimeout(timer); clearTimeout(grace); caller?.removeEventListener('abort', forward);
      if (!settled) { settled = true; out.end(result); }
    })().catch((error: unknown) => {
      const aborted = !!caller?.aborted;
      const message = error instanceof Error ? error.message : String(error);
      finish({ type: 'error', reason: aborted ? 'aborted' : 'error', error: { ...terminal(latest, failure('network', phase, message)).error, stopReason: aborted ? 'aborted' : 'error' } });
    });
    return out;
  };
}
