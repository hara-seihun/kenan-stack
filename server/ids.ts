import type { Goal } from '../shared/contract.js';
import type { Deps } from './types.js';

/**
 * Every id an agent types (worker, goal, wake, peer recipient) is chat-visible as its first 8 characters, so each tool
 * accepts the full id or a unique prefix of at least 8 characters, resolved here and nowhere else.
 */
export const MIN_ID_PREFIX = 8;
export type IdKind = 'worker' | 'goal' | 'wake' | 'agent' | 'room' | 'todo' | 'question';
export type IdError = `${IdKind}_not_found` | `${IdKind}_id_ambiguous` | 'worker_archived';
export class IdFailure extends Error {
  constructor(readonly code: IdError, message: string) { super(`${code}: ${message}`); }
}

export type IdMatch<T> = { ok: true; value: T } | { ok: false; code: IdError; message: string };

export function matchId<T extends { id: string }>(items: readonly T[], ref: string, kind: IdKind, hint = ''): IdMatch<T> {
  const exact = items.find(item => item.id === ref);
  if (exact) return { ok: true, value: exact };
  const lower = ref.trim().toLowerCase();
  const matches = lower.length >= MIN_ID_PREFIX ? items.filter(item => item.id.toLowerCase().startsWith(lower)) : [];
  if (matches.length > 1) return { ok: false, code: `${kind}_id_ambiguous`, message: `${ref} matches ${matches.map(item => item.id).join(', ')}; give more characters` };
  if (matches[0]) return { ok: true, value: matches[0] };
  const short = lower.length < MIN_ID_PREFIX ? ` (a prefix needs at least ${MIN_ID_PREFIX} characters)` : '';
  return { ok: false, code: `${kind}_not_found`, message: `no ${kind} has the id ${ref} or starts with it${short}${hint}` };
}

export function resolveId<T extends { id: string }>(items: readonly T[], ref: unknown, kind: IdKind, hint = ''): T {
  if (typeof ref !== 'string' || !ref.trim()) throw new IdFailure(`${kind}_not_found`, `an id is required`);
  const found = matchId(items, ref, kind, hint);
  if (!found.ok) throw new IdFailure(found.code, found.message);
  return found.value;
}

/** A goal named by its id or a unique prefix of at least 8 characters. */
export async function goalOf(deps: Pick<Deps, 'store'>, ownerId: string, ref: unknown): Promise<Goal> {
  if (typeof ref === 'string') { const exact = await deps.store.getGoal(ownerId, ref); if (exact) return exact; }
  return resolveId(typeof ref === 'string' ? await deps.store.goalsMatching(ownerId, ref.trim()) : [], ref, 'goal', "; goals create returns a new goal's id");
}
