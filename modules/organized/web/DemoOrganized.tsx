// Organized over made-up data held in memory (?demo=1, for development and tests): its own chunk, so the layout people use
// never downloads the demo.
import { useState } from 'react';
import type { ChatGroup, ConversationPatch, ConversationSummary } from '../../../shared/contract.js';
import { todoEmoji } from '../../../shared/todo.js';
import { formatDate } from '../../../web/dates.js';
import { demoBoot, demoData, type DemoData, type DemoMessage } from './demo.js';
import { OrganizedView, type GroupActions, type OrganizedProps } from './Organized.js';
import type { QuickChat, QuickMessage } from './quick.js';
import { applyTodoChange } from '../../../web/todo/todo.js';

export default function DemoOrganized(p: OrganizedProps) {
  const [data, setData] = useState<DemoData>(() => demoData(p.boot.me, Date.now()));
  const [active, setActive] = useState<string | null>(null);
  const [demoDraft, setDemoDraft] = useState('');
  const d = data;
  const change = (f: (d: DemoData) => DemoData) => setData(f);
  const patchTopic = (id: string, patch: ConversationPatch) => change(x => ({ ...x, conversations: x.conversations.map(c => c.id === id ? applyPatch(c, patch, Date.now()) : c) }));
  const addTopic = (title: string | null, people: string[]): ConversationSummary => {
    const now = Date.now(), c: ConversationSummary = { ...d.conversations.find(x => x.id === 'demo-main')!, id: `demo-new-${now}`, title: title ?? 'New chat', emoji: null, groupId: null, memberIds: [p.boot.me.id, ...people], pinnedAt: null, keyDate: null, keyLabel: null, titleLocked: title !== null, project: false, statusLine: null, projectId: null, lastMessage: null, updatedAt: now };
    change(x => ({ ...x, conversations: [c, ...x.conversations] }));
    return c;
  };
  const open = (id: string) => { setActive(id); p.go('chat'); };
  const chat = d.conversations.find(c => c.id === active) ?? null;
  const groupsApi: GroupActions = {
    create: async input => { const g: ChatGroup = { ...input, id: `demo-g-${Date.now()}`, position: Math.max(0, ...d.groups.map(x => x.position)) + 1 }; change(x => ({ ...x, groups: [...x.groups, g] })); return g; },
    change: async (id, patch) => change(x => ({ ...x, groups: x.groups.map(g => g.id === id ? { ...g, ...patch } : g) })),
    remove: async id => { const rooms = d.conversations.filter(c => c.groupId === id).map(c => c.id); change(x => ({ ...x, groups: x.groups.filter(g => g.id !== id), conversations: x.conversations.map(c => c.groupId === id ? { ...c, groupId: null } : c) })); return rooms; },
  };
  const demoMain = d.messages['demo-main'] ?? [];
  const quick: QuickChat = {
    conversationId: 'demo-main', name: 'Kenaznia', working: false, busy: null, unread: false, load: () => {}, read: () => {}, draft: demoDraft, setDraft: setDemoDraft,
    messages: demoMain.map((m): QuickMessage => ({ ...m, streaming: false, files: [] })),
    send: async (text, _seenFrom, clientId) => {
      change(x => ({ ...x, messages: { ...x.messages, 'demo-main': [...x.messages['demo-main'] ?? [], { id: clientId, mine: true, text, at: Date.now() }, { id: `${clientId}-k`, mine: false, text: 'Demo: nothing is sent, so nobody answers here.', at: Date.now() }] } }));
      return { ok: true };
    },
  };
  return <OrganizedView {...p} quick={quick} boot={demoBoot(p.boot, d)} goals={[]} todos={d.todos} groups={d.groups} groupsApi={groupsApi} active={active} open={open} openProject={id => { setActive(id); p.go('project'); }}
    todo={{
      change: async (id, patch) => change(x => {
        const todos = x.todos.map(t => t.id !== id ? t : applyTodoChange(t, patch, Date.now())), t = todos.find(y => y.id === id);
        const own = t?.ownRoom && (patch.done !== undefined || patch.deleted !== undefined) ? t : null;
        return { ...x, todos, conversations: own ? x.conversations.map(c => c.id === own.conversationId ? { ...c, archived: own.doneAt !== null || own.deletedAt !== null } : c) : x.conversations };
      }),
      answer: async (id, choice) => change(x => ({ ...x, todos: x.todos.map(t => t.id === id ? { ...t, answer: choice, doneAt: Date.now() } : t) })),
      dismiss: async id => change(x => ({ ...x, todos: x.todos.map(t => t.id === id ? { ...t, deletedAt: Date.now(), dismissedAt: Date.now() } : t) })),
      chat: async id => {
        const t = d.todos.find(x => x.id === id); if (!t) return null;
        const linked = t.conversationId ? d.conversations.find(c => c.id === t.conversationId) ?? null : null;
        if (linked || t.doneAt !== null) return linked;
        const now = Date.now(), room: ConversationSummary = { ...d.conversations.find(x => x.id === 'demo-main')!, id: `demo-todo-room-${now}`, title: t.text, emoji: todoEmoji(t.text, t.tag), groupId: null, memberIds: [p.boot.me.id], pinnedAt: null, keyDate: null, keyLabel: null, titleLocked: false, project: false, statusLine: null, projectId: null, archived: false, lastMessage: null, updatedAt: now };
        change(x => ({ ...x, conversations: [room, ...x.conversations], todos: x.todos.map(y => y.id === id ? { ...y, conversationId: room.id, ownRoom: true, updatedAt: now } : y),
          messages: { ...x.messages, [room.id]: [{ id: `${room.id}-1`, mine: false, text: `Let's do this: ${t.text}. Where are you at?`, at: now }] } }));
        return room;
      },
    }}
    detail={s => s === 'chat' ? <DemoChat me={p.boot.me.name} messages={active ? d.messages[active] ?? [] : []} closed={!!chat?.archived}/> : p.detail(s)}
    update={async (id, patch) => { patchTopic(id, patch); const c = d.conversations.find(x => x.id === id); return c ? applyPatch(c, patch, Date.now()) : null; }}
    leave={async id => { change(x => ({ ...x, conversations: x.conversations.filter(c => c.id !== id) })); if (active === id) { setActive(null); p.go('chats'); } }}
    added={() => {}}
    showClosed={() => {}} closedLoaded nextTrip={d.trip} setLayout={l => { p.leaveDemo(); p.setLayout(l); }}
    source={{
      calendar: {
        list: async (from, to) => d.events.filter(e => !e.deleted && Date.parse(e.end.length <= 10 ? `${e.end}T00:00:00` : e.end) > from.getTime() && Date.parse(e.start.length <= 10 ? `${e.start}T00:00:00` : e.start) < to.getTime()),
        update: async (id, input) => change(x => ({ ...x, events: x.events.map(e => e.id === id ? { ...e, ...input } : e) })),
        remove: async id => change(x => ({ ...x, events: x.events.map(e => e.id === id ? { ...e, deleted: true } : e) })),
        restore: async id => change(x => ({ ...x, events: x.events.map(e => e.id === id ? { ...e, deleted: false } : e) })),
      },
      files: async id => d.files[id] ?? [],
      fileHref: () => null,
      startChat: async (title, people) => addTopic(title, people),
    }}/>;
}
/** A conversation as the server would return it after this patch (demo mode only). */
function applyPatch(c: ConversationSummary, patch: ConversationPatch, now: number): ConversationSummary {
  return {
    ...c,
    ...(patch.title !== undefined ? { title: patch.title, titleLocked: patch.titleLocked ?? true } : patch.titleLocked !== undefined ? { titleLocked: patch.titleLocked } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
    ...(patch.pinned !== undefined ? { pinnedAt: patch.pinned ? c.pinnedAt ?? now : null } : {}),
    ...(patch.keyDate !== undefined ? { keyDate: patch.keyDate } : {}),
    ...(patch.keyLabel !== undefined ? { keyLabel: patch.keyLabel } : {}),
    ...(patch.project !== undefined ? { project: patch.project } : {}),
    ...(patch.statusLine !== undefined ? { statusLine: patch.statusLine } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
    ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
    updatedAt: now,
  };
}
function DemoChat({ me, messages, closed }: { me: string; messages: DemoMessage[]; closed: boolean }) {
  return <div className="transcript">
    {messages.map(m => <article key={m.id} className={`message ${m.mine ? 'human mine' : 'assistant'}`}><div className="message-meta"><strong>{m.mine ? me : 'Kenaznia'}</strong><time dateTime={new Date(m.at).toISOString()}>{formatDate(new Date(m.at), { hour: '2-digit', minute: '2-digit' })}</time></div><div className="message-body"><p>{m.text}</p></div></article>)}
    <p className="org-quiet">{closed ? 'Demo topic, closed.' : 'Demo: this chat is made up, and nothing typed here is sent.'}</p>
  </div>;
}
