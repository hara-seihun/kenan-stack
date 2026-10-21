import { Type } from 'typebox';

export const pageParameters = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Page size; initial page is 20, maximum 50.' })),
  cursor: Type.Optional(Type.String({ description: 'nextCursor from the previous page; keep filters unchanged.' })),
};
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface PageRequest { limit?: number; cursor?: string }
export function pageSize(limit?: number): number {
  if (limit === undefined) return 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50');
  return limit;
}
export function pageKey(cursor: string | undefined, scope: string): (string | number)[] | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value.scope === scope && Array.isArray(value.key) && value.key.length > 0 && value.key.every((v: unknown) => typeof v === 'string' || typeof v === 'number' && Number.isFinite(v))) return value.key;
  } catch {}
  throw new Error('Invalid cursor or changed list filters');
}
export function finishPage<T>(rows: T[], limit: number, scope: string, key: (row: T) => (string | number)[]): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ scope, key: key(items[items.length - 1]!) })).toString('base64url') : null };
}
export function arrayPage<T>(rows: T[], args: PageRequest, scope: string, id: (row: T) => string): Page<T> {
  const limit = pageSize(args.limit), key = pageKey(args.cursor, scope);
  if (key && (key.length !== 1 || typeof key[0] !== 'string')) throw new Error('Invalid cursor');
  const sorted = [...rows].sort((a, b) => id(a).localeCompare(id(b), 'en'));
  return finishPage(sorted.filter(row => !key || id(row).localeCompare(String(key[0]), 'en') > 0).slice(0, limit + 1), limit, scope, row => [id(row)]);
}
