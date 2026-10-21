import { mkdir, writeFile, stat, chown } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { collapseSystemMessages, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { estimateTokens, generateSummaryWithUsage, serializeConversation, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { isRefusalMessage, type RequestModel, type StreamFunction } from './refusal.js';

type Failure = { code: 'context_compaction_failed'; message: string } | { code: 'context_input_too_large'; message: string; limit: number };
type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
/** Alice's ruling (2026-10-18): compaction starts at 600k. Recent turns stay verbatim and compaction never fails a turn. */
export const COMPACTION_TRIGGER_TOKENS = 600_000;
export const RECENT_TAIL_TOKENS = 40_000;
export type LimitKind = 'compaction' | 'request';
export interface Budget { inputTokens: number; inputLimit: number }

// Replay system-section/tool updates once, matching the provider's effective prompt.
// Pi's estimator accounts for text, images, tools and reasoning without counting JSON bytes as tokens.
export function estimateRequestTokens(context: unknown): number {
  const value = (context ?? {}) as Partial<Context>;
  const normalized = collapseSystemMessages(normalizeContext({ ...value, messages: value.messages ?? [] }));
  return normalized.messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** compaction: where history starts being summarized. request: the most the model can accept with its output reserve. */
export function inputLimit(window: number, maxOutput: number, kind: LimitKind): Result<number> {
  if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(maxOutput) || maxOutput < 0 || window <= maxOutput)
    return { ok: false, error: { code: 'context_compaction_failed', message: 'The selected model has no valid context budget.' } };
  const available = window - maxOutput;
  const safe = available - Math.min(8192, Math.ceil(available * 0.1));
  return { ok: true, value: kind === 'request' ? safe : Math.min(COMPACTION_TRIGGER_TOKENS, safe) };
}

export function contextBudget(context: unknown, window: number, maxOutput: number, kind: LimitKind, observedTokens?: number): Result<Budget> {
  const limit = inputLimit(window, maxOutput, kind);
  if (!limit.ok) return limit;
  const inputTokens = observedTokens !== undefined && Number.isFinite(observedTokens)
    ? Math.max(0, observedTokens) : estimateRequestTokens(context);
  const budget = { inputTokens, inputLimit: limit.value };
  return inputTokens < limit.value ? { ok: true, value: budget } : { ok: false, error: { code: 'context_input_too_large', limit: limit.value, message: `Request context reached its ${kind} input budget (${inputTokens} tokens; limit ${limit.value}).` } };
}

/** Lossless journal, bounded provider projection. No model call or tool execution. */
export async function boundRequestContext<T extends { messages: any[] }>(context: T, directory: string): Promise<T> {
  const messages = await Promise.all(context.messages.map(async message => {
    if (message.role !== 'user' && message.role !== 'toolResult') return message;
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) <= 32768) return message;
    const digest = createHash('sha256').update(encoded).digest('hex');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = await stat(dirname(directory));
    if (process.getuid?.() === 0) await chown(directory, owner.uid, owner.gid);
    const path = join(directory, `${digest}.json`);
    await writeFile(path, encoded, { mode: 0o600 });
    if (process.getuid?.() === 0) await chown(path, owner.uid, owner.gid);
    const text = typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.type === 'text' ? block.text : '[non-text content retained in artifact]').join('\n');
    const notice = `\n[Oversized ${message.role} bounded for model context only. FULL ORIGINAL: ${path} (JSON, SHA256 ${digest}, ${Buffer.byteLength(encoded)} bytes). Read in bounded offsets before acting on omitted details. Original ask and tool operation IDs remain unchanged; this is NOT a new execution.]\n`;
    return { ...message, content: [{ type: 'text', text: text.slice(0, 12000) + notice + text.slice(-4000) }] };
  }));
  return { ...context, messages };
}

export function textChunks(text: string, byteLimit: number): string[] {
  if (!Number.isInteger(byteLimit) || byteLimit < 4) throw new Error('Invalid chunk byte limit');
  const chunks: string[] = [];
  let chunk = '', size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > byteLimit) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += char; size += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function foldSummary(text: string, previous: string | undefined, byteLimit: number, summarize: (chunk: string, previous?: string) => Promise<string>): Promise<string> {
  let summary = previous;
  for (const chunk of textChunks(text, byteLimit)) summary = await summarize(chunk, summary);
  if (!summary?.trim()) throw new Error('Compaction produced no summary');
  return summary;
}

// Pi uses 80% of reserveTokens as the summary output cap. Leave enough room
// for a complete checkpoint, and retry only a truncated generation once.
export async function summarizeWithHeadroom<T>(maxTokens: number, summarize: (reserve: number) => Promise<T>): Promise<T> {
  try { return await summarize(20_480); }
  catch (error) {
    if (!String(error).includes('generation hit the token cap') || maxTokens <= 16_384) throw error;
    return summarize(40_960);
  }
}

interface ProjectedEntry { messages: { role: string }[]; sourceEntry: { id: string; type: string } }
const CUT_ROLES = new Set(['user', 'assistant', 'custom', 'bashExecution']);

/**
 * The earliest turn or assistant boundary whose verbatim tail fits the tail budget, or the latest
 * boundary when even that tail is larger. Tool results stay with their call. Returns null when
 * nothing before the boundary is new history (only a previous checkpoint), so compaction cannot loop.
 */
export function chooseCut(entries: ProjectedEntry[], tokens: (entry: ProjectedEntry) => number, tailBudget: number): number | null {
  const cuts = entries.map((entry, index) => index).filter(index => index > 0
    && entries[index]!.sourceEntry.type !== 'compaction' && entries[index]!.messages.some(message => CUT_ROLES.has(message.role)));
  if (!cuts.length) return null;
  const tail: number[] = new Array(entries.length + 1).fill(0);
  for (let index = entries.length - 1; index >= 0; index--) tail[index] = tail[index + 1]! + tokens(entries[index]!);
  const cut = cuts.find(index => tail[index]! <= tailBudget) ?? cuts[cuts.length - 1]!;
  const summarized = entries.slice(0, cut);
  return summarized.every(entry => entry.sourceEntry.type === 'compaction' || entry.messages.every(message => message.role === 'compactionSummary')) ? null : cut;
}

const SUMMARY_INSTRUCTIONS = 'Rewrite the previous checkpoint using this next chronological segment. Return one complete replacement checkpoint of at most 1,500 words; do not append segment summaries. Quote the most recent user or manager instruction in this history verbatim, then record binding constraints, current decisions, unfinished work, and exact IDs/file paths needed to continue. Consolidate repetition and omit obsolete completed-work detail. The full original transcript remains saved on disk.';

type AgentMessage = Parameters<AgentSession['agent']['convertToLlm']>[0][number];
type LlmMessage = Awaited<ReturnType<AgentSession['agent']['convertToLlm']>>[number];

/** Why one summary attempt produced no checkpoint. A refusal is the provider declining the content, not an outage. */
export type FailureKind = 'refused' | 'truncated' | 'failed';
export type SummaryFailure = { kind: FailureKind; model: string; transcript: 'full' | 'reduced' | null; message: string };
/** model: every segment summarized from the full transcript. reduced: some segment needed the redacted transcript. structured: the rest was assembled without a model. */
export type CompactionRoute = 'model' | 'reduced' | 'structured';
export interface CompactionOutcome { route: CompactionRoute; failures: SummaryFailure[] }

export function failureKind(error: unknown): { kind: FailureKind; message: string } {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  if (message.includes('generation hit the token cap')) return { kind: 'truncated', message };
  if (isRefusalMessage(message)) return { kind: 'refused', message };
  return { kind: 'failed', message };
}
export const describeFailures = (failures: SummaryFailure[]) =>
  failures.map(failure => `${failure.kind} by ${failure.model}${failure.transcript ? ` (${failure.transcript} transcript)` : ''}: ${failure.message}`).join(' | ');

const PINNED = /<original-task>[\s\S]*?<\/original-task>\n*/g;
const pinned = (task: string) => `Original task (verbatim, pinned across compactions):\n<original-task>\n${clip(task, 8000)}\n</original-task>\n\n`;
const clip = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)} …[${text.length - limit} more characters in the transcript]`;
const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.flatMap(part => part?.type === 'text' ? [part.text as string] : []).join('\n') : '';

/** Long opaque runs (hex/base64 dumps, binary) carry no task state and are the likeliest false positives for content filters. */
export function scrub(value: string): string {
  return value
    .replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]+/g, '')
    .replace(/(?:\b(?:0x)?[0-9a-fA-F]{2,16}\b[\s,:]+){16,}/g, '[hex dump omitted] ')
    .replace(/\b[0-9a-fA-F]{48,}\b/g, '[hex omitted]')
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[base64 omitted]');
}

/** The same history without thinking, raw tool output or dumps: what was asked, said and done, not what came back. */
export function reduceForSummary(messages: LlmMessage[]): LlmMessage[] {
  return messages.map(message => {
    if (message.role === 'user') return { ...message, content: clip(scrub(text(message.content)), 4000) };
    if (message.role === 'toolResult') {
      const size = text(message.content).length;
      return { ...message, content: [{ type: 'text' as const, text: `[${message.toolName} output omitted: ${size} characters${message.isError ? ', error' : ''}]` }] };
    }
    if (message.role !== 'assistant') return message;
    const content: typeof message.content = message.content.flatMap((block): typeof message.content =>
      block.type === 'text' ? [{ ...block, text: clip(scrub(block.text), 2000) }]
      : block.type === 'toolCall' ? [{ ...block, arguments: { call: clip(scrub(JSON.stringify(block.arguments)), 200) } }]
      : []);
    return { ...message, content };
  }) as LlmMessage[];
}

interface Item { raw: AgentMessage; llm: LlmMessage[]; bytes: number }

function toolCalls(items: Item[]) {
  return items.flatMap(item => item.llm.flatMap(message => message.role === 'assistant'
    ? message.content.flatMap(block => block.type === 'toolCall' ? [{ name: block.name, args: block.arguments as Record<string, unknown> }] : []) : []));
}

function filesTouched(items: Item[]): string[] {
  const seen = new Map<string, number>();
  let order = 0;
  for (const call of toolCalls(items)) {
    const values = Object.values(call.args).flatMap(value => Array.isArray(value) ? value : [value]).filter((value): value is string => typeof value === 'string');
    for (const value of values) for (const match of value.matchAll(/(?:^|[\s'"=(:])((?:~|\/)(?:[\w.@+-]+\/)*[\w.@+-]+)/g)) {
      const path = match[1]!;
      if (path.length > 2 && !/^\/(?:dev|proc)\/(?:null|stdin|stdout|stderr|fd)/.test(path)) seen.set(path, order++);
    }
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([path]) => path).slice(-60);
}

/** A checkpoint assembled from the transcript itself when no model will summarize it. It never calls a model. */
export function structuredCheckpoint(previous: string | undefined, items: Item[], failures: SummaryFailure[], transcript: string): string {
  const instructions = items.filter(item => item.raw.role === 'user').map(item => clip(text((item.raw as { content: unknown }).content), 3000)).filter(Boolean);
  const notes = items.flatMap(item => item.llm.flatMap(message => message.role === 'assistant' ? [text(message.content)] : [])).filter(note => note.trim());
  const calls = toolCalls(items);
  const files = filesTouched(items);
  const reason = describeFailures(failures.slice(-1)) || 'no summary model';
  const sections = [
    `## Checkpoint assembled without a model summary\nThe summary model did not summarize this part of the history (${reason}). This checkpoint was built mechanically from the transcript. The full transcript is ${transcript}; read it in bounded offsets when an omitted detail matters. Continue the task; nothing here was cancelled.`,
    previous?.trim() ? `## Previous checkpoint\n${clip(previous.trim(), 16000)}` : '',
    instructions.length ? `## Instructions received in this span, oldest first${instructions.length > 12 ? ` (${instructions.length - 12} earlier ones are in the transcript)` : ''}\n${instructions.slice(-12).map(instruction => `- ${instruction}`).join('\n')}` : '',
    files.length ? `## Files and paths touched\n${files.join('\n')}` : '',
    calls.length ? `## Last tool calls (${calls.length} in this span)\n${calls.slice(-20).map(call => `- ${call.name}: ${clip(scrub(JSON.stringify(call.args)), 240)}`).join('\n')}` : '',
    notes.length ? `## Latest assistant notes\n${notes.slice(-6).map(note => clip(scrub(note), 1500)).join('\n\n')}` : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** One bounded summary call on one model. */
export interface Summarizer { model: string; summarize(chunk: string, previous: string | undefined): Promise<string> }
export interface HistoryCompaction {
  convert(messages: AgentMessage[]): Promise<LlmMessage[]>;
  /** The agent's model first, then its configured refusal fallbacks. Models whose auth failed are absent and listed in unavailable. */
  summarizers: Summarizer[];
  unavailable: SummaryFailure[];
  chunkBytes: number;
  transcript: string;
  originalTask: string | null;
  signal?: AbortSignal;
}

/**
 * Always yields a checkpoint, so a refused or failed summary can never leave compaction to be retried on the next request.
 * Each chronological segment tries the full transcript on every summarizer, then the reduced one; a model that refused
 * moves to the back for later segments. The first segment no attempt summarizes ends model use, and the rest (with the
 * model's checkpoint so far) is assembled deterministically. At most 2 × models failed calls per compaction.
 */
export async function compactHistory(older: AgentMessage[], options: HistoryCompaction): Promise<{ summary: string; outcome: CompactionOutcome }> {
  const unpinned = older.map(message => message.role === 'compactionSummary' ? { ...message, summary: message.summary.replace(PINNED, '') } : message) as AgentMessage[];
  const items: Item[] = [];
  for (const raw of unpinned) {
    const llm = await options.convert([raw]);
    items.push({ raw, llm, bytes: Buffer.byteLength(serializeConversation(llm)) });
  }
  const segments: Item[][] = [];
  let size = Infinity;
  for (const item of items) {
    if (size + item.bytes > options.chunkBytes) { segments.push([]); size = 0; }
    segments.at(-1)!.push(item); size += item.bytes;
  }
  const failures: SummaryFailure[] = [...options.unavailable];
  const refusedBy = new Set<string>();
  let route: CompactionRoute = 'model';
  let summary: string | undefined;
  let structured: string | undefined;
  const attempt = async (summarizer: Summarizer, transcript: 'full' | 'reduced', input: string): Promise<boolean> => {
    try { summary = await foldSummary(input, summary, options.chunkBytes, summarizer.summarize); return true; }
    catch (error) {
      options.signal?.throwIfAborted();
      const failure = { ...failureKind(error), model: summarizer.model, transcript };
      failures.push(failure);
      if (failure.kind === 'refused') refusedBy.add(summarizer.model);
      return false;
    }
  };
  segments: for (const [index, segment] of segments.entries()) {
    const llm = segment.flatMap(item => item.llm);
    const order = [...options.summarizers].sort((a, b) => Number(refusedBy.has(a.model)) - Number(refusedBy.has(b.model)));
    for (const [transcript, input] of [['full', serializeConversation(llm)], ['reduced', serializeConversation(reduceForSummary(llm))]] as const) {
      for (const summarizer of order) if (await attempt(summarizer, transcript, input)) {
        if (transcript === 'reduced') route = 'reduced';
        continue segments;
      }
    }
    const remaining = segments.slice(index).flat();
    const checkpoint = summary ?? remaining.filter(item => item.raw.role === 'compactionSummary').map(item => (item.raw as { summary: string }).summary).at(-1);
    structured = structuredCheckpoint(checkpoint, remaining.filter(item => item.raw.role !== 'compactionSummary'), failures, options.transcript);
    route = 'structured';
    break;
  }
  const body = structured ?? summary;
  if (!body?.trim()) throw new Error('Compaction produced no summary');
  return { summary: (options.originalTask ? pinned(options.originalTask) : '') + body, outcome: { route, failures } };
}

export interface CompactionEvents { started(): void; recovered(outcome: CompactionOutcome): void }
/** pin-first-task: a worker's first instruction is its assignment and stays verbatim in every checkpoint. */
export type TaskPinning = 'pin-first-task' | 'none';
/** refusalFallbacks: models (same subscription broker) a refused summary is retried on, in order. stream: the provider stream without turn-level refusal recovery, since compaction tries each model itself. */
export interface CompactionPolicy { pinning: TaskPinning; refusalFallbacks: RequestModel[]; stream: StreamFunction }

function originalTask(session: AgentSession, pinning: TaskPinning): string | null {
  if (pinning === 'none') return null;
  const first = session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user');
  return first?.type === 'message' ? text((first.message as { content: unknown }).content).trim() || null : null;
}

/** Install at Pi's public request boundary, covering initial, steered and tool-continuation requests. */
export function installContextBudget(session: AgentSession, runtime: ModelRuntime, events: CompactionEvents, policy: CompactionPolicy): void {
  const previous = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    const prepared = await previous?.(request, signal);
    const directory = resolve(session.sessionManager.getCwd(), `.kenan-context-${session.sessionManager.getSessionId()}`);
    const bounded = (value: typeof request.context) => boundRequestContext(value, directory);
    let context = prepared?.context ?? request.context;
    const model = prepared?.model ?? request.model;
    // Prefer provider-reported usage plus Pi's trailing-message estimate. After a
    // compaction/context edit Pi invalidates stale usage; use the current prompt then.
    const usage = session.getContextUsage?.();
    const observedTokens = usage?.tokens == null ? undefined : usage.tokens
      + estimateRequestTokens(context)
      - estimateRequestTokens({ messages: session.sessionManager.buildSessionProjection().messages });
    const tokensBefore = observedTokens ?? estimateRequestTokens(context);
    const trigger = contextBudget(context, model.contextWindow, model.maxTokens, 'compaction', tokensBefore);
    if (trigger.ok) return { ...prepared, context };
    if (trigger.error.code !== 'context_input_too_large') throw new Error(`${trigger.error.code}: ${trigger.error.message}`);
    const fits = (candidate: unknown, observed?: number) => contextBudget(candidate, model.contextWindow, model.maxTokens, 'request', observed);
    const fixed = { ...context, messages: context.messages.filter(message => message.role === 'system') };
    const fixedBudget = fits(fixed);
    if (!fixedBudget.ok) throw new Error(`${fixedBudget.error.code}: The system prompt and tools exceed the model's input budget. History is unchanged.`);
    const before = session.sessionManager.buildSessionProjection();
    const entries = before.entries.filter(entry => entry.messages.some(message => message.role !== 'system')) as unknown as (ProjectedEntry & typeof before.entries[number])[];
    const tailBudget = Math.min(RECENT_TAIL_TOKENS, Math.floor(trigger.error.limit / 4));
    const cut = chooseCut(entries, entry => entry.messages.filter(message => message.role !== 'system').reduce((total, message) => total + estimateTokens(message as never), 0), tailBudget);
    if (cut === null) {
      if (fits(context, tokensBefore).ok) return { ...prepared, context };
      context = await bounded(context);
      if (fits(context).ok) return { ...prepared, context };
      throw new Error('context_input_too_large: The current instruction and its tool results exceed the available context. Full originals are retained in artifacts and history is unchanged.');
    }
    const keptContext = { ...fixed, messages: [...fixed.messages, ...entries.slice(cut).flatMap(entry => entry.messages).filter(message => message.role !== 'system')] };
    const kept = fits(keptContext);
    if (!kept.ok && !fits(await bounded(keptContext as typeof context)).ok) {
      throw new Error('context_input_too_large: The current instruction and its tool results exceed the available context. Full originals are retained in artifacts and history is unchanged.');
    }
    events.started();
    const firstKeptEntryId = entries[cut]!.sourceEntry.id;
    const older = entries.slice(0, cut).flatMap(entry => entry.messages).filter(message => message.role !== 'system');
    const calls = await Promise.all([model, ...policy.refusalFallbacks.filter(fallback => fallback.id !== model.id)].map(candidate => summaryCall(session, runtime, policy.stream, candidate, signal)));
    const { summary, outcome } = await compactHistory(older as never, {
      convert: async messages => session.agent.convertToLlm(messages),
      summarizers: calls.flatMap(call => call.ok ? [call.value] : []),
      unavailable: calls.flatMap(call => call.ok ? [] : [call.error]),
      chunkBytes: Math.max(1024, Math.min(262144, Math.floor(model.contextWindow * 0.15))),
      transcript: session.sessionManager.getSessionFile() ?? 'in the session journal',
      originalTask: originalTask(session, policy.pinning),
      signal,
    });
    signal?.throwIfAborted();
    if (outcome.failures.length) events.recovered(outcome);
    session.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, { source: 'kenan-context-budget', route: outcome.route, failures: outcome.failures });
    const projection = session.sessionManager.buildSessionProjection();
    session.agent.state.messages = projection.messages;
    context = { ...context, messages: projection.messages };
    if (!fits(context).ok) context = await bounded(context);
    const after = fits(context);
    if (!after.ok) throw new Error(`${after.error.code}: ${after.error.message} The recent turns alone exceed the model's input budget. The full transcript remains saved.`);
    return { ...prepared, context };
  };
}

/** Summary calls retry transient provider errors (overload, network) a bounded number of times; a refusal is not retried. */
export const SUMMARY_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 20_000 };

async function summaryCall(session: AgentSession, runtime: ModelRuntime, stream: StreamFunction, model: RequestModel, signal: AbortSignal | undefined): Promise<{ ok: true; value: Summarizer } | { ok: false; error: SummaryFailure }> {
  const auth = await runtime.getAuth(model, { signal }).catch((error: unknown) => { signal?.throwIfAborted(); return { error }; });
  if (!auth) return { ok: false, error: { kind: 'failed', model: model.id, transcript: null, message: 'Subscription model authentication is unavailable.' } };
  if ('error' in auth) return { ok: false, error: { kind: 'failed', model: model.id, transcript: null, message: `Subscription model authentication failed: ${String(auth.error).slice(0, 300)}` } };
  // Standalone summaries have no mid-conversation effort changes. That mode
  // forces high thinking even for 'off'; adaptive Claude requires thinking,
  // so use its supported low effort instead of silently getting high effort.
  const summaryModel = { ...model, compat: { ...model.compat, supportsMidConvoEffort: false } };
  const summaryThinking = model.api === 'anthropic-messages' ? 'low' : 'off';
  const summaryStream: StreamFunction = (summaryModel, summaryContext, options) => {
    const actual = contextBudget(summaryContext, summaryModel.contextWindow, options?.maxTokens ?? summaryModel.maxTokens, 'request');
    if (!actual.ok) throw new Error(actual.error.message);
    return stream(summaryModel, summaryContext, options);
  };
  const headers = Object.fromEntries(Object.entries(auth.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { ok: true, value: { model: model.id, summarize: async (chunk, previousSummary) => {
    signal?.throwIfAborted();
    const input = [{ role: 'user' as const, content: chunk, timestamp: Date.now() }];
    const result = await summarizeWithHeadroom(model.maxTokens, async reserve => {
      const outputLimit = Math.min(model.maxTokens, Math.floor(reserve * 0.8));
      const summaryBudget = contextBudget({ messages: input, previousSummary }, model.contextWindow, outputLimit, 'request');
      if (!summaryBudget.ok) throw new Error(summaryBudget.error.message);
      return generateSummaryWithUsage(input, summaryModel, reserve, auth.auth.apiKey, headers, signal, SUMMARY_INSTRUCTIONS,
        previousSummary, summaryThinking, summaryStream, undefined, SUMMARY_RETRY, undefined, session.sessionManager.getSessionId());
    });
    return result.text;
  } } };
}
