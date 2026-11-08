import type { SearchPage, SearchQuery } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { parseSearchQuery } from '../db/search.js';
import { linkCall } from './link.js';

/** Home calls every directly linked database once. The /search link handler only searches its local database. */
export async function searchChats(deps: Deps, personId: string, input: SearchQuery, localOnly = false): Promise<SearchPage> {
  const parsed = parseSearchQuery(input);
  const query: SearchQuery = { ...parsed, chat: parsed.chat ?? undefined, after: parsed.after ?? undefined, before: parsed.before ?? undefined };
  const siblings = localOnly ? [] : deps.config.link?.siblings ?? [];
  const [local, ...remote] = await Promise.all([
    deps.store.searchMessages(personId, query),
    ...siblings.map(async socket => {
      const result = await linkCall<SearchPage>(socket, '/search', { personId, query }, 3000);
      if (result.ok) return result.value;
      if (!result.error.startsWith('not_here')) void deps.store.logError(`search:${personId}`, result.error).catch(() => {});
      return { items: [], ...(result.error.startsWith('not_here') ? {} : { unavailable: ['Some linked chats could not be searched.'] }) };
    }),
  ]);
  const unique = new Map<string, SearchPage['items'][number]>();
  for (const item of [local!, ...remote].flatMap(p => p.items)) {
    const key = `${item.conversationId}:${item.messageId ?? item.text}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const unavailable = [...new Set([local!, ...remote].flatMap(p => p.unavailable ?? []))];
  return { ...(unavailable.length ? { unavailable } : {}), items: [...unique.values()].sort((a, b) => Number(a.messageId !== null) - Number(b.messageId !== null) || b.createdAt - a.createdAt).slice(0, parsed.limit) };
}
