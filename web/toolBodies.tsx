// How an opened tool card lays each tool out, one entry per tool keyed by its name (the same names as toolLines.ts,
// which has each tool's icon and closed line). Loaded on a card's first open; the pieces are in toolUi.tsx. A tool
// without an entry gets the tidied fallback (Generic).
import type { ReactNode } from 'react';
import { ago } from './toolLines.js';
import { cap, channelOf, countOf, firstLine, home, listIn, object, person, plural, shortId, text, viewer, when, words, type Data, type Outcome } from './toolData.js';
import { Brief, bytes, Chat, chatGroups, clip, dateOf, Diff, Events, Facts, Fields, Fold, Label, MailList, MailView, Meta, More, Path, Prose, Rows, toneOf, type ChatMsg, type Row } from './toolUi.js';

export type Ctx = { a: Data; o: Outcome; out: string; j: unknown; action: string; failed: boolean };
type Body = (c: Ctx) => ReactNode;

const ours = (from: string) => from === viewer.name || /^(Kenan\b|You$|Me$)/.test(from);
/** A message is ours when we sent it; in a Signal one-to-one chat (named after the other person) that is anything they didn't send. */
const mine = (from: string, where: string, source: string) => ours(from) || (source === 'signal' && !!where && !/^group /.test(where) && from !== where && !where.includes(','));
const items = (v: unknown): Data[] => (listIn(v) ?? []).filter(i => typeof i === 'object' && i !== null).map(object);
const listOf = (c: Ctx, row: (i: Data, n: number) => Row, empty?: string) => { const l = listIn(c.j) ?? []; return <Rows rows={items(c.j).map(row)} total={countOf(l)} empty={empty}/>; };
const model = (m: unknown, t?: unknown) => [text(m).replace(/^claude-/, '').replace(/^gpt-/, 'GPT-'), text(t)].filter(Boolean).join(' ');
const worker = (w: Data): Row => ({ key: text(w.id), title: text(w.name) || shortId(text(w.id)), facts: [{ text: text(w.state), tone: toneOf(text(w.state)) }, w.archived === true && 'archived', w.warning && { text: 'waiting', tone: 'warn' }], meta: [model(w.model), text(object(w.goal).title ?? w.goal), typeof w.idleS === 'number' && w.idleS > 60 && `idle ${ago(w.idleS)}`].filter(Boolean).join(' · '), body: clip(object(w.lastReport).text ?? (typeof w.lastReport === 'string' && w.lastReport !== 'done' ? w.lastReport : '') ?? w.on, 200) || clip(w.on, 200) });
const goal = (g: Data): Row => ({ key: text(g.id), title: text(g.title ?? g.id), facts: [{ text: text(g.status), tone: toneOf(text(g.status)) }, g.priority !== undefined && `P${text(g.priority)}`, typeof g.workerCount === 'number' && g.workerCount > 0 && plural(g.workerCount, 'worker'), typeof g.updatedAt === 'number' && when(g.updatedAt)], body: clip(g.detail, 160) });
const todo = (t: Data): Row => ({ key: text(t.id), lead: <span className="tb-check" aria-label={t.doneAt ? 'Done' : 'Open'}>{t.doneAt ? '✓' : '○'}</span>, title: text(t.text), facts: [text(t.section ?? t.level), text(t.tag), t.onDate && `on ${text(t.onDate)}`, t.onHome === true && 'on Home'], body: clip(t.details, 140), tone: t.doneAt ? 'done' : undefined });
/** A wake's trigger in words, its times read as times. */
const trigger = (t: unknown) => text(t).replace(/ \(clock wake:[\s\S]*$/, '').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z/g, m => when(m));
const wakeRow = (w: Data): Row => ({ key: text(w.id), title: clip(w.message, 160), facts: [{ text: text(w.status), tone: toneOf(text(w.status)) }], meta: trigger(w.trigger), body: clip(w.handoff ?? w.detail, 160) });
/** A send's outcome: "sent", or why not. */
const sendState = (j: unknown): { text: string; tone: 'good' | 'bad' } | null => { const r = object(j); if (r.ok === false) return { text: `not sent: ${words(text(r.error))}`, tone: 'bad' }; const s = text(r.status ?? object(r.value).state); return s ? { text: s === 'succeeded' ? 'sent' : words(s), tone: toneOf(s === 'succeeded' ? 'sent' : s) === 'bad' ? 'bad' : 'good' } : null; };
/** A Signal history line ("Oct 21, 00:03 Alice: Nop") as a chat message; reactions and other events become notes. */
function historyMsg(line: string, n: number, chat: string): ChatMsg {
  const m = /^([A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}) ([\s\S]*)$/.exec(line);
  const at = m ? dateOf(m[1]) : null, rest = m ? m[2]! : line;
  const said = /^([^:\n]{1,80}?): ([\s\S]*)$/.exec(rest);
  if (!said || /\b(reacted|removed a reaction|deleted)\b/.test(said[1]!)) return { key: `${n}`, from: '', text: rest, at, mine: false, note: true };
  return { key: `${n}`, from: said[1]!, text: said[2]!, at, mine: mine(said[1]!, chat, 'signal') };
}

const bodies: Record<string, Body> = {
  bash: c => { const exit = c.o.details.exitCode ?? c.o.details.exit_code; return <>
    <Fold value={text(c.a.command)} lines={4} className="cmd"/>
    {c.out ? <Fold value={c.out} lines={8} mode="ends" className={c.failed ? 'bad' : ''}/> : c.o.texts.length ? <p className="tb-muted">No output.</p> : null}
    <p className="tb-meta"><Facts items={[exit !== undefined && { text: `exit ${text(exit)}`, tone: exit === 0 ? 'dim' : 'bad' }, typeof c.o.details.wall_time_seconds === 'number' && `${c.o.details.wall_time_seconds} s`, c.o.details.truncated === true && 'output cut by the tool']}/></p>
  </>; },
  read: c => <><Path value={c.a.path}/>{c.o.images.length ? null : <><Meta items={[c.a.offset !== undefined && `from line ${text(c.a.offset)}`, c.a.limit !== undefined && `${text(c.a.limit)} lines`]}/><Fold value={c.out} lines={12} className={c.failed ? 'bad' : ''}/></>}</>,
  write: c => <><Path value={c.a.path}/><Fold value={text(c.a.content)} lines={12}/>{c.failed && <Fold value={c.out} className="bad"/>}</>,
  edit: c => {
    const diff = text(c.o.details.diff);
    const edits = (Array.isArray(c.a.edits) ? c.a.edits : [c.a]).map(object);
    return <><Path value={c.a.path}/>
      {c.failed && <Fold value={c.out} className="bad"/>}
      {diff && !c.failed ? <Diff value={diff}/> : edits.map((e, i) => <div className="tb-diff" key={i}><Fold value={text(e.oldText)} lines={10} className="removed"/><Fold value={text(e.newText)} lines={10} className="added"/></div>)}
    </>;
  },
  web_search: c => listOf(c, (r, n) => ({ key: `${n}`, title: text(r.title) || text(r.url), href: /^https?:\/\//.test(text(r.url)) ? text(r.url) : undefined, meta: [text(r.url).replace(/^https?:\/\/(www\.)?([^/]+).*$/, '$2'), r.publish_date && when(r.publish_date).replace(/,? \d+:\d+.*$/, '')].filter(Boolean).join(' · '), body: clip((Array.isArray(r.excerpts) ? r.excerpts.map(text).join(' ') : text(r.excerpt)).replace(/\[[^\]]*\]\([^)]*\)|[#*|\\]+|\n+|\.\.\.|\s{2,}/g, ' ').replace(/(\d+\. [^.\d]{1,30} ){2,}/g, ''), 200) }), 'No results.'),
  report: c => <Prose value={text(c.a.text)} height={320}/>,
  notify: c => <div className="tb-sent"><p><strong>{text(c.a.title)}</strong> <Facts items={[c.a.level === 'urgent' && { text: 'urgent', tone: 'warn' }]}/></p><p className="tb-plain">{text(c.a.body)}</p><Meta items={[typeof object(c.j).connectedPhones === 'number' && `${plural(Number(object(c.j).connectedPhones), 'phone')} listening`]}/></div>,
  attach: c => <>{c.a.text ? <p className="tb-plain">{text(c.a.text)}</p> : null}<Rows rows={(items(object(c.j).files).length ? items(object(c.j).files) : (Array.isArray(c.a.paths) ? c.a.paths : []).map((p): Data => ({ name: text(p).split('/').pop() }))).map((f, n) => ({ key: `${n}`, title: text(f.name), meta: [text(f.mime).replace(/;.*/, ''), bytes(f.size)].filter(Boolean).join(' · ') }))}/></>,
  usage: c => <Rows rows={items(object(c.j).plans).map((p, n) => { const pr = object(p.projection), left = Math.round(Number(p.percentLeft)); return { key: `${n}`, title: `${cap(text(p.provider))} ${text(p.metric)}`, aside: `${left}% left`, facts: [{ text: `${left}%`, tone: left < 15 ? 'bad' : left < 40 ? 'warn' : 'good' }], meta: [typeof pr.drainPercentPerHour === 'number' && `using ${pr.drainPercentPerHour.toFixed(1)}% an hour`, pr.exhaustionAt && `runs out ${when(pr.exhaustionAt)}`].filter(Boolean).join(' · '), body: items(p.accounts).map(a => `${text(a.accountId)} ${Math.round(Number(a.percentLeft))}%`).join(' · ') }; })}/>,
  workers: c => {
    const r = object(c.j);
    if (c.action === 'spawn' || c.action === 'dispatch' || c.action === 'respawn') return <div className="tb-brief">
      <p className="tb-meta"><Facts items={[c.action === 'dispatch' ? (r.dispatched === false ? { text: `sent to ${text(r.reason).replace(/_/g, ' ')}`, tone: 'warn' } : r.dispatched ? { text: 'dispatched', tone: 'good' } : null) : r.id ? { text: 'started', tone: 'good' } : null, model(c.a.model ?? r.model, c.a.thinking ?? r.thinking), c.a.speed && c.a.speed !== 'normal' && text(c.a.speed)]}/></p>
      <Brief value={text(c.a.text)}/>
    </div>;
    if (c.action === 'message') return <><Meta items={[c.a.to ? `to ${text(c.a.to)}` : `to ${shortId(text(c.a.id))}`]}/><Prose value={text(c.a.text)}/></>;
    if (c.action === 'list' || c.action === 'find') return listOf(c, worker, 'No workers.');
    if (c.action === 'peek') {
      const one = object(r.worker);
      const show = (w: Data) => <div className="tb-peek" key={text(w.id)}>
        <p><strong>{text(w.name)}</strong> <Facts items={[{ text: text(w.state), tone: toneOf(text(w.state)) }, w.warning && { text: 'waiting', tone: 'warn' }]}/></p>
        <Meta items={[object(w.goal).title && text(object(w.goal).title), object(w.turn).ageS !== undefined && `turn ${ago(object(w.turn).ageS)}`, object(w.activity).label && `now: ${text(object(w.activity).label)}`, typeof w.idleS === 'number' && w.idleS > 60 && `idle ${ago(w.idleS)}`]}/>
        {items(w.said).map((s, n) => <p key={n} className="tb-plain said">{clip(s.text ?? s.thinking, 400)}</p>)}
        {items(w.did).length ? <ul className="tb-did">{items(w.did).map((d, n) => <li key={n}><b>{text(d.tool)}</b> {clip(d.args, 140)}{d.result ? <small>{clip(d.result, 160)}</small> : null}</li>)}</ul> : null}
        {object(w.lastReport).text ? <><Label>Last report</Label><Prose value={text(object(w.lastReport).text)} height={160}/></> : null}
      </div>;
      return one.id ? show(one) : <More items={items(r.workers ?? r.items).map(show)} first={4}/>;
    }
    if (r.name) return <Rows rows={[{ ...worker(r), body: c.a.text ? clip(c.a.text, 300) : undefined }]}/>;
    return <Generic {...c}/>;
  },
  goals: c => {
    const g = object(c.j);
    if (c.action === 'list') return listOf(c, goal, 'No goals.');
    if (c.action === 'get') return <><p><strong>{text(g.title ?? g.id)}</strong> <Facts items={[g.status && { text: text(g.status), tone: toneOf(text(g.status)) }, g.priority !== undefined && `P${text(g.priority)}`, Array.isArray(g.workerIds) && g.workerIds.length > 0 && plural(g.workerIds.length, 'worker'), Array.isArray(g.held) && g.held.length > 0 && `${g.held.length} held`]}/></p>
      <Prose value={text(g.detail)}/>{g.notes ? <><Label>Notes</Label><Prose value={text(g.notes)} height={260}/></> : null}</>;
    return <><p><strong>{text(c.a.title ?? g.title ?? c.a.id)}</strong> <Facts items={[(c.a.status ?? g.status) && { text: text(c.a.status ?? g.status), tone: toneOf(text(c.a.status ?? g.status)) }, (c.a.priority ?? g.priority) !== undefined && `P${text(c.a.priority ?? g.priority)}`]}/></p>
      {c.a.appendNote ? <><Label>Note added</Label><Prose value={text(c.a.appendNote)}/></> : null}{c.a.detail ? <><Label>Detail</Label><Prose value={text(c.a.detail)}/></> : null}</>;
  },
  wake: c => {
    const r = object(c.j);
    if (c.action === 'list') { const any = (['pending', 'held', 'recentlySettled'] as const).some(k => items(r[k]).length); return any ? <>{(['pending', 'held', 'recentlySettled'] as const).map(k => items(r[k]).length ? <div key={k}><Label>{k === 'recentlySettled' ? 'Recently settled' : words(k)}</Label><Rows rows={items(r[k]).map(wakeRow)}/></div> : null)}</> : <p className="tb-muted">No wakes.</p>; }
    const w = object(r.scheduled ?? r.cancelled);
    return <><p className="tb-meta"><Facts items={[w.status && { text: text(w.status), tone: toneOf(text(w.status)) }, w.handedOffBy || c.a.handoff ? 'handed off' : null]} after={trigger(w.trigger) || [c.a.at && when(c.a.at), c.a.inMinutes !== undefined && `in ${text(c.a.inMinutes)} min`, c.a.on && `on ${text(c.a.on)} ${text(c.a.topic ?? c.a.criteria ?? c.a.query ?? c.a.from)}`].filter(Boolean).join(' · ')}/></p>
      <Prose value={text(c.a.message ?? w.message)}/>{c.a.handoff ? <><Label>Handoff</Label><Prose value={text(c.a.handoff)} height={120}/></> : null}{w.detail ? <Meta items={[text(w.detail)]}/> : null}</>;
  },
  inbox: c => { const r = object(c.j); if (c.action === 'wait') return r.timedOut ? <p className="tb-muted">Nothing came in {ago(r.waitedSeconds)}.</p> : <Chat groups={chatGroups([object(r.item)], mine)}/>; return <Chat groups={chatGroups(items(r.items), mine)}/>; },
  signal: c => {
    const r = object(c.j);
    if (c.action === 'history') { const chat = text(r.chat ?? c.a.chat); return <Chat empty="No messages in this chat." groups={[{ key: chat, title: '', source: 'signal', msgs: (listIn(r.lines) ?? []).map((l, n) => historyMsg(text(l), n, chat)) }]}/>; }
    return <Chat groups={chatGroups(items(r.items).map(i => ({ ...i, source: 'signal' })), mine)}/>;
  },
  texts: c => {
    const r = object(c.j);
    if (c.action === 'send') return <div className="tb-sent"><Meta items={[`to ${text(c.a.to)}`]}/><p className="tb-plain">{text(c.a.body)}</p><p><Facts items={[r.status && { text: text(r.status), tone: toneOf(text(r.status)) }]}/></p></div>;
    if (c.action === 'wait') return r.timedOut ? <p className="tb-muted">No text came in {ago(r.waitedSeconds)}.</p> : <Chat groups={chatGroups([{ ...object(r.text), source: 'texts', where: text(object(r.text).sender) }], mine)}/>;
    return <Chat groups={chatGroups(items(r.items).map(t => ({ ...t, source: 'texts', where: text(t.sender ?? t.from) })), mine)}/>;
  },
  discord: c => {
    const r = object(c.j);
    if (c.action === 'history') return <Chat groups={chatGroups(items(r.items).map(m => ({ ...m, source: 'discord', where: '', from: m.author })), (from) => ours(from) || from === 'Kenan')}/>;
    if (c.action === 'channels') return <>{items(r.servers).map((s, n) => <div key={n}><Label>{text(s.name)}</Label><Rows rows={items(s.channels).map(ch => ({ key: text(ch.id), title: `# ${text(ch.name)}`, meta: text(ch.topic) }))}/></div>)}</>;
    if (c.action === 'members') return <Rows empty="No members found." rows={items(r.members).map(m => ({ key: text(m.id), title: text(m.displayName ?? m.username), meta: `@${text(m.username)}`, facts: (Array.isArray(m.roles) ? m.roles : []).map(text) }))}/>;
    return <>{c.a.text ? <Prose value={text(c.a.text)}/> : null}<p><Facts items={[r.status && { text: text(r.status), tone: toneOf(text(r.status)) }]}/></p></>;
  },
  send: c => {
    const to = text(c.a.to), ch = to.startsWith('kenan:') ? { app: 'Kenan', who: to.slice(6) } : channelOf(to), s = sendState(c.j), r = object(c.j);
    const from = /# from: (.*?) \(/.exec(c.out + text(object(r.receipt).output))?.[1];
    return <div className="tb-sent">
      <p className="tb-meta"><Facts items={[s, ch.app]} after={[ch.who && `to ${ch.who}`, from && `from ${person(from)}`, Array.isArray(c.a.cc) && `cc ${c.a.cc.map(text).join(', ')}`].filter(Boolean).join(' · ')}/></p>
      {c.a.subject ? <p><strong>{text(c.a.subject)}</strong></p> : null}
      <Fold value={text(c.a.text)} lines={10} mono={false}/>
      {Array.isArray(c.a.attachments) && c.a.attachments.length > 0 && <Rows rows={c.a.attachments.map((p, n) => ({ key: `${n}`, title: text(p).split('/').pop() ?? '' }))}/>}
      {r.ok === false && r.message ? <p className="tb-plain bad">{text(r.message)}</p> : null}
    </div>;
  },
  mail: c => {
    const r = object(c.j);
    if (c.action === 'search' || c.action === 'wait') return r.timedOut ? <p className="tb-muted">Nothing arrived.</p> : <MailList items={items(c.j)}/>;
    if (c.action === 'read') return <>{c.out.split(/^===== /m).filter(Boolean).map((m, n, all) => { const [head = '', ...rest] = m.split('\n\n'); const h = (k: string) => new RegExp(`${k}: ([^\\t\\n]*)`).exec(head)?.[1] ?? ''; return <MailView key={n} from={person(h('From'))} to={person(h('To'))} date={h('Date')} subject={all.length > 1 ? h('Subject') || '(no subject)' : ''} body={rest.join('\n\n')}/>; })}</>;
    if (c.action === 'send' || c.action === 'draft') {
      const res = object(object(r.value).result), notSent = /^# not sent/m.test(c.out);
      return <div className="tb-sent"><p className="tb-meta"><Facts items={[r.ok === false ? { text: `not sent: ${text(r.error)}`, tone: 'bad' } : notSent || c.action === 'draft' ? { text: 'draft', tone: 'dim' } : { text: 'sent', tone: 'good' }]} after={[Array.isArray(c.a.to) && `to ${c.a.to.map(text).join(', ')}`, Array.isArray(c.a.cc) && `cc ${c.a.cc.map(text).join(', ')}`, /^# from: (.*?) \(/.exec(c.out)?.[1] && `from ${person(/^# from: (.*?) \(/.exec(c.out)![1])}`].filter(Boolean).join(' · ')}/></p>
        {c.a.subject ? <p><strong>{text(c.a.subject)}</strong></p> : null}<Fold value={text(c.a.body)} lines={12} mono={false}/>
        <Meta items={[Array.isArray(res.rejected) && res.rejected.length > 0 && `rejected by ${res.rejected.map(text).join(', ')}`]}/></div>;
    }
    if (c.action === 'attachments') return <Rows rows={items(r.saved).map((f, n) => ({ key: `${n}`, title: text(f.filename), meta: [bytes(f.bytes), home(text(f.path)).replace(/\/[^/]*$/, '')].join(' · ') }))}/>;
    if (c.action === 'folders') return <Rows rows={items(r).map((f, n) => ({ key: `${n}`, title: (/"([^"]+)"$/.exec(text(f.folder))?.[1]) ?? text(f.folder) }))}/>;
    return <Generic {...c}/>;
  },
  browser: c => {
    if (c.action === 'command') return <><Fold value={(Array.isArray(c.a.args) ? c.a.args.map(text) : []).join(' ')} lines={6} className="cmd"/><Fold value={c.out} lines={12} className={c.failed ? 'bad' : ''}/></>;
    if (c.action === 'open') { const [title = '', url = ''] = c.out.replace(/^✓\s*/, '').split('\n').map(l => l.trim()); const shown = url || text(c.a.url); return <div className="tb-page"><strong>{title || shown}</strong><a href={shown} target="_blank" rel="noopener noreferrer">{shown.replace(/^https?:\/\/(www\.)?/, '')}</a></div>; }
    if (c.action === 'click' || c.action === 'fill' || c.action === 'screenshot' || c.action === 'snapshot') return <><Meta items={[text(c.a.target) && `on ${text(c.a.target)}`]}/>{c.o.images.length && c.action === 'screenshot' ? null : <Fold value={c.out.replace(/^✓ Done\n?/, '').replace(/^✓\s*/, '') || 'Done.'} lines={12} mono={c.action === 'snapshot'} className={c.failed ? 'bad' : ''}/>}</>;
    const r = object(c.j);
    return <><Meta items={[c.a.profile && `profile ${text(c.a.profile)}`, r.status && text(r.status), r.browserCost && `cost $${Number(r.browserCost).toFixed(3)}`]}/>{r.live_view_url ? <p><a href={text(r.live_view_url)} target="_blank" rel="noopener noreferrer">Watch it live</a></p> : null}</>;
  },
  calendar: c => c.action === 'list' ? <Events items={items(c.j)}/>
    : typeof c.j === 'string' ? <p className="tb-muted">{c.j}.</p>
    : <Events notes items={[{ ...c.a, ...object(c.j) }]}/>,
  todos: c => {
    if (c.action === 'list') return listOf(c, todo, 'Nothing to do.');
    if (c.action === 'buy_list') return <>{items(c.j).map((s, n) => <div key={n}><Label>{`${text(s.emoji)} ${text(s.section)}`}</Label><Rows empty="Nothing to buy." rows={items(s.items).map(i => ({ key: text(i.id), title: text(i.text) }))}/></div>)}</>;
    const t = { ...c.a, ...object(c.j) };
    return <Rows rows={[{ ...todo(t), body: clip(t.details, 400) }]}/>;
  },
  voice: c => {
    const r = object(c.j);
    if (c.action === 'call') return <><p className="tb-meta"><Facts items={[r.outcome && { text: text(r.outcome), tone: toneOf(text(r.outcome)) }, c.a.handoff === 'owner' && 'hands over to you']} after={[text(c.a.name), text(c.a.to)].filter(Boolean).join(' · ')}/></p><Label>Brief</Label><Prose value={text(c.a.brief)} height={160}/></>;
    if (c.action === 'say') return <p className="tb-plain">“{text(c.a.text)}”</p>;
    if (c.action === 'list') return listOf(c, s => ({ key: text(s.id), title: text(s.to ?? s.kind), meta: text(s.line), body: text(s.summary) }), 'No live calls.');
    return <Generic {...c}/>;
  },
  peer: c => c.action === 'send' ? <><p className="tb-meta"><Facts items={[object(c.j).queued ? { text: 'sent', tone: 'good' } : null]} after={`to ${cap(text(c.a.peer))}`}/></p><Prose value={text(c.a.text)}/></>
    : <Chat groups={[{ key: 'peer', title: cap(text(c.a.peer)), source: 'kenan', msgs: items(c.j).map((m, n) => ({ key: `${n}`, from: m.direction === 'in' ? cap(text(c.a.peer)) : 'Kenan', text: text(m.text), at: dateOf(m.at), mine: m.direction !== 'in' })).reverse() }]}/>,
  question: c => { const q = object(object(c.j).asked ?? object(c.j).withdrawn); const opts = Array.isArray(c.a.options) ? c.a.options : Array.isArray(q.options) ? q.options : []; return <><p><strong>{text(c.a.text ?? q.text)}</strong></p>{opts.length > 0 && <p className="tb-meta">{opts.map(text).join('  /  ')}</p>}{c.a.details ? <Prose value={text(c.a.details)} height={160}/> : null}</>; },
  phone: c => {
    if (c.action === 'ui') { const r = object(c.j); return <><Meta items={[text(r.package)]}/><Fold value={items(r.nodes).map(n => [text(n.node), text(n.class), clip(n.text ?? n.desc ?? n.id, 80), n.clickable ? '(tap)' : ''].filter(Boolean).join('  ')).join('\n')} lines={20}/></>; }
    if (c.action === 'screenshot') return c.o.images.length ? null : <Generic {...c}/>;
    return <Fields data={c.a} skip={['action']}/>;
  },
  rooms: c => {
    const r = object(c.j);
    if (c.action === 'list' || c.action === 'groups') return listOf(c, g => ({ key: text(g.id), title: `${text(g.emoji)} ${text(g.title ?? g.name)}`.trim(), facts: [g.project && 'project', g.pinned && 'pinned', text(g.status ?? g.family), g.archived && 'closed'] }));
    return <><p><strong>{`${text(r.emoji)} ${text(r.title ?? c.a.title ?? c.a.id)}`.trim()}</strong> <Facts items={[r.project === true && 'project', text(r.status), r.titleLocked === true && 'name locked']}/></p><Prose value={text(c.a.text ?? c.a.opening)}/></>;
  },
  tools: c => c.action === 'list' ? <Rows rows={items(object(c.j).available).map(t => ({ key: text(t.name), title: text(t.name), meta: text(t.summary) }))}/> : <Fold value={c.out} lines={6} mono={false}/>,
};

/** The tidied fallback for a tool without its own layout: the call's settings that matter, then its result. */
export function Generic(c: Ctx) {
  return <><Fields data={c.a} skip={['action']}/>{c.j !== null && typeof c.j === 'object' ? <Fields data={Array.isArray(c.j) ? { items: c.j } : c.j as Data}/> : c.out ? <Fold value={c.out} lines={10} className={c.failed ? 'bad' : ''}/> : null}</>;
}
/** The opened card's layout for this tool (null: the fallback). */
export const bodyOf = (name: string): Body | null => bodies[name] ?? null;
