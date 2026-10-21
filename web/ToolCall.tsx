import { useState, type ReactNode } from 'react';
import { Terminal, FileText, FilePen, FilePlus, Search, Users, ListTodo, CheckCircle, Gauge, Calendar, Mail, Globe, Phone, Wrench, Bell, AlarmClock, MessageSquareText, Paperclip, ChevronRight, LoaderCircle, CircleAlert } from 'lucide-react';
import type { MessagePart } from '../shared/contract.js';
type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type Data = Record<string, unknown>;
const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const text = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const words = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
const parsed = (value: string): unknown => { try { return JSON.parse(value); } catch { return value; } };
const tools = {
  bash: { title: 'Shell', icon: Terminal }, read: { title: 'Read file', icon: FileText }, write: { title: 'Write file', icon: FilePlus }, edit: { title: 'Edit file', icon: FilePen },
  web_search: { title: 'Web search', icon: Search }, workers: { title: 'Workers', icon: Users }, goals: { title: 'Goals', icon: ListTodo }, report: { title: 'Report', icon: CheckCircle },
  usage: { title: 'Subscription usage', icon: Gauge }, calendar: { title: 'Calendar', icon: Calendar }, mail: { title: 'Mail', icon: Mail }, browser: { title: 'Browser', icon: Globe }, voice: { title: 'Voice', icon: Phone },
  notify: { title: 'Phone notification', icon: Bell }, attach: { title: 'Attach files', icon: Paperclip }, wake: { title: 'Wake', icon: AlarmClock }, texts: { title: 'Texts', icon: MessageSquareText },
};
/** The card title for a tool name, for compact summaries elsewhere. */
export const toolTitle = (name: string): string => (tools as Record<string, { title: string }>)[name]?.title ?? words(name);
function Fields({ data }: { data: Data }) { return <dl className="tool-fields">{Object.entries(data).filter(([,v]) => v !== undefined && v !== null).map(([key,value]) => <div key={key}><dt>{words(key)}</dt><dd><Value value={value}/></dd></div>)}</dl>; }
function Value({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span className="tool-muted">Unset</span>;
  if (Array.isArray(value)) return value.length ? <ul className="tool-list">{value.map((item,i) => <li key={i}><Value value={item}/></li>)}</ul> : <span className="tool-muted">None</span>;
  if (typeof value === 'object') return <Fields data={object(value)}/>;
  return <span className="tool-text">{text(value)}</span>;
}
function listing(value: unknown): { items: unknown[]; next: boolean } | null {
  if (Array.isArray(value)) return { items:value, next:false };
  const data=object(value); if (Array.isArray(data.items)) return { items:data.items, next:typeof data.nextCursor==='string'||data.more===true };
  if (Array.isArray(data.results)) return { items:data.results, next:false };
  return null;
}
function ListResult({name,value}: { name:string; value:unknown }) {
  const list=listing(value); if (!list) return <Value value={value}/>;
  return <><ul className="tool-results">{list.items.map((item,i) => { const row=object(item); const title=text(row.name)||text(row.title)||text(row.sender)||text(row.id)||text(item);
    return <li key={i}><strong>{title}</strong>{name==='workers' ? <><small>{text(row.state)}{row.goalId ? ` · Goal ${text(row.goalId)}`:''}</small>{object(row.lastReport).text ? <p>{text(object(row.lastReport).text)}</p>:null}</> : name==='goals' ? <><small>{text(row.status)} · Priority {text(row.priority)}</small>{row.detail ? <p>{text(row.detail)}</p>:null}</> : name==='calendar' ? <><small>{text(row.start)}{row.end ? ` → ${text(row.end)}`:''}{row.recurrence ? ' · repeats':''}</small>{row.location ? <p>{text(row.location)}</p>:null}</> : name==='texts' ? <><small>{text(row.app)} · {typeof row.at==='number' ? new Date(row.at).toLocaleString():''}</small><p>{text(row.body)}</p></> : <>{typeof row.url==='string' && /^https?:\/\//.test(row.url) && <a href={row.url} target="_blank" rel="noreferrer">{row.url}</a>}{row.excerpt ? <p>{text(row.excerpt)}</p>:null}</>}</li>;
  })}</ul>{!list.items.length && <p className="tool-muted">No items on this page.</p>}{list.next && <small>More results available on the next page.</small>}</>;
}
function ToolInput({name,args}: {name:string;args:Data}) {
  if(name==='bash')return <pre className="tool-code">{text(args.command)}</pre>;
  if(name==='read')return <p className="tool-path">{text(args.path)}{args.offset!==undefined ? ` · from line ${text(args.offset)}`:''}{args.limit!==undefined ? ` · ${text(args.limit)} lines`:''}</p>;
  if(name==='write')return <><p className="tool-path">{text(args.path)}</p><pre className="tool-code">{text(args.content)}</pre></>;
  if(name==='edit'){const edits=Array.isArray(args.edits)?args.edits:[args];return <><p className="tool-path">{text(args.path)}</p>{edits.map((item,i)=>{const edit=object(item);return <div className="tool-diff" key={i}><pre className="removed">{text(edit.oldText)}</pre><pre className="added">{text(edit.newText)}</pre></div>;})}</>;}
  if(name==='web_search')return <p>{text(args.query)}</p>;
  if(name==='report')return <p className="tool-text">{text(args.text)}</p>;
  if(name==='notify')return <><p><strong>{text(args.title)}</strong>{args.level==='urgent' ? ' · urgent':''}</p><p className="tool-text">{text(args.body)}</p></>;
  if(name==='wake'&&args.action==='schedule')return <><p>{[args.at ? `At ${text(args.at)}`:'', args.inMinutes!==undefined ? `In ${text(args.inMinutes)} min`:'', args.on ? `On ${text(args.on)}${args.criteria ? ` ${text(args.criteria)}`:''}${args.from ? ` from ${text(args.from)}`:''}${args.query ? ` matching ${text(args.query)}`:''}`:''].filter(Boolean).join(' · ')}</p><p className="tool-text">{text(args.message)}</p></>;
  if(name==='browser' && Array.isArray(args.args))return <pre className="tool-code">{args.args.map(text).join(' ')}</pre>;
  return <Fields data={Object.fromEntries(Object.entries(args).filter(([key])=>key!=='action'&&key!=='cursor'))}/>;
}
export function ToolCall({part,messageState,onOpen}: {part:ToolPart;messageState:string;onOpen:(() => void)|undefined}) {
  const args=object(part.args), info=tools[part.name as keyof typeof tools]??{title:part.name,icon:Wrench}, Icon=info.icon;
  const summary=part.name==='bash'?text(args.command):['read','write','edit'].includes(part.name)?text(args.path):part.name==='web_search'?text(args.query):part.name==='report'?text(args.status):part.name==='mail'?text(args.subject)||text(args.criteria)||text(args.folder):part.name==='notify'?text(args.title):part.name==='attach'&&Array.isArray(args.paths)?args.paths.map(text).join(', '):part.name==='wake'?text(args.at)||(args.inMinutes!==undefined?`in ${text(args.inMinutes)} min`:'')||(args.on?`on ${text(args.on)}`:'')||text(args.id):part.name==='texts'?text(args.query):part.name==='voice'?text(args.name)||text(args.to)||text(args.text):text(args.name)||text(args.title)||text(args.id)||text(args.sessionId);
  const waiting=part.result===null && messageState==='streaming', failed=part.isError;
  const [open,setOpen]=useState(false);
  return <details className={`tool-card${failed?' failed':''}`} onToggle={e=>{const opened=e.currentTarget.open;setOpen(opened);if(opened)onOpen?.();}}><summary><Icon size={15} aria-hidden="true"/><strong>{info.title}{args.action ? ` · ${words(text(args.action))}`:''}</strong><span className="tool-summary">{summary}</span><span className="tool-state">{failed?<><CircleAlert size={13}/>Failed</>:waiting?<><LoaderCircle size={13} className="spin"/>Running</>:part.result===null?'No result':<CheckCircle size={13} aria-label="Complete"/>}</span><ChevronRight className="tool-chevron" size={14}/></summary>{open && <ToolBody part={part} args={args}/>}</details>;
}
/** Rendered only while the card is open: parsing and laying out results is the expensive part of long transcripts. */
export function ToolBody({part,args}: {part:ToolPart;args:Data}) {
  const envelope=part.result===null?null:parsed(part.result);
  const content=object(envelope).content;
  const result=Array.isArray(content)?(() => { const blocks=content.map(block=>{const data=object(block);return data.type==='text'?parsed(text(data.text)):data.type==='image'?'Image returned':data.type==='resource'?'Resource returned':data.type==='audio'?'Audio returned':'Non-text content returned';});return blocks.length===1?blocks[0]:blocks; })():envelope;
  return <div className="tool-body"><ToolInput name={part.name} args={args}/>{part.result!==null && <div className="tool-output" aria-label="Tool result">{['workers','goals','calendar','web_search','texts'].includes(part.name)?<ListResult name={part.name} value={result}/>:part.name==='usage'?<Value value={object(result).plans??result}/>:typeof result==='string'?<pre className="tool-code">{result}</pre>:<Value value={result}/>}</div>}</div>;
}
