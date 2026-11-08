// The local subscription broker owns Antigravity OAuth and its native Pi provider.
// Keep google-cli as the catalog identity; no CLI subprocess or delegated-tool bridge is involved.
import { join } from 'node:path';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import type { PersonConfig } from './config.js';
import { recordGoogleCacheHealth } from './google-cache-health.js';

const eventTypes = new Set(['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done', 'error']);

/** Decode SSE without assuming that a TCP chunk contains a whole line or JSON event. */
async function* nativeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantMessageEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [];
  const decode = (): AssistantMessageEvent | null => {
    const text = data.join('\n');
    data = [];
    if (!text || text === '[DONE]') return null;
    let value: AssistantMessageEvent;
    try { value = JSON.parse(text); }
    catch { throw new Error('google_antigravity_invalid_event: the broker sent invalid event JSON'); }
    if (!value || !eventTypes.has(value.type)) throw new Error('google_antigravity_invalid_event: the broker sent an unknown Pi event');
    const message = value.type === 'done' ? value.message : value.type === 'error' ? value.error : value.partial;
    if (message?.role !== 'assistant' || !Array.isArray(message.content) || !message.usage) throw new Error('google_antigravity_invalid_event: the Pi event has no assistant message');
    return value;
  };
  try {
    while (true) {
      const part = await reader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      if (part.done) break;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') { const event = decode(); if (event) yield event; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
    const last = decode();
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  let error: { code?: unknown; message?: unknown; resetAt?: unknown } | undefined;
  try { error = JSON.parse(text)?.error; } catch { /* An HTTP failure may have no JSON body. */ }
  const code = typeof error?.code === 'string' ? error.code : 'google_antigravity_http_error';
  const message = typeof error?.message === 'string' ? error.message : `HTTP ${response.status}: ${text.slice(0, 500)}`;
  return new Error(`${code}: ${message}${typeof error?.resetAt === 'string' ? `; resets at ${error.resetAt}` : ''}`);
}

export function streamGoogleCli(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions, owner?: PersonConfig, threadKey?: string) {
  const stream = createAssistantMessageEventStream();
  let output: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: 'pending',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    try {
      options?.signal?.throwIfAborted();
      if (!owner || owner.id !== 'alice' || !Number.isInteger(owner.brokerPort)) throw new Error('google_antigravity_unavailable: Alice’s local subscription broker is required');
      // Functions, AbortSignal, telemetry and local auth markers stay in Stack. The broker receives
      // the full Pi transcript (including tool schemas/results and signatures), not text projections.
      const { signal, fetch: fetchImpl = fetch, onPayload, onResponse, onProviderStreamEvent, apiKey: _key, env: _env, headers: _headers, telemetryContext: _telemetry, ...settings } = options ?? {};
      const request = { model, context, options: { ...settings, sessionId: threadKey ?? settings.sessionId } };
      const payload = await onPayload?.(request, model) ?? request;
      const response = await fetchImpl(`http://127.0.0.1:${owner.brokerPort}/antigravity/stream`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(payload),
      });
      await onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok) throw await responseError(response);
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('google_antigravity_invalid_stream: the broker did not return an SSE body');
      let terminal = false;
      for await (const event of nativeEvents(response.body)) {
        signal?.throwIfAborted();
        await onProviderStreamEvent?.(event, model);
        // Pi exposes one live response object throughout a call. SSE snapshots update it in place.
        if (event.type === 'done') { Object.assign(output, event.message); stream.push({ ...event, message: output }); }
        else if (event.type === 'error') { Object.assign(output, event.error); stream.push({ ...event, error: output }); }
        else { Object.assign(output, event.partial); stream.push({ ...event, partial: output }); }
        if (event.type === 'done' || event.type === 'error') {
          terminal = true;
          if (event.type === 'done') void recordGoogleCacheHealth(owner, threadKey, output.usage, join(owner.home, '.local/state/kenan/google-cache'));
          break;
        }
      }
      if (!terminal) throw new Error('google_antigravity_stream_interrupted: the broker closed before a terminal Pi event');
    } catch (error) {
      output = { ...output, stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error) };
      stream.push({ type: 'error', reason: output.stopReason as 'aborted' | 'error', error: output });
    } finally { stream.end(); }
  })();
  return stream;
}
