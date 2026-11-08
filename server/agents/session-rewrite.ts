import { createReadStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { rewriteStrings } from '../message-rewrite.js';

// These are protocol identifiers, not conversation text. A message such as "user" must not change message roles.
const identifiers = new Set(['type', 'role', 'id', 'parentId', 'firstKeptEntryId', 'toolCallId', 'toolName', 'model', 'provider', 'api', 'stopReason', 'customType', 'sessionId', 'timestamp', 'version']);
const removedSummary = '[Conversation summary removed after a message was edited or deleted.]';

/** Rewrite text, arguments and tool output while leaving Pi's entry graph and message protocol intact. */
export function rewriteSessionValue(value: unknown, rewrite: (text: string) => string, dropSummaries = true): unknown {
  if (typeof value === 'string') return rewrite(value);
  if (Array.isArray(value)) return value.map(item => rewriteSessionValue(item, rewrite, dropSummaries));
  if (!value || typeof value !== 'object') return value;
  const original = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(original)) {
    if (key === 'arguments' || key === 'details') result[key] = rewriteStrings(item, rewrite);
    else result[key] = identifiers.has(key) || key === 'name' && original.type === 'toolCall' ? item : rewriteSessionValue(item, rewrite, dropSummaries);
  }
  // Provider item references/signatures describe the original text, not the edited text.
  if (JSON.stringify(original) !== JSON.stringify(result)) {
    delete result.thinkingSignature;
    delete result.textSignature;
    delete result.signature;
  }
  if (dropSummaries && (original.type === 'compaction' || original.type === 'branch_summary')) {
    // A generated summary can paraphrase a secret so no exact matcher can reliably recover it.
    result.summary = removedSummary;
    delete result.details;
  }
  return result;
}

const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
/** A line that is not valid JSON (an old transcript can hold a truncated tool result) is scrubbed as text, in its escaped and its plain form. */
function rewriteMalformedLine(line: string, rewrite: (text: string) => string): string {
  const direct = rewrite(line);
  if (direct !== line) return direct;
  const plain = line.replace(/\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g, (_m, hex: string | undefined, ch: string | undefined) => hex ? String.fromCharCode(parseInt(hex, 16)) : escapes[ch!] ?? ch!);
  const scrubbed = rewrite(plain);
  return scrubbed === plain ? line : JSON.stringify(scrubbed).slice(1, -1);
}

function parseLine(line: string): { value: unknown } | null {
  try { return { value: JSON.parse(line) }; } catch { return null; }
}

/** The caller first stops and unloads every writer. Rename also separates any hard-linked trimmed transcript. */
export async function rewriteSessionFile(path: string, rewrite: (text: string) => string): Promise<void> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  const temporary = `${path}.rewrite-${randomUUID()}`;
  const output = await open(temporary, 'wx', info.mode & 0o777);
  let changed = false;
  try {
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (!line.trim()) { await output.write('\n'); continue; }
      const parsed = parseLine(line);
      const next = parsed ? JSON.stringify(rewriteSessionValue(parsed.value, rewrite)) : rewriteMalformedLine(line, rewrite);
      changed ||= next !== line;
      await output.write(next + '\n');
    }
    await output.close();
    if (changed) await rename(temporary, path);
    else await unlink(temporary);
  } catch (error) {
    await output.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Search without dropping summaries: an unrelated summary is not itself a reason to stop its worker. */
export function sessionValueContains(value: unknown, rewrite: (text: string) => string): boolean {
  return JSON.stringify(value) !== JSON.stringify(rewriteSessionValue(value, rewrite, false));
}

/** Parsing megabytes of transcript per line dominates the search. A line holding a copy must hold a needle, plain or JSON-escaped (Pi writes JSON.stringify, which keeps non-ASCII as is). */
function lineFilter(rewrite: (text: string) => string): (line: string) => boolean {
  const needles = (rewrite as { needles?: string[] }).needles;
  if (!needles) return () => true;
  const variants = [...new Set(needles.flatMap(needle => [needle, JSON.stringify(needle).slice(1, -1)]))].filter(Boolean);
  return line => variants.some(variant => line.includes(variant));
}

export async function sessionFileContains(path: string, rewrite: (text: string) => string): Promise<boolean> {
  const mayContain = lineFilter(rewrite);
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim() || !mayContain(line)) continue;
      const parsed = parseLine(line);
      if (parsed ? sessionValueContains(parsed.value, rewrite) : rewriteMalformedLine(line, rewrite) !== line) return true;
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally { lines.close(); input.destroy(); }
}
