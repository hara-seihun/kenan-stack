// Her Kenaznia chat as the 🌀 quick panel sees it (web/organized/Bubble.tsx), adapted in the Organized chunk from the app
// shell's live history, and the screen line sent with each panel message.
import { isNoReply, unread, type Bootstrap, type ConversationSummary, type Message, type MessagePart } from '../../../shared/contract.js';
import { api, isUnreachable } from '../../../web/client.js';
import { upsert, type History } from '../../../web/history.js';
import type { Drafts } from '../../../web/drafts.js';
import { waitLine, type WaitLine } from '../../../web/BusyLine.js';

/** The screen a quick-panel message is sent from, as her Kenaznia reads it: "Chats, Open". At most 200 characters. */
export const seenFromText = (parts: (string | null | undefined)[]) =>
  parts.map(p => (p ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ').slice(0, 200);

/** One line of the panel's conversation: hers or her Kenaznia's. */
/** `files`: the files a Kenaznia message carries (documents she can open from the panel), never her own. */
export interface QuickMessage { id: string; mine: boolean; text: string; at: number; streaming: boolean; editedAt?: number | null; deletedAt?: number | null; files: FileAttachment[] }
type FileAttachment = Extract<MessagePart, { type: 'file' }>;
export type SendOutcome = { ok: true } | { ok: false; error: string };
/** Her Kenaznia chat as the quick panel needs it (the app's live history, or the demo's). */
export interface QuickChat {
  conversationId: string; name: string;
  /** null until its history has loaded. */
  messages: QuickMessage[] | null;
  /** Kenaznia is working on an answer in this chat. */
  working: boolean;
  /** Her message here waits while Kenaznia answers elsewhere: where it is (the busy line); null otherwise. */
  busy: WaitLine | null;
  unread: boolean;
  /** The chat's draft, the same one its composer shows: the panel's field. */
  readonly draft: string;
  subscribeDraft?(callback: () => void): () => void;
  setDraft(next: string | ((current: string) => string)): void;
  load(): void;
  /** clientId makes a retry of the same words idempotent. */
  send(text: string, seenFrom: string, clientId: string): Promise<SendOutcome>;
  read(): void;
}

const loading = new Set<string>();
type Setter<T> = (change: (current: T) => T) => void;
/** Her Kenaznia chat from the app shell's live state (its history, its loader, its bootstrap); null when her Kenaznia
 *  answers elsewhere or not at all. A loaded history follows the stream, so the panel shows answers as they arrive. */
export function quickChat(boot: Bootstrap, history: Record<string, History>, setHistory: Setter<Record<string, History>>, load: (id: string, mode: 'open') => unknown, setBoot: Setter<Bootstrap | null>, drafts: Drafts): QuickChat | null {
  const id = boot.manager.kind === 'here' ? boot.manager.conversationId : null, main = boot.conversations.find(c => c.id === id);
  if (!id || !main) return null;
  return {
    conversationId: id, name: boot.agents.find(a => a.conversationId === id && a.role === 'manager')?.name ?? main.title,
    messages: history[id]?.messages.flatMap<QuickMessage>(m => {
      const files = m.role === 'assistant' ? m.parts.filter(p => p.type === 'file') : [];
      return m.display !== 'shown' || (!m.deletedAt && !m.text.trim() && !files.length) || isNoReply(m.text) ? []
        : m.role === 'human' && m.authorId === boot.me.id ? [{ id: m.id, mine: true, text: m.deletedAt ? 'message deleted' : m.text, at: m.createdAt, streaming: false, editedAt: m.editedAt, deletedAt: m.deletedAt, files: [] }]
        : m.role === 'assistant' ? [{ id: m.id, mine: false, text: m.text, at: m.createdAt, streaming: m.state === 'streaming', files }] : [];
    }) ?? null,
    get draft() { return drafts.get()[id] ?? ''; }, subscribeDraft: callback => drafts.subscribe(id, callback), setDraft: next => drafts.set(all => ({ ...all, [id]: typeof next === 'function' ? next(all[id] ?? '') : next })),
    working: !!boot.activity[id], busy: boot.activity[id] ? null : waitLine(boot.waiting, id, boot.conversations), unread: unread(main),
    load: () => { if (!loading.has(id)) { loading.add(id); void Promise.resolve(load(id, 'open')).finally(() => loading.delete(id)); } },
    read: () => void api<ConversationSummary>(`/conversations/${id}`, 'PATCH', { readThrough: main.lastSeq })
      .then(c => setBoot(b => b && ({ ...b, conversations: b.conversations.map(x => x.id === c.id ? { ...x, readThrough: c.readThrough } : x) })), () => {}),
    async send(text, seenFrom, clientId) {
      try {
        const m = await api<Message>(`/conversations/${id}/messages`, 'POST', { clientId, text, fileIds: [], clientSentAt: Date.now(), seenFrom });
        setHistory(all => all[id] ? { ...all, [id]: upsert(all[id], m) } : all);
        return { ok: true };
      } catch (e) { return { ok: false, error: isUnreachable(e) ? "Kenan can't be reached right now." : e instanceof Error ? e.message : String(e) }; }
    },
  };
}
