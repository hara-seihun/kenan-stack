// Texts from the person's phone. The Android app forwards incoming SMS and its default messaging app's notifications
// (RCS, chat) to POST /api/ext/texts; they are kept only in the person's home, one JSON line each, and agents read
// them with the texts tool, including waiting a few minutes for a code they just triggered.
import { watch } from 'node:fs';
import { chown, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { PersonConfig } from '../config.js';
import { fail } from '../db/errors.js';
import { personOf } from '../http/app.js';
import { pageSize } from '../tools/pagination.js';
import type { Extension } from '../types.js';

export interface Text { id: string; source: 'sms' | 'notification'; app: string; sender: string; body: string; at: number; storedAt: number }
type Incoming = Omit<Text, 'storedAt'>;
type Parsed = { ok: true; value: Incoming[] } | { ok: false; error: string };

/** The same message reaching us twice (as an SMS and as its Messages notification, or again from the inbox sync) is kept once. */
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const MAX_WAIT_SECONDS = 600;

export const textsDir = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan');
export const textsFile = (person: Pick<PersonConfig, 'home'>) => join(textsDir(person), 'texts.jsonl');

export function parseTexts(raw: unknown): Parsed {
  const list = (raw as { texts?: unknown } | null)?.texts;
  if (!Array.isArray(list) || list.length > 500) return { ok: false, error: 'texts: array of at most 500' };
  const value: Incoming[] = [];
  for (const item of list) {
    const t = item as Record<string, unknown> | null;
    if (!t || typeof t !== 'object') return { ok: false, error: 'each text must be an object' };
    const { id, source, app, sender, body, at } = t;
    if (typeof id !== 'string' || !id || id.length > 200) return { ok: false, error: 'id: 1–200 characters' };
    if (source !== 'sms' && source !== 'notification') return { ok: false, error: 'source: "sms" or "notification"' };
    if (typeof app !== 'string' || !app || app.length > 200) return { ok: false, error: 'app: 1–200 characters' };
    if (typeof sender !== 'string' || !sender || sender.length > 200) return { ok: false, error: 'sender: 1–200 characters' };
    if (typeof body !== 'string' || !body || body.length > 10_000) return { ok: false, error: 'body: 1–10000 characters' };
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return { ok: false, error: 'at: epoch milliseconds' };
    value.push({ id, source, app, sender, body, at });
  }
  return { ok: true, value };
}

export async function readTexts(person: Pick<PersonConfig, 'home'>): Promise<Text[]> {
  const data = await readFile(textsFile(person), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line) as Text);
}

async function ensureDir(person: PersonConfig) {
  const dir = textsDir(person);
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created) for (let d = dir; d.length >= created.length; d = join(d, '..')) await chown(d, person.uid, person.gid);
  return dir;
}

const writers = new Map<string, Promise<unknown>>();
/** Appends the texts not already kept; one writer per file at a time. Returns the newly kept ones. */
export function storeTexts(person: PersonConfig, incoming: Incoming[], now: number): Promise<Text[]> {
  const file = textsFile(person);
  const run = (writers.get(file) ?? Promise.resolve()).then(async () => {
    const kept = await readTexts(person);
    const ids = new Set(kept.map(t => t.id));
    const fresh: Text[] = [];
    for (const t of incoming) {
      if (ids.has(t.id)) continue;
      if ([...kept, ...fresh].some(k => k.body === t.body && Math.abs(k.at - t.at) < DUPLICATE_WINDOW_MS)) continue;
      ids.add(t.id); fresh.push({ ...t, storedAt: now });
    }
    if (!fresh.length) return fresh;
    await ensureDir(person);
    const handle = await open(file, 'a', 0o600);
    try {
      const { uid } = await handle.stat();
      if (uid !== person.uid) await handle.chown(person.uid, person.gid);
      await handle.appendFile(fresh.map(t => JSON.stringify(t) + '\n').join(''));
    } finally { await handle.close(); }
    return fresh;
  });
  writers.set(file, run.catch(() => {}));
  return run;
}

export const textMatches = (query: string | undefined) => (t: Text) => !query || `${t.sender}\n${t.body}\n${t.app}`.toLowerCase().includes(query.toLowerCase());

/** Resolves with the newest matching text stored at or after `since`, or null once the timeout passes. */
export async function waitForText(person: PersonConfig, query: string | undefined, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Text | null> {
  const dir = await ensureDir(person);
  const found = async () => (await readTexts(person)).filter(t => t.storedAt >= since && textMatches(query)(t)).at(-1) ?? null;
  return new Promise<Text | null>((resolve, reject) => {
    let settled = false, checking = Promise.resolve();
    const finish = (value: Text | null, error?: unknown) => {
      if (settled) return; settled = true;
      watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve(value);
    };
    const check = () => { checking = checking.then(found).then(t => { if (t) finish(t); }, e => finish(null, e)); };
    const aborted = () => finish(null, new Error('Wait cancelled'));
    const watcher = watch(dir, (_event, name) => { if (name === 'texts.jsonl') check(); });
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener('abort', aborted);
    check();
  });
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });

export const textsExtension: Extension = {
  id: 'texts', name: 'Texts',
  promptSnippet: 'Texts: the texts tool reads the SMS and messaging-app messages arriving on the person\'s phone, so confirmation and sign-in codes reach you without asking them. After triggering a code, call texts with action "wait".',
  routes(app, deps) {
    app.use('*', async (c, next) => { if (!deps.person(personOf(c))?.extensions.includes('texts')) fail('forbidden', 'Texts are not enabled'); await next(); });
    app.post('/', async c => {
      const parsed = parseTexts(await c.req.json().catch(() => null));
      if (!parsed.ok) return fail('invalid_input', parsed.error);
      const stored = await storeTexts(deps.person(personOf(c))!, parsed.value, deps.now());
      return c.json({ ok: true, value: { stored: stored.length } });
    });
  },
  tool: ({ person, deps }) => ({
    name: 'texts', files: 'none', label: 'Texts',
    description: `Read ${person.name}'s incoming text messages (SMS, and RCS/chat messages from her messaging app's notifications), forwarded by her phone within seconds. action "recent": newest first; query filters by a case-insensitive substring of sender, body or app (e.g. "DoorDash"); limit 1–50 (20 when omitted). action "wait": after you trigger a code, returns the newest matching text that arrives within timeoutSeconds (1–${MAX_WAIT_SECONDS}), or {timedOut: true}; sinceSeconds also accepts matching texts that arrived up to that many seconds before the call (use it when the code may already have come in). The phone's sender for short-code SMS is a number, so query by words in the body.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('recent'), Type.Literal('wait')]),
      query: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_SECONDS })),
      sinceSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })),
    }),
    execute: async (_id, raw: unknown, signal) => {
      const args = raw as { action: 'recent' | 'wait'; query?: string; limit?: number; timeoutSeconds?: number; sinceSeconds?: number };
      switch (args.action) {
        case 'recent': {
          const texts = (await readTexts(person)).filter(textMatches(args.query)).sort((a, b) => b.at - a.at);
          const limit = pageSize(args.limit);
          return result({ items: texts.slice(0, limit), more: texts.length > limit });
        }
        case 'wait': {
          if (args.timeoutSeconds === undefined) throw new Error('timeoutSeconds is required for wait');
          const now = deps.now();
          const text = await waitForText(person, args.query, now - (args.sinceSeconds ?? 0) * 1000, args.timeoutSeconds * 1000, signal);
          return result(text ? { text } : { timedOut: true, waitedSeconds: args.timeoutSeconds });
        }
        default: throw new Error(`Unknown texts action ${String((args as { action: unknown }).action)}`);
      }
    },
  }),
};
