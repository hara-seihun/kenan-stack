// Tool cards request only the names they actually show, including archived runs.
import { useEffect, useMemo, useState } from 'react';
import { api } from './client.js';
import type { Bootstrap } from '../shared/contract.js';
import { json, object, outcome, text, type ToolPart } from './toolData.js';

type Names = Map<string, string>;
const identifier = /^(?:[0-9a-f]{8}(?:[0-9a-f-]{0,28})|(?:manager|kenaznia)[:\-][\w-]+)$/i;
type CachedName = { until: number; request: Promise<string | null> };
let cacheOwner = '';
const cache = new Map<string, CachedName>();
const pending = new Map<string, { resolve(name: string | null): void; reject(error: unknown): void }>();
let scheduled = false;
/** Reuse the names already supplied for navigation, including chats held on another channel. */
export function seedReferences(boot: Bootstrap): void {
  if (cacheOwner !== boot.me.id) {
    cacheOwner = boot.me.id; cache.clear();
    for (const waiter of pending.values()) waiter.reject(new Error('Account changed'));
    pending.clear();
  }
  for (const row of [...boot.people, ...boot.agents, ...boot.goals, ...boot.conversations]) {
    const name = 'name' in row ? row.name : row.title;
    cache.set(row.id, { until: Date.now() + 60_000, request: Promise.resolve(name) });
  }
}

/** All cards mounted in one render ask together; answers are cached per reference, not as a giant bootstrap. */
function loadNames(ids: string[]): Promise<Names> {
  const requests = ids.map(id => {
    const saved = cache.get(id);
    if (saved && saved.until > Date.now()) return saved.request.then(name => [id, name] as const);
    const request = new Promise<string | null>((resolve, reject) => pending.set(id, { resolve, reject }));
    cache.set(id, { until: Date.now() + 60_000, request });
    void request.catch(() => { if (cache.get(id)?.request === request) cache.delete(id); });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const entries = [...pending]; pending.clear();
        for (let i = 0; i < entries.length; i += 128) {
          const batch = entries.slice(i, i + 128);
          void api<Record<string, string | null>>(`/references?ids=${encodeURIComponent(batch.map(([id]) => id).join(','))}`).then(
            names => { for (const [id, waiter] of batch) waiter.resolve(names[id] ?? null); },
            error => { for (const [, waiter] of batch) waiter.reject(error); });
        }
      });
    }
    return request.then(name => [id, name] as const);
  });
  return Promise.all(requests).then(entries => new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
}
// Results can also name their own rows; index those IDs once for short references.
const prefixes = new WeakMap<Names, Map<string, string[]>>();
const matchingKeys = (names: Names, id: string): string[] => {
  if (id.length < 8 || !names.size) return [];
  let index = prefixes.get(names);
  if (!index) {
    index = new Map();
    for (const key of names.keys()) {
      const prefix = key.slice(0, 8), bucket = index.get(prefix);
      if (bucket) bucket.push(key); else index.set(prefix, [key]);
    }
    prefixes.set(names, index);
  }
  return (index.get(id.slice(0, 8)) ?? []).filter(key => key.startsWith(id));
};

/** Resolve display values only; the original call and its transport/loading state stay untouched. */
const referenceIds = (value: string) => value.match(/\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b|\b(?:manager|kenaznia)[:\-][\w-]+/gi) ?? [];

export function useToolReferences(part: ToolPart, visibleText?: string) {
  const [loaded, setLoaded] = useState<Names | null>(null);
  const [failed, setFailed] = useState(false);
  const detail = visibleText === undefined;
  const result = useMemo(() => !detail || part.result === null ? null : json(outcome(part.result).texts[0]), [detail, part.result]);
  // A result can add or override names; keep that small overlay separate from the shared directory.
  const names = useMemo(() => {
    const names: Names = new Map();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const row = object(value), id = text(row.id), name = text(row.name ?? row.title);
      if (id && name) names.set(id, name);
      Object.values(value).forEach(collect);
    };
    collect(result);
    return names;
  }, [result]);
  const lookup = (id: string): string | undefined => {
    const exact = names.get(id) ?? loaded?.get(id);
    if (exact !== undefined || id.length < 8) return exact;
    const matches = new Set([...matchingKeys(names, id), ...(loaded ? matchingKeys(loaded, id) : [])]);
    if (matches.size !== 1) return undefined;
    const key = matches.values().next().value!;
    return names.get(key) ?? loaded?.get(key);
  };
  const kind = part.name === 'workers' ? 'worker' : part.name === 'goals' ? 'goal' : part.name === 'rooms' ? 'chat' : '';
  const referenceKind = (key: string) => /goal/i.test(key) ? 'goal' : /chat|conversation/i.test(key) ? 'chat' : /agent|worker|parent|handedOffBy/.test(key) ? 'worker' : key === 'id' || key === 'to' ? kind : '';
  const requested = useMemo(() => {
    const ids = new Set<string>();
    const add = (value: string) => { for (const id of referenceIds(value)) if (!names.has(id) && matchingKeys(names, id).length !== 1) ids.add(id); };
    const collect = (value: unknown, key = ''): void => {
      if (typeof value === 'string') { if (referenceKind(key) || /^(goal|subtree|broadcast|kenan):/.test(value)) add(value); }
      else if (Array.isArray(value)) value.forEach(v => collect(v, key));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
    };
    if (visibleText === undefined) { collect(part.args); collect(result); } else add(visibleText);
    return [...ids].sort();
  }, [part.args, result, kind, visibleText, names]);
  const requestedKey = requested.join(',');
  useEffect(() => {
    if (!requestedKey) return;
    let active = true;
    setLoaded(null); setFailed(false);
    void loadNames(requestedKey.split(',')).then(value => { if (active) setLoaded(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [requestedKey]);
  const label = (value: string, fallback = kind || 'reference'): string => {
    if (value.startsWith('kenan:')) return `kenan:${label(value.slice(6), 'chat')}`;
    const group = /^(goal|subtree|broadcast):(.+)$/.exec(value);
    if (group) return `${group[1] === 'goal' ? 'agents on' : group[1] === 'subtree' ? 'agents under' : 'broadcast to'} ${label(group[2]!, group[1] === 'goal' ? 'goal' : 'worker')}`;
    return lookup(value) ?? (identifier.test(value) ? `${failed ? 'Unavailable' : loaded ? 'Unknown' : 'Loading'} ${fallback}${!failed && !loaded ? '…' : ''}` : value);
  };
  const display = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return lookup(value) ?? (referenceKind(key) || /^(goal|subtree|broadcast|kenan):/.test(value) ? label(value, referenceKind(key) || kind || 'reference') : value);
    if (Array.isArray(value)) return value.map(v => display(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, display(v, k)]));
    return value;
  };
  const lineText = (value: string) => value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b|\b(?:manager|kenaznia)[:\-][\w-]+/gi, id => lookup(id) ?? (kind ? label(id) : id));
  // Closed cards need only their title and subject. Resolve full argument/result trees on expansion.
  return { get args() { return object(display(part.args)); }, get result() { return display(result); }, label, lineText };
}
