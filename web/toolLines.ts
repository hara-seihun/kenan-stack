// What a closed tool card says, one entry per tool keyed by its name: its icon, a plain title ("Edited", "Signal · 10
// messages with Morgan"), the thing it acted on and a short outcome, read from the call's arguments and its clipped
// result. This is in the startup bundle, so keep entries small; how an opened card lays a tool out is the same tool's
// entry in toolBodies.tsx (loaded on the first open). A tool with no entry gets the generic line and the tidied fallback.
import { AlarmClock, Bell, Calendar, CheckCircle, FilePen, FilePlus, FileText, Gauge, Globe, Hash, Inbox, ListChecks, ListTodo, Mail, MessageCircle, MessageSquareText, MessagesSquare, Paperclip, Phone, Search, Send, Smartphone, Terminal, Users, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cap, channelOf, countOf, criteriaWords, firstLine, home, json, listIn, object, outcome, person, plural, shortId, text, when, words, type Data, type ToolPart } from './toolData.js';

export type Subject = { text: string; dim?: string; mono?: boolean };
export type Line = { title: string; subject: Subject | null; note: string | null; problem: string | null };
type Read = { json: unknown; text: string; count: number | null; failed: boolean; details: Data };
type Describe = (a: Data, r: Read, action: string, name: string) => [title: string, subject?: Subject | null, note?: string | null];
type ToolLine = { icon: LucideIcon; line: Describe; title?: string };

const path = (p: unknown): Subject | null => { const s = home(text(p)); if (!s) return null; const i = s.lastIndexOf('/', s.length - 2); return i < 0 ? { text: s, mono: true } : { text: s.slice(i + 1), dim: s.slice(0, i), mono: true }; };
const say = (t: unknown): Subject | null => { const s = firstLine(text(t)); return s ? { text: s } : null; };
const code = (t: unknown): Subject | null => { const s = text(t).replace(/^(\s*cd\s+[^;&|]+(&&|;)\s*)+/, '').replace(/\s+/g, ' ').trim(); return s ? { text: s, mono: true } : null; };
const sized = (r: Read, one: string, many?: string) => r.count === null ? null : plural(r.count, one, many);
const counted = (r: Read, one: string, none = `${one}s`) => r.count === null ? none : plural(r.count, one);
const named = (r: Read) => { const o = object(r.json); return say(o.title ?? o.name ?? o.text ?? object(o.worker).name); };
const verbs: Data = { create: 'Created', update: 'Updated', delete: 'Deleted', restore: 'Restored', archive: 'Archived', stop: 'Stopped', done: 'Finished', reopen: 'Reopened', move: 'Moved', rename: 'Renamed', style: 'Restyled', pin: 'Pinned', close: 'Closed', lock: 'Locked', post: 'Posted in', add: 'Added', cancel: 'Cancelled', end: 'Ended', send: 'Sent', set_group: 'Regrouped', group: 'Moved', project: 'Changed', reparent: 'Moved', respawn: 'Restarted', withdraw: 'Withdrew', resolve: 'Resolved' };
const target = (a: Data): Subject | null => text(a.target) ? { text: text(a.target), mono: true } : null;
const verb = (action: string, thing: string) => `${text(verbs[action]) || cap(words(action))} ${thing}`;
const model = (m: unknown, t?: unknown) => [text(m).replace(/^claude-/, '').replace(/-\d.*$/, ''), text(t)].filter(Boolean).join(' ');
/** A short "with …" or "for …" from a search's words: names read "with Morgan", other words "for “rough”". */
const about = (q: unknown, chat?: unknown) => { const s = text(q).trim(), c = text(chat).trim(); return c ? ` in ${c}` : !s ? '' : /^\p{Lu}/u.test(s) ? ` with ${s}` : ` for “${s}”`; };
export const ago = (s: unknown) => { const n = Number(s); return !Number.isFinite(n) ? '' : n < 90 ? `${Math.round(n)} s` : n < 5400 ? `${Math.round(n / 60)} min` : `${Math.round(n / 3600)} h`; };
const SOURCES: Data = { signal: 'Signal', texts: 'Texts', mail: 'Mail', discord: 'Discord', kenan: 'Kenan chats' };
/** A send's outcome from its result: false when it says it wasn't sent. */
const wasSent = (j: unknown) => { const r = object(j); return r.ok !== false && !/fail|error|refused/.test(text(r.status)); };

const tools: Record<string, ToolLine> = {
  bash: {
    icon: Terminal,
    title: 'Shell',
    line: (a, r) => ['Shell', code(a.command), r.failed ? (r.details.exitCode ?? r.details.exit_code) !== undefined ? `exit ${text(r.details.exitCode ?? r.details.exit_code)}` : null : typeof r.details.wall_time_seconds === 'number' && r.details.wall_time_seconds >= 1 ? `${Math.round(r.details.wall_time_seconds)} s` : null],
  },
  read: {
    icon: FileText,
    title: 'Files',
    line: (a, r) => ['Read', path(a.path), r.text.startsWith('Read image') ? 'image' : a.offset !== undefined || a.limit !== undefined ? `from line ${text(a.offset ?? 1)}` : null],
  },
  write: {
    icon: FilePlus,
    title: 'Files',
    line: a => ['Wrote', path(a.path), /… [\d,]+ characters not shown …/.test(text(a.content)) ? null : plural(text(a.content).split('\n').length, 'line')],
  },
  edit: {
    icon: FilePen,
    title: 'Files',
    line: a => ['Edited', path(a.path), Array.isArray(a.edits) && countOf(a.edits) > 1 ? `${countOf(a.edits)} changes` : null],
  },
  web_search: {
    icon: Search,
    title: 'Web search',
    line: (a, r) => ['Searched the web', say(a.query), sized(r, 'result')],
  },
  report: {
    icon: CheckCircle,
    line: a => [a.status === 'blocked' ? 'Reported blocked' : 'Reported done', say(a.text)],
  },
  notify: {
    icon: Bell,
    title: 'Notification',
    line: a => [a.level === 'urgent' ? 'Urgent notification' : 'Notification', say(a.title)],
  },
  attach: {
    icon: Paperclip,
    title: 'Files',
    line: a => ['Sent files', say((Array.isArray(a.paths) ? a.paths : []).map(p => text(p).split('/').pop()).join(', ')), Array.isArray(a.paths) && a.paths.length > 1 ? plural(a.paths.length, 'file') : null],
  },
  usage: {
    icon: Gauge,
    line: () => ['Checked usage'],
  },
  workers: {
    icon: Users,
    line: (a, r, action) => action === 'spawn' ? ['Started worker', say(a.name), a.model ? model(a.model, a.thinking) : null]
      : action === 'dispatch' ? ['Dispatched', say(a.title ?? a.name), object(r.json).dispatched === false ? `went to ${text(object(r.json).reason).replace(/_/g, ' ')}` : null]
      : action === 'message' ? [a.to ? `Messaged ${text(a.to).replace(/:.*/, '')}` : 'Messaged worker', say(a.text), a.id ? shortId(text(a.id)) : null]
      : action === 'list' || action === 'find' ? [action === 'find' ? 'Found agents' : 'Listed workers', a.name ? say(a.name) : null, sized(r, action === 'find' ? 'agent' : 'worker')]
      : action === 'peek' ? ['Checked on ' + (a.id ? 'worker' : 'workers'), a.id ? named(r) ?? { text: shortId(text(a.id)), mono: true } : null]
      : action === 'activity' ? ['Worker activity', null, a.hours ? `last ${text(a.hours)} h` : null]
      : [verb(action, 'worker'), named(r) ?? { text: shortId(text(a.id)), mono: true }],
  },
  goals: {
    icon: ListTodo,
    line: (a, r, action) => action === 'list' ? ['Listed goals', null, sized(r, 'goal')]
      : action === 'get' ? ['Opened goal', named(r) ?? { text: shortId(text(a.id)), mono: true }]
      : [verb(action, 'goal'), say(a.title) ?? named(r), a.status ? `→ ${text(a.status)}` : a.appendNote ? 'note added' : null],
  },
  wake: {
    icon: AlarmClock,
    line: (a, r, action) => action === 'schedule' ? ['Wake', say(a.message), a.inMinutes !== undefined ? `in ${text(a.inMinutes)} min` : a.at ? when(a.at) : a.on === 'event' ? `on ${text(a.topic).split(':').slice(0, 2).join(':')}` : a.on ? `on ${text(a.on)}` : null]
      : action === 'list' ? ['Listed wakes', null, Array.isArray(object(r.json).pending) ? `${countOf(object(r.json).pending as unknown[])} pending` : null]
      : [verb(action, 'wake'), say(object(object(r.json).cancelled).message) ?? { text: shortId(text(a.id)), mono: true }],
  },
  inbox: {
    icon: Inbox,
    line: (a, r, action) => {
      const src = text(SOURCES[text(a.source)]) || 'Inbox';
      const j = object(r.json), item = object(j.item);
      if (action === 'wait') return [j.timedOut ? `${src} · nothing came in ${ago(j.waitedSeconds ?? a.timeoutSeconds)}` : item.from ? `${src} · new from ${person(item.from)}` : `${src} · waiting${about(a.query, a.chat)}`, item.text ? say(item.text) : null];
      return [`${src} · ${counted(r, 'message')}${about(a.query, a.chat)}`];
    },
  },
  signal: {
    icon: MessageCircle,
    line: (a, r, action) => { const j = object(r.json); return action === 'history' ? [`Signal · ${counted(r, 'message')} with ${text(j.chat ?? a.chat)}`] : [`Signal · ${counted(r, 'message')}${about(a.query, a.chat)}`]; },
  },
  texts: {
    icon: MessageSquareText,
    line: (a, r, action) => action === 'send' ? ['Texted', say(a.body), text(a.to)]
      : [action === 'wait' ? (object(r.json).timedOut ? 'Texts · nothing came' : 'Texts · new text') : `Texts · ${r.count === null ? 'messages' : plural(r.count, 'text')}${about(a.query)}`, action === 'wait' ? say(object(object(r.json).text).body) : null],
  },
  discord: {
    icon: Hash,
    line: (a, r, action) => action === 'history' ? [`Discord · ${counted(r, 'message')}`] : action === 'channels' ? ['Discord channels'] : [`Discord · ${words(action)}`, say(a.member ?? a.query ?? a.text ?? a.name)],
  },
  send: {
    icon: Send,
    line: (a, r) => { const ch = channelOf(text(a.to)), failed = r.failed || !wasSent(r.json); return [ch.who ? `${failed ? 'Not sent' : 'Sent'} to ${ch.who}` : a.replyTo ? (failed ? 'Reply not sent' : 'Replied') : failed ? 'Not sent' : 'Sent', say(a.subject ?? a.text), ch.app]; },
  },
  mail: {
    icon: Mail,
    line: (a, r, action) => {
      const j = object(r.json), crit = criteriaWords(text(a.criteria)), forWhat = crit ? (crit.startsWith('“') ? ` for ${crit}` : `, ${crit}`) : '';
      return action === 'search' ? [`Mail · ${counted(r, 'result')}${forWhat}`, a.folder ? { text: text(a.folder) } : null]
        : action === 'wait' ? [j.timedOut ? `Mail · nothing came${forWhat}` : `Mail · ${r.count === null ? 'new mail' : `${r.count} new`}${forWhat}`]
        : action === 'read' ? ['Read mail', say(/^Subject: (.*)$/m.exec(r.text)?.[1] ?? /From: ([^\t\n<]*)/.exec(r.text)?.[1]?.replace(/"/g, ''))]
        : action === 'send' || action === 'draft' ? [action === 'send' ? 'Sent mail' : 'Drafted mail', say(a.subject) ?? { text: a.replyTo ? 'Reply' : '' }, Array.isArray(a.to) ? a.to.map(text).join(', ') : null]
        : action === 'attachments' ? ['Saved attachments', null, sized(r, 'file')]
        : [`Mail ${words(action)}`];
    },
  },
  browser: {
    icon: Globe,
    line: (a, r, action) => action === 'command' ? ['Browser', { text: (Array.isArray(a.args) ? a.args.map(text) : []).join(' ').replace(/https?:\/\/(www\.)?/g, ''), mono: true }, r.failed ? null : say(r.text.replace(/^✓\s*/, ''))?.text.slice(0, 80) ?? null]
      : action === 'open' ? ['Opened', say(text(a.url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))]
      : action === 'click' ? ['Clicked', target(a)]
      : action === 'fill' ? ['Filled', target(a)] // never the typed text: it may be a secret
      : action === 'snapshot' ? ['Took a snapshot']
      : action === 'screenshot' ? ['Took a screenshot']
      : action === 'start' || action === 'attach' ? ['Started browser', say(a.profile ?? a.session)]
      : ['Stopped browser', say(a.session)],
  },
  calendar: {
    icon: Calendar,
    line: (a, r, action) => action === 'list' ? [`Calendar · ${counted(r, 'event')}`, a.from || a.to ? { text: [a.from, a.to].filter(Boolean).map(v => when(v).replace(/,? \d+:\d+.*$/, '')).join(' → ') } : null]
      : [verb(action, 'event'), say(a.title) ?? named(r), a.start ? when(a.start) : null],
  },
  todos: {
    icon: ListChecks,
    title: 'To-dos',
    line: (a, r, action) => action === 'list' ? [`To-dos · ${counted(r, 'item')}`]
      : action.startsWith('buy_') ? [action === 'buy_list' ? 'To buy list' : `To buy: ${words(action.slice(4))}`, say(a.text ?? a.name ?? a.section) ?? named(r)]
      : action === 'morning' ? ['Morning check']
      : [verb(action, 'to-do'), say(a.text) ?? named(r), a.level && action !== 'add' ? `→ ${text(a.level)}` : null],
  },
  voice: {
    icon: Phone,
    line: (a, r, action) => action === 'call' ? ['Phoned', say(a.name), text(a.to)]
      : action === 'say' ? ['Said on the call', { text: `“${text(a.text)}”` }]
      : action === 'digits' ? ['Pressed keys', { text: text(a.digits), mono: true }]
      : action === 'list' ? ['Live calls', null, sized(r, 'call')]
      : action === 'end' ? ['Ended call'] : [`Voice ${words(action)}`],
  },
  peer: {
    icon: Send,
    line: (a, r, action) => action === 'send' ? [`Message to ${cap(text(a.peer))}`, say(a.text)] : [`Messages with ${cap(text(a.peer))}`, null, sized(r, 'message')],
  },
  question: {
    icon: MessagesSquare,
    line: (a, r, action) => [action === 'ask' ? 'Asked' : verb(action, 'question'), say(a.text ?? object(object(r.json).withdrawn).text)],
  },
  phone: {
    icon: Smartphone,
    line: (a, _r, action) => [action === 'screenshot' ? 'Phone screenshot' : action === 'ui' ? 'Read the phone screen' : `Phone: ${words(action)}`,
      action === 'tap' ? { text: `${text(a.x)}, ${text(a.y)}`, mono: true } : action === 'open' ? { text: text(a.package), mono: true } : action === 'key' ? { text: text(a.key) } : action === 'type' ? say(a.text) : action === 'scroll' ? say(a.direction) : null],
  },
  rooms: {
    icon: MessagesSquare,
    title: 'Chats',
    line: (a, r, action) => action === 'list' ? ['Listed chats', null, sized(r, 'chat')] : action === 'groups' ? ['Chat groups', null, sized(r, 'group')]
      : action === 'layout' ? ['Switched layout', say(a.layout)]
      : [action === 'create' ? 'Created chat' : verb(action, 'chat'), say(object(r.json).emoji ? `${text(object(r.json).emoji)} ${text(object(r.json).title)}` : a.title) ?? named(r) ?? { text: shortId(text(a.id)), mono: true }],
  },
  tools: {
    icon: Wrench,
    line: (a, r, action) => action === 'add' ? ['Added tools', say((Array.isArray(a.names) ? a.names : []).map(text).join(', '))] : ['Available tools', null, sized(r, 'tool')],
  },
};
const generic: Describe = (a, _r, action, name) => [`${cap(words(name))}${action ? ` · ${words(action)}` : ''}`, say(a.name ?? a.title ?? a.query ?? a.text ?? a.path) ?? (a.id ? { text: shortId(text(a.id)), mono: true } : null)];

/** The tool's icon on its card. */
export const iconOf = (name: string): LucideIcon => tools[name]?.icon ?? Wrench;
/** A short name for the tool, for lists of the tools a run of work used. */
export const toolTitle = (name: string): string => tools[name]?.title ?? cap(words(name));

/** What a closed card shows for this call. */
export function line(part: ToolPart): Line {
  const a = object(part.args), action = text(a.action);
  const o = part.result === null ? null : outcome(part.result);
  const first = o?.texts[0] ?? '';
  const parsed = json(first);
  const list = listIn(parsed);
  const read: Read = { json: parsed, text: first, count: list ? countOf(list) : null, failed: part.isError, details: o?.details ?? {} };
  const [title, subject = null, note = null] = (tools[part.name]?.line ?? generic)(a, read, action, part.name);
  const problem = part.isError ? (part.name === 'bash' ? first.trim().split('\n').at(-1) : firstLine(first))?.slice(0, 200) || 'Failed' : null;
  return { title, subject: subject && subject.text ? subject : null, note, problem };
}

const DRAFT_TITLES: Data = { write: 'Writing', edit: 'Editing' };
/** What a card shows for a call the model is still writing: its line so far and how much has been written. */
export function draftLine(part: ToolPart & { draft: { chars: number; lines: number } }): Line {
  const l = line(part), { chars, lines } = part.draft;
  const size = chars < 1024 ? plural(chars, 'character') : `${(chars / 1024).toFixed(1)} KB`;
  return { ...l, title: text(DRAFT_TITLES[part.name]) || l.title, note: lines > 1 ? `${plural(lines, 'line')} · ${size}` : size, problem: null };
}
