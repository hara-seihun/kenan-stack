import { readFile } from 'node:fs/promises';
import type { PersonConfig, WebSearchRoute } from '../config.js';

/** The effective descriptor names the configured route before the agent can send its query. */
export function webSearchDescription(route: WebSearchRoute | null, person: PersonConfig): string {
  const alternative = ' For research that excludes hosted models or requires direct first-party retrieval, do not call this tool. Use bash with curl or the maintained research read command to retrieve an explicit public source URL over HTTP instead.';
  if (route === null) return 'Web search is disabled; no search request is sent.' + alternative;
  if (route.provider === 'parallel') return 'Search through the external Parallel Search API (api.parallel.ai). The query is sent to that provider for objective-based processing and excerpts; this is not direct first-party HTTP retrieval or the local subscription reasoning route.' + alternative;
  return `Model-backed web search, not a plain search API: sends the query to OpenAI Codex model ${route.model} through the existing subscription broker at 127.0.0.1:${person.brokerPort}. That hosted model processes the query, invokes built-in web search and generates a cited summary. Uses subscription reasoning, with no metered API-key fallback.` + alternative;
}

/** No grant is inferred from tool availability. Browser navigation stays an explicit agent action. */
const unavailable = (code: 'web_search_not_configured' | 'web_search_credential_unavailable', provider: WebSearchRoute['provider'] | null) => ({
  status: 'unavailable' as const, code, provider,
  message: 'Search API unavailable. Use the existing browser tool for public web research; do not create a provider account or credential.',
  fallback: { tool: 'browser', action: 'command', automatic: false, scope: 'public-web' },
});

export async function searchWeb(route: WebSearchRoute | null, person: PersonConfig, query: string, signal?: AbortSignal) {
  if (route === null) return unavailable('web_search_not_configured', null);
  switch (route.provider) {
    case 'parallel': return searchParallel(route.keyPath, query, signal);
    case 'openai-codex': return searchCodex(route.model, person.brokerPort, query, signal);
  }
}

async function searchParallel(path: string, query: string, signal?: AbortSignal) {
  let key: string;
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const value: unknown = raw.startsWith('{') ? JSON.parse(raw).apiKey : raw;
    if (typeof value !== 'string' || !value.trim()) return unavailable('web_search_credential_unavailable', 'parallel');
    key = value.trim();
  } catch {
    // File errors and malformed credentials are readiness, not provider responses. Never echo secrets.
    return unavailable('web_search_credential_unavailable', 'parallel');
  }
  const response = await fetch('https://api.parallel.ai/v1beta/search', {
    method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ objective: query, search_queries: [query], max_results: 6 }),
  });
  if (!response.ok) throw new Error(`Web search HTTP ${response.status}`);
  return compactParallelSearch(await response.json());
}

/** Keep all source evidence and dates, not the provider's request ID and billing counters. */
export function compactParallelSearch(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).results)) return value;
  const { search_id: _id, usage: _usage, ...search } = value as Record<string, any>;
  return { ...search, results: search.results.map((source: any) => {
    if (!source || typeof source !== 'object' || !Array.isArray(source.excerpts)) return source;
    // A contained excerpt adds no evidence. Compare exact text only; distinct wording stays intact.
    const excerpts = [...new Set<unknown>(source.excerpts)];
    return { ...source, excerpts: excerpts.filter(text => typeof text !== 'string'
      || !excerpts.some(other => typeof other === 'string' && other !== text && other.includes(text))) };
  }) };
}

export type CodexSearchResult = {
  provider: 'openai-codex';
  answer: string;
  sources: { url: string; title: string }[];
  searches: string[];
};

const INSTRUCTIONS = 'You are a web search tool for another agent. Always use web_search for the query. Return up to six useful sources with a short factual summary of each, including dates and numbers where relevant. Cite each summary with its source URL. Do not answer from memory.';

/**
 * The broker's typed causes for a request that failed before or during the upstream's answer with nothing kept
 * (deploy/acme-model-broker.mjs). A search is read-only and store:false, so the same request is sent again.
 */
const RETRYABLE = new Set(['upstream_headers_timeout', 'upstream_first_event_timeout', 'upstream_stream_stalled', 'upstream_network_error', 'broker_restarting']);
export const SEARCH_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 250;

export class WebSearchFailure extends Error {
  constructor(message: string, readonly code: string | null) { super(message); }
}

/** Web search through the person's own subscription broker: the subscription model's built-in web_search tool, no API key. */
async function searchCodex(model: string, brokerPort: number, query: string, signal?: AbortSignal): Promise<CodexSearchResult> {
  for (let attempt = 1; ; attempt++) {
    try { return await searchCodexOnce(model, brokerPort, query, signal); } catch (error) {
      if (attempt >= SEARCH_ATTEMPTS || signal?.aborted || !(error instanceof WebSearchFailure) || error.code === null || !RETRYABLE.has(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
}

/**
 * A question asked aloud in a meeting, answered from one web search through the subscription broker, as one or two
 * spoken sentences (meeting-voice.ts reads it to the call). Null when the route is not the subscription search, so the
 * caller hands the question to an agent instead. November 6, 2026 probe (data/meet-scorecard-8e77/round2): 4.7 to 5.2 s
 * on gpt-6-luna at low effort; minimal effort is refused with web_search.
 */
export const SPOKEN_INSTRUCTIONS = 'You answer a question that someone asked aloud in a work meeting. Use web_search, then answer in one or two short spoken sentences that lead with the fact and give its date or source name. No URLs, lists or markdown.';
export async function spokenSearch(route: WebSearchRoute | null, person: PersonConfig, question: string, signal?: AbortSignal): Promise<string | null> {
  if (route?.provider !== 'openai-codex') return null;
  for (let attempt = 1; ; attempt++) {
    try { return (await searchCodexOnce(route.model, person.brokerPort, question, signal, SPOKEN_INSTRUCTIONS)).answer; } catch (error) {
      if (attempt >= SEARCH_ATTEMPTS || signal?.aborted || !(error instanceof WebSearchFailure) || error.code === null || !RETRYABLE.has(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
}

async function searchCodexOnce(model: string, brokerPort: number, query: string, signal?: AbortSignal, instructions = INSTRUCTIONS): Promise<CodexSearchResult> {
  const response = await fetch(`http://127.0.0.1:${brokerPort}/backend-api/codex/responses`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', accept: 'text/event-stream', originator: 'pi' },
    body: JSON.stringify({
      model, store: false, stream: true, instructions, reasoning: { effort: 'low' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: query }] }],
      tools: [{ type: 'web_search' }], tool_choice: 'auto', parallel_tool_calls: true,
    }),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    let code: string | null = null;
    try { const parsed = JSON.parse(text)?.error?.code; if (typeof parsed === 'string') code = parsed; } catch { /* not the broker's JSON error */ }
    throw new WebSearchFailure(`Web search HTTP ${response.status}: ${text}`, code);
  }
  return parseCodexStream(await response.text());
}

/** The upstream tags every citation with ?utm_source=openai; the other agent only needs the page. */
const cleanUrl = (raw: string) => { try { const url = new URL(raw); url.searchParams.delete('utm_source'); return url.toString(); } catch { return raw; } };

export function parseCodexStream(stream: string): CodexSearchResult {
  const answer: string[] = [];
  const sources = new Map<string, { url: string; title: string }>();
  let searched = false;
  const searches: string[] = [];
  let completed = false;
  for (const line of stream.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event: any;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    if (event.type === 'error' || event.type === 'response.failed') {
      const code: unknown = event.code ?? event.response?.error?.code;
      throw new WebSearchFailure(`Web search failed: ${code ?? 'error'}: ${event.message ?? event.response?.error?.message ?? ''}`.trim(), typeof code === 'string' ? code : null);
    }
    if (event.type === 'response.completed' || event.type === 'response.done') completed = true;
    if (event.type !== 'response.output_item.done') continue;
    const item = event.item;
    if (item?.type === 'web_search_call') {
      searched = true;
      for (const q of item.action?.queries ?? (item.action?.query ? [item.action.query] : [])) if (typeof q === 'string' && !searches.includes(q)) searches.push(q);
    } else if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        if (part?.type !== 'output_text') continue;
        answer.push(part.text);
        for (const a of part.annotations ?? []) {
          if (a?.type !== 'url_citation' || typeof a.url !== 'string') continue;
          const url = cleanUrl(a.url);
          const source = sources.get(url) ?? { url, title: a.title || url };
          if (a.title) source.title = a.title;
          // The answer already contains every cited summary; copying its lines into excerpts repeats evidence.
          sources.set(url, source);
        }
      }
    }
  }
  if (!completed) throw new WebSearchFailure('Web search failed: stream ended before response.completed', null);
  if (!searched) throw new WebSearchFailure('Web search failed: the subscription model did not search the web', null);
  if (!answer.length) throw new WebSearchFailure('Web search failed: no answer in the completed response', null);
  if (!sources.size) throw new WebSearchFailure('Web search failed: no cited sources in the answer', null);
  return { provider: 'openai-codex', answer: answer.join('\n\n'), sources: [...sources.values()], searches };
}
