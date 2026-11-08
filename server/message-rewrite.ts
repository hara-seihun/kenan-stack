import type { Message } from '../shared/contract.js';

export type MessageRewriter = ((text: string) => string) & { needles: string[] };

/** Match copies of the original text, including credentials quoted on their own in later replies. */
export function messageRewriter(message: Pick<Message, 'text' | 'parts'>, replacement: string): MessageRewriter {
  const originals = [message.text, ...message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])];
  const needles = new Set<string>(), secretValues = new Set<string>();
  const add = (value: string, secret = false) => { if (value.trim()) { needles.add(value); if (secret) secretValues.add(value); } };
  for (const original of originals) {
    add(original);
    for (const line of original.split(/\r?\n/)) if (line.trim().length >= 24) add(line.trim());
    // A numeric or punctuated single value can itself be a short credential; ordinary greetings are whole lines only.
    if (/^\S+$/.test(original.trim())) add(original.trim(), /[^A-Za-z]/.test(original.trim()));
    // Values named by the author, not a registry of vendor credential formats.
    for (const match of original.matchAll(/\b(?:password|passwd|passphrase|secret|token|api[ _-]?key|credential|pin)(?:\s+(?:is|was))?\s*(?:[:=]\s*|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\s,;]+))/gi)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4]!;
      add(value, true);
      if (match[4]) add(value.replace(/[.!?]$/, ''), true);
    }
    // Random-looking values can be copied without their surrounding sentence.
    for (const match of original.matchAll(/[A-Za-z0-9_+\/.=~-]{12,}/g)) {
      const value = match[0];
      if (/[a-zA-Z]/.test(value) && /[0-9]/.test(value) && new Set(value).size >= 6) add(value, true);
    }
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  // Include the replacement itself as a protected span so linked-host retries cannot expand it again.
  const alternatives = [...new Set([...ordered, ...(replacement ? [replacement] : [])])].sort((a, b) => b.length - a.length);
  const pattern = ordered.length ? new RegExp(alternatives.map(value => {
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (value === replacement) return literal;
    if (value.length <= 16 && /^[A-Za-z]+$/.test(value) && !secretValues.has(value)) return `^${literal}(?=\\r?$)`;
    return value.length < 8 ? `(?<![A-Za-z0-9_])${literal}(?![A-Za-z0-9_])` : literal;
  }).join('|'), 'gm') : null;
  return Object.assign((text: string) => pattern ? text.replace(pattern, () => replacement) : text, { needles: ordered });
}

/** Rewrite string values only; object keys and non-string fields retain their meaning. */
export function rewriteStrings<T>(value: T, rewrite: (text: string) => string, preserveKeys?: ReadonlySet<string>): T {
  if (typeof value === 'string') return rewrite(value) as T;
  if (Array.isArray(value)) return value.map(item => rewriteStrings(item, rewrite, preserveKeys)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, preserveKeys?.has(key) && (typeof item === 'string' || key === 'fileIds') ? item : rewriteStrings(item, rewrite, preserveKeys)])) as T;
  return value;
}
