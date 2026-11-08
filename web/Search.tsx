import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ConversationSummary, SearchItem, SearchPage } from '../shared/contract.js';
import { api } from './client.js';
import { chatLinkHref, parseChatLink } from './chatLinks.js';
import { formatDate } from './dates.js';
import './search.css';

export interface SearchState {
  revision: number; query: string; chat: string; after: string; before: string;
  items: SearchItem[] | null; partial: boolean; loading: boolean; error: string | null; scroll: number;
}
export const emptySearch: SearchState = { revision: 0, query: '', chat: '', after: '', before: '', items: null, partial: false, loading: false, error: null, scroll: 0 };

/** State belongs to the app so Back from a result returns to the same search. */
export function Search({ state, change, conversations, open }: {
  state: SearchState; change(update: (state: SearchState) => SearchState): void;
  conversations: ConversationSummary[]; open(conversationId: string, message?: string): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { query, chat, after, before } = state;
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = state.scroll; }, []);
  useEffect(() => {
    if (!query.trim()) { change(s => ({ ...s, items: null, partial: false, loading: false, error: null })); return; }
    let gone = false;
    change(s => ({ ...s, loading: true, error: null, partial: false }));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim(), limit: '100' });
      if (chat) params.set('chat', chat);
      if (after) params.set('after', new Date(`${after}T00:00:00`).toISOString());
      if (before) { const end = new Date(`${before}T00:00:00`); end.setDate(end.getDate() + 1); params.set('before', end.toISOString()); }
      void api<SearchPage>(`/search?${params}`).then(result => {
        if (!gone) change(s => ({ ...s, items: result.items, partial: !!result.unavailable?.length, loading: false }));
      }, error => { if (!gone) change(s => ({ ...s, loading: false, error: error instanceof Error ? error.message : String(error) })); });
    }, 250);
    return () => { gone = true; clearTimeout(timer); };
  }, [query, chat, after, before, state.revision]);
  const field = (name: 'query' | 'chat' | 'after' | 'before', value: string) => {
    if (box.current) box.current.scrollTop = 0;
    change(s => ({ ...s, [name]: value, scroll: 0 }));
  };
  return <section className="search-page">
    <form className="search-form" role="search" onSubmit={event => event.preventDefault()}>
      <label className="search-query">Search messages, chats and files<input type="search" value={query} onChange={event => field('query', event.target.value)} placeholder="Search" autoFocus/></label>
      <div className="search-filters">
        <label>Chat<select value={chat} onChange={event => field('chat', event.target.value)}><option value="">All chats</option>{conversations.slice().sort((a, b) => a.title.localeCompare(b.title)).map(c => <option key={c.id} value={c.id}>{c.title || 'Conversation'}</option>)}</select></label>
        <label>From<input type="date" value={after} max={before || undefined} onChange={event => field('after', event.target.value)}/></label>
        <label>Through<input type="date" value={before} min={after || undefined} onChange={event => field('before', event.target.value)}/></label>
      </div>
    </form>
    <div className="search-results" ref={box} onScroll={event => { const scroll = event.currentTarget.scrollTop; change(s => ({ ...s, scroll })); }} aria-busy={state.loading}>
      {state.loading && <p role="status">Searching…</p>}
      {state.partial && <p role="status">Some linked chats could not be searched.</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {!state.loading && !state.error && state.items?.length === 0 && <p role="status">No results.</p>}
      {!state.error && state.items?.map((item, index) => {
        const target = parseChatLink(item.link) ?? { conversationId: item.conversationId, message: item.messageId ?? (item.seq === null ? undefined : String(item.seq)) };
        return <a className="search-result" key={`${item.conversationId}:${item.messageId ?? 'title'}:${index}`} href={chatLinkHref(target)} onClick={event => { event.preventDefault(); open(target.conversationId, target.message); }}>
          <div className="search-result-heading"><strong>{item.conversationTitle || 'Conversation'}</strong><time dateTime={new Date(item.createdAt).toISOString()}>{formatDate(item.createdAt, { hour: '2-digit', minute: '2-digit' })}</time></div>
          <p>{item.snippet || item.text}</p>
        </a>;
      })}
      {!state.loading && state.items && state.items.length >= 100 && <p role="status">Showing 100 results. Narrow your search for more.</p>}
    </div>
  </section>;
}
