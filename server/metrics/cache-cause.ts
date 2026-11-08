// Why an agent's prompt cache missed, from the model broker's journal: each Anthropic call line carries `conversation` (the first 16 hex of
// sha256(principal NUL agentId)) and `cacheDiff` (what changed against that conversation's previous call). The cache alert names the
// commonest causes for the agents it lists.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface BrokerCall {
  conversation: string; input: number | null; cacheRead: number | null; cacheWrite: number | null;
  cacheDiff: { history: 'first' | 'same' | 'append' | 'rewrite' | 'truncate'; changed: string[]; firstDiff: { index: number; role: string | null; block: string | null } | null } | null;
}

/** A call missed when under 90% of its prompt came from the cache. */
const missed = (c: BrokerCall) => {
  const prompt = (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
  return prompt > 0 && (c.cacheRead ?? 0) / prompt < 0.9;
};

export const conversationOf = (ownerId: string, agentId: string) => createHash('sha256').update(`${ownerId}\0${agentId}`).digest('hex').slice(0, 16);

/** The reasons one call's cache missed, in plain words. */
export function causesOf(d: NonNullable<BrokerCall['cacheDiff']>): string[] {
  const causes = d.changed.map(k => k.startsWith('setting:') ? `${k.slice(8)} setting changed` : k === 'beta' ? 'beta headers changed' : `${k} changed`);
  const at = d.firstDiff;
  const what = at ? ` (${at.role ?? 'unknown role'}, ${at.block ?? 'unknown'} block)` : '';
  if (d.history === 'rewrite' && at) causes.push(`message ${at.index} rewritten${what}`);
  else if (d.history === 'truncate' && at) causes.push(`history cut back to ${at.index} messages${what}`);
  else if (d.history === 'first') causes.push('first call of a conversation');
  return causes.length ? causes : ['nothing changed (cache expired or evicted)'];
}

/** "6 misses, 4 × message 41 rewritten (assistant, thinking block), 2 × tools changed" for one agent's calls, or null when none missed. */
export function causeSummary(calls: BrokerCall[], top = 3): string | null {
  const misses = calls.filter(missed);
  if (!misses.length) return null;
  const counts = new Map<string, number>();
  for (const c of misses) {
    const label = c.cacheDiff ? causesOf(c.cacheDiff).join(' + ') : 'no cache fingerprint';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const rest = ranked.slice(top).reduce((s, [, n]) => s + n, 0);
  return [`${misses.length} miss${misses.length === 1 ? '' : 'es'}`, ...ranked.slice(0, top).map(([l, n]) => `${n} × ${l}`), ...(rest ? [`${rest} × other`] : [])].join(', ');
}

// Include the standalone Claude broker and shared entrance on Acme, plus the older
// combined broker used on other hosts. Missing fingerprints mean no diagnosis, not a miss.
type JournalReader = (args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
const readJournal: JournalReader = (args, options) => promisify(execFile)('journalctl', args, options);

/** The broker's Anthropic calls in a finite journal window, grouped by conversation. */
export async function readBrokerCalls(sinceMs: number, now: number, read: JournalReader = readJournal): Promise<Map<string, BrokerCall[]>> {
  let stdout: string;
  try {
    ({ stdout } = await read([
      '-u', 'kenan-claude-broker.service', '-u', 'pi-stack-next-employee-models.service', '-u', 'kenan-model-broker.service',
      '--since', `@${Math.floor((now - sinceMs) / 1000)}`, '--until', `@${Math.floor(now / 1000)}`,
      '-o', 'cat', '--no-pager', '--quiet', '-n', '10000', '-g', 'broker_anthropic_call',
    ], { timeout: 10_000, maxBuffer: 8 << 20 }));
  } catch (error) {
    // journalctl --grep returns 1 for an empty match set. Do not hide permission,
    // timeout, output-limit, or other actual journal failures as an empty result.
    const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean; signal?: unknown } | null;
    if (e?.code === 1 && e.stdout === '' && e.stderr === '' && !e.killed && !e.signal) return new Map();
    throw error;
  }
  return parseBrokerCalls(stdout);
}

export function parseBrokerCalls(journal: string): Map<string, BrokerCall[]> {
  const byConversation = new Map<string, BrokerCall[]>();
  for (const line of journal.split('\n')) {
    if (!line.includes('"broker_anthropic_call"')) continue;
    let call: BrokerCall & { type?: string };
    try { call = JSON.parse(line); } catch { continue; }
    if (call.type !== 'broker_anthropic_call' || typeof call.conversation !== 'string') continue;
    (byConversation.get(call.conversation) ?? byConversation.set(call.conversation, []).get(call.conversation)!).push(call);
  }
  return byConversation;
}
