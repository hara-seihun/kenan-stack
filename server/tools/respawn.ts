import { open } from 'node:fs/promises';
import type { AgentInfo } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { peekWorkers } from './peek.js';

/** Where the first brief sits in a session file: its opening entries, never far in. */
const BRIEF_SCAN_BYTES = 2 * 1024 * 1024;
const BRIEF_MAX = 8000;

/** The first message a worker was given (its brief), read from the start of its session file; null when there is none. */
export async function firstBrief(sessionPath: string | null): Promise<string | null> {
  if (!sessionPath) return null;
  const handle = await open(sessionPath, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(BRIEF_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BRIEF_SCAN_BYTES, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.includes('"role":"user"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
        const content = entry.message.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(c => c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? [(c as { text: string }).text] : []).join('\n') : '';
        return text.length > BRIEF_MAX ? `${text.slice(0, BRIEF_MAX)}… [${text.length} chars]` : text;
      } catch { continue; }
    }
    return null;
  } finally { await handle.close(); }
}

/** Checkouts a worker named in its brief or recent tool calls, so its successor finds its work in progress. */
export function checkoutsIn(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\/home\/kenan(?:-research)?\/(?:work\/clones|clones|work)\/[A-Za-z0-9._-]+/g)) found.add(m[0]);
  return [...found].slice(0, 10);
}

/** What a fresh worker taking over gets: the old one's brief, its last words and tool calls, its checkouts and last report. */
export async function handoffFor(deps: Deps, ownerId: string, old: AgentInfo, addendum: string | undefined): Promise<string> {
  const [brief, [view]] = await Promise.all([firstBrief(await deps.store.agentSessionPath(old.id)), peekWorkers(deps, ownerId, [old], 'detailed')]);
  const said = view!.said.map(m => `- ${m.agoS}s ago: ${m.text ?? `(thinking) ${m.thinking ?? ''}`}`).join('\n');
  const did = view!.did.map(c => `- ${c.agoS}s ago: ${c.tool} ${c.args}${'result' in c ? ` → ${c.result}` : ' (was running)'}${c.error ? ' (error)' : ''}`).join('\n');
  const checkouts = checkoutsIn([brief ?? '', ...view!.did.map(c => `${c.args} ${'result' in c ? c.result : ''}`)]);
  return [
    `You take over from worker ${old.name} (${old.id}), which was stopped and replaced with you. Its conversation is not carried over; here is what it had. Check what already took effect (commits, deploys, jobs, files) before repeating anything, then carry on to the same end state.`,
    addendum ? `From the agent that respawned you: ${addendum}` : '',
    `Its brief:\n${brief ?? '(not found)'}`,
    said ? `What it said last (oldest first):\n${said}` : '',
    did ? `Its last tool calls (oldest first):\n${did}` : '',
    checkouts.length ? `Checkouts it was using: ${checkouts.join(', ')}` : '',
    view!.lastReport ? `Its last report (${view!.lastReport.status}): ${view!.lastReport.text}` : '',
  ].filter(Boolean).join('\n\n');
}
