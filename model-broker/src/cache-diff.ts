/**
 * Why did the prompt cache miss? For each Claude request, compare it with the previous request of the same
 * conversation and model, segment by segment, and report only hashes and positions (never content): system prompt,
 * tools, the other request settings (which keys changed), and the first message that differs, with its role and block
 * type, and whether the history was appended to, rewritten, or truncated. cache-watch names the changed segment.
 */
import { createHash } from "node:crypto";

type Json = any;
const MAX_ENTRIES = 4096;
/** Moves every turn or has no effect on the cached prefix. */
const NOT_SETTINGS = new Set(["messages", "system", "tools", "max_tokens", "stop_sequences", "stream", "metadata", "service_tier", "thread"]);
const dropped = (key: string, value: unknown) => key === "cache_control" || value === null ? undefined : value;
const hash = (value: Json) => createHash("sha256").update(JSON.stringify(value ?? "null", dropped)).digest("hex").slice(0, 8);

interface Snapshot { system: string; tools: string; settings: Record<string, string>; beta: string; messages: string[] }

export interface CacheDiff {
  /** "first": no earlier call to compare with. */
  history: "first" | "same" | "append" | "rewrite" | "truncate";
  system: string; tools: string; settings: string;
  changed: string[];
  firstDiff: { index: number; role: string | null; block: string | null } | null;
}

function snapshot(body: Json, beta: string | undefined): Snapshot {
  const settings: Record<string, string> = {};
  for (const key of Object.keys(body)) if (!NOT_SETTINGS.has(key)) settings[key] = hash(body[key]);
  const messages = Array.isArray(body.messages) ? body.messages.map((message: Json) => hash(message)) : [];
  return { system: hash(body.system), tools: hash(body.tools), settings, beta: hash(beta), messages };
}

export class CacheDiffer {
  private readonly last = new Map<string, Snapshot & { raw: Json[] }>();

  observe(key: string, body: Json, beta: string | undefined): CacheDiff {
    const now = snapshot(body, beta);
    const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
    const before = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, { ...now, raw: messages.map(m => ({ role: m?.role ?? null, block: blockType(m) })) });
    while (this.last.size > MAX_ENTRIES) this.last.delete(this.last.keys().next().value!);
    const settings = hash(now.settings);
    const out: CacheDiff = { history: "first", system: now.system, tools: now.tools, settings, changed: [], firstDiff: null };
    if (!before) return out;
    if (before.system !== now.system) out.changed.push("system");
    if (before.tools !== now.tools) out.changed.push("tools");
    if (before.beta !== now.beta) out.changed.push("beta");
    for (const k of new Set([...Object.keys(before.settings), ...Object.keys(now.settings)])) if (before.settings[k] !== now.settings[k]) out.changed.push(`setting:${k}`);
    const common = Math.min(before.messages.length, now.messages.length);
    let i = 0;
    while (i < common && before.messages[i] === now.messages[i]) i++;
    if (i < common) {
      out.history = "rewrite";
      const m = messages[i];
      out.firstDiff = { index: i, role: m?.role ?? null, block: blockType(m) };
    } else if (now.messages.length > before.messages.length) out.history = "append";
    else if (now.messages.length < before.messages.length) { out.history = "truncate"; out.firstDiff = { index: now.messages.length, role: before.raw[now.messages.length].role, block: before.raw[now.messages.length].block }; }
    else out.history = "same";
    return out;
  }
}

function blockType(message: Json): string | null {
  if (!message) return null;
  if (typeof message.content === "string") return "text";
  return Array.isArray(message.content) && message.content[0] ? String(message.content[0].type ?? null) : null;
}
