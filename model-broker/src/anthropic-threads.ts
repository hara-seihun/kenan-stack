/**
 * Anthropic message threads (beta `message-threads-2026-08-12`, public 2026-11-02).
 *
 * Clients keep sending the whole conversation to the broker. The broker remembers, per conversation, account and
 * fixed request fields, the conversation the API holds under the last response id. When the next request's messages
 * start with exactly that conversation (the earlier messages plus the reply as it was streamed), only the new messages
 * go upstream as a `continue`; anything else (compaction, an edited system prompt or tool list, another account, an
 * expired thread, a reply the client changed) goes as a full `create`, which is the same request as without threads.
 * A thread error from the API (unknown or expired thread, already continued, unsupported) arrives before any byte
 * reaches the client, so the broker resends the full conversation and the client never sees it.
 * Docs: https://platform.claude.com/docs/en/build-with-claude/message-threads
 */
import { createHash } from "node:crypto";

export const THREADS_BETA = "message-threads-2026-08-12";
/** The API keeps a thread for 5 minutes after the last response it stored; continuing later costs a 404 round trip. */
export const THREAD_TTL_MS = 285_000;
/** A conversation the API refuses to thread is sent unthreaded for this long. */
const UNTHREADED_MS = 3_600_000;
const MAX_ENTRIES = 8192;
/** Fields that may change between turns of one thread; every other field is fixed by the create request. */
const FREE_FIELDS = new Set(["messages", "max_tokens", "stop_sequences", "stream", "metadata", "service_tier", "thread"]);

type Json = any;

/** JSON without cache_control (breakpoints move every turn) or null fields. Key order is kept: the reply is rebuilt in
 * the order Pi replays it, and a client that reorders keys only costs a full resend. */
const dropped = (key: string, value: unknown) => key === "cache_control" || value === null ? undefined : value;
const canonical = (value: Json): string => JSON.stringify(value, dropped);

/** One message as the API holds it: string content is one text block, and blank text blocks are dropped. */
export function canonicalMessage(message: Json): string {
  if (!message || typeof message !== "object") return canonical(message);
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const blocks = Array.isArray(content)
    ? content.filter((block: Json) => !(block && block.type === "text" && typeof block.text === "string" && block.text.trim() === ""))
    : content;
  return canonical({ ...message, content: blocks });
}

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);
const link = (chain: string, message: string) => createHash("sha256").update(chain).update("\n").update(message).digest("hex");

/** chains[i] identifies messages[0..i). */
function chains(messages: Json[]): string[] {
  const out = [""];
  for (const message of messages) out.push(link(out[out.length - 1], canonicalMessage(message)));
  return out;
}

const betaSet = (header: string | undefined) => [...new Set((header ?? "").split(",").map(value => value.trim()).filter(value => value && value !== THREADS_BETA))].sort();

function fingerprint(body: Json, betaHeader: string | undefined): string {
  const fixed: Json = {};
  for (const key of Object.keys(body)) if (!FREE_FIELDS.has(key)) fixed[key] = body[key];
  return createHash("sha256").update(canonical(fixed)).update("\n").update(betaSet(betaHeader).join(",")).digest("hex");
}

interface Entry { id: string; length: number; chain: string; beforeReply: string; replyShape: string; expiresAt: number; fromReplay: boolean }

export type ThreadAttempt =
  | { mode: "off"; reason: string }
  | { mode: "create" | "continue"; reason: string; key: string; bytes: Uint8Array<ArrayBuffer>; beta: string; chain: string; length: number; sent: number; replay: boolean };

export interface PlanInput {
  /** Whether this conversation may use threads (listener setting and the client's own choice). */
  enabled: boolean;
  /** Broker affinity of the conversation; undefined when the client named no session. */
  conversation: string | undefined;
  accountId: string;
  body: Json;
  betaHeader: string | undefined;
  /** Set after a thread error: "create" resends the whole conversation, "off" sends it without a thread. */
  force?: "create" | "off";
  now?: number;
}

export interface ThreadFallback { next: "create" | "off"; code: string }

/** Rebuilds the reply from the stream, the way the API stores it, and says whether the API kept it. */
export class ReplyRecorder {
  id: string | undefined;
  private blocks: Json[] = [];
  private json = new Map<number, string>();
  private stop: string | undefined;
  private finished = false;
  private unknown: string | undefined;
  private fallback = false;
  firstTokenAt: number | undefined;
  usage: Json = {};

  observe(event: Json, now = Date.now()): void {
    switch (event?.type) {
      case "message_start":
        this.id = event.message?.id;
        if (event.message?.usage) this.usage = { ...this.usage, ...event.message.usage };
        if (Array.isArray(event.message?.content) && event.message.content.length) this.unknown = "prefilled_content";
        return;
      case "content_block_start": {
        const block = event.content_block ?? {};
        this.firstTokenAt ??= now;
        if (block.type === "text") this.blocks[event.index] = { type: "text", text: block.text ?? "" };
        else if (block.type === "thinking") this.blocks[event.index] = { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" };
        else if (block.type === "redacted_thinking") this.blocks[event.index] = { type: "redacted_thinking", data: block.data };
        else if (block.type === "tool_use") this.blocks[event.index] = { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
        else this.unknown ??= `block:${block.type}`;
        return;
      }
      case "content_block_delta": {
        this.firstTokenAt ??= now;
        const block = this.blocks[event.index];
        const delta = event.delta ?? {};
        if (!block) return;
        if (delta.type === "text_delta" && block.type === "text") block.text += delta.text;
        else if (delta.type === "thinking_delta" && block.type === "thinking") block.thinking += delta.thinking;
        else if (delta.type === "signature_delta" && block.type === "thinking") block.signature += delta.signature;
        else if (delta.type === "input_json_delta" && block.type === "tool_use") this.json.set(event.index, (this.json.get(event.index) ?? "") + delta.partial_json);
        else this.unknown ??= `delta:${delta.type}`;
        return;
      }
      case "message_delta":
        this.stop = event.delta?.stop_reason ?? this.stop;
        if (event.usage) {
          this.usage = { ...this.usage, ...event.usage };
          if (Array.isArray(event.usage.iterations) && event.usage.iterations.some((item: Json) => item?.type === "fallback_message")) this.fallback = true;
        }
        return;
      case "message_stop":
        this.finished = true;
        return;
    }
  }

  /** The reply the API stored under `id`, or why it may not have kept one. */
  stored(): { ok: true; id: string; message: Json } | { ok: false; reason: string } {
    if (!this.finished || !this.id) return { ok: false, reason: "stream_incomplete" };
    if (this.unknown) return { ok: false, reason: this.unknown };
    if (this.fallback) return { ok: false, reason: "fallback_model" };
    if (this.stop === "refusal" || this.stop === "max_tokens") return { ok: false, reason: `stop_${this.stop}` };
    const content: Json[] = [];
    for (const [index, block] of this.blocks.entries()) {
      if (!block) return { ok: false, reason: "block_gap" };
      if (block.type === "tool_use" && this.json.has(index)) {
        const raw = this.json.get(index)!;
        try { block.input = raw.trim() ? JSON.parse(raw) : {}; } catch { return { ok: false, reason: "tool_input_unparsed" }; }
      }
      content.push(block);
    }
    return { ok: true, id: this.id, message: { role: "assistant", content } };
  }
}

const shape = (message: Json) => Array.isArray(message?.content)
  ? message.content.map((block: Json) => `${block?.type}:${JSON.stringify(block).length}`).join(" ")
  : typeof message?.content;

export class AnthropicThreads {
  private entries = new Map<string, Entry>();
  private unthreaded = new Map<string, number>();

  plan(input: PlanInput): ThreadAttempt {
    const { body, betaHeader } = input;
    const now = input.now ?? Date.now();
    if (!input.enabled) return { mode: "off", reason: "disabled" };
    if (input.conversation === undefined) return { mode: "off", reason: "no_session" };
    if (body.thread !== undefined) return { mode: "off", reason: "client_thread" };
    if (!Array.isArray(body.messages) || body.messages.length === 0) return { mode: "off", reason: "no_messages" };
    const key = `${input.conversation}|${input.accountId}|${fingerprint(body, betaHeader)}`;
    if (input.force === "off") return { mode: "off", reason: "thread_refused" };
    if ((this.unthreaded.get(key) ?? 0) > now) return { mode: "off", reason: "unthreaded" };
    const beta = [...betaSet(betaHeader), THREADS_BETA].join(",");
    const all = chains(body.messages);
    const length = body.messages.length;
    const create = (reason: string): ThreadAttempt => ({ mode: "create", reason, key, beta, chain: all[length], length, sent: length, replay: input.force === "create",
      bytes: encode(JSON.stringify({ ...body, thread: { type: "create" } })) });
    const entry = this.entries.get(key);
    if (input.force === "create") { this.entries.delete(key); return create("replay"); }
    if (!entry) return create("new");
    if (entry.expiresAt <= now) { this.entries.delete(key); return create("expired"); }
    if (length <= entry.length) return create("history_shorter");
    if (all[entry.length] !== entry.chain) {
      const reason = all[entry.length - 1] === entry.beforeReply
        ? `reply_differs (stored ${entry.replyShape}; sent ${shape(body.messages[entry.length - 1])})`
        : "history_changed";
      return create(reason);
    }
    const fresh = body.messages.slice(entry.length);
    if (fresh[0]?.role === "assistant") return create("new_turn_starts_with_assistant");
    // Each response id can be continued once: the entry is spent now, and the reply to this request replaces it.
    this.entries.delete(key);
    const { system: _system, tools: _tools, ...rest } = body;
    return { mode: "continue", reason: "prefix", key, beta, chain: all[length], length, sent: fresh.length, replay: entry.fromReplay,
      bytes: encode(JSON.stringify({ ...rest, messages: fresh, thread: { type: "continue", previous_message_id: entry.id } })) };
  }

  /** After a thread error that arrived before the stream: what to send instead. Undefined: not a thread error to repair. */
  fallback(attempt: ThreadAttempt, status: number, text: string, now = Date.now()): ThreadFallback | undefined {
    if (attempt.mode === "off" || (status !== 400 && status !== 404)) return undefined;
    let code = "";
    try { code = String(JSON.parse(text)?.error?.details?.error_code ?? ""); } catch { /* not JSON */ }
    let message = "";
    try { message = String(JSON.parse(text)?.error?.message ?? ""); } catch { /* not JSON */ }
    const off = (why: string): ThreadFallback => {
      this.entries.delete(attempt.key);
      // Only a refusal of threads themselves keeps this conversation unthreaded; any other error is the request's own.
      if (why.startsWith("thread_") || /\bthread\b/i.test(message)) {
        this.unthreaded.set(attempt.key, now + UNTHREADED_MS);
        if (this.unthreaded.size > MAX_ENTRIES) this.unthreaded.delete(this.unthreaded.keys().next().value!);
      }
      return { next: "off", code: why };
    };
    if (attempt.mode === "continue") {
      // A continue right after a replay that is still not found: the API can't store this conversation.
      if (status === 404 && code === "thread_not_found" && attempt.replay) return off("thread_not_found_after_replay");
      return { next: "create", code: code || `http_${status}` };
    }
    // A create the API refused: send the conversation as it would go without threads.
    return off(code || `http_${status}`);
  }

  /** After a threaded stream ends: remember the conversation the API now holds, or forget the thread. */
  settle(attempt: ThreadAttempt, reply: ReplyRecorder, now = Date.now()): string {
    if (attempt.mode === "off") return attempt.reason;
    const stored = reply.stored();
    if (!stored.ok) { this.entries.delete(attempt.key); return stored.reason; }
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.delete(attempt.key);
    this.entries.set(attempt.key, { id: stored.id, length: attempt.length + 1, chain: link(attempt.chain, canonicalMessage(stored.message)),
      beforeReply: attempt.chain, replyShape: shape(stored.message), expiresAt: now + THREAD_TTL_MS, fromReplay: attempt.mode === "create" && attempt.replay });
    return "stored";
  }

  forget(attempt: ThreadAttempt): void {
    if (attempt.mode !== "off") this.entries.delete(attempt.key);
  }
}
