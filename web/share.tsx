// Android's share sheet → Kenan (Carol 2026-10-22): the app copies what was shared, this asks which chat it goes to
// ("Send to which chat?", her Kenaznia first, then recent chats), and puts it in that chat's composer unsent: files as
// attachments through the composer's own upload, shared words as draft text. Lazy: only the Android app loads it.
import { render } from 'preact';
import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { Bootstrap, ConversationSummary } from '../shared/contract.js';
import { call } from './native.js';
import { useOverlay } from './overlay.js';
import sheetStyle from './share.css?inline';

/** The composer's upload: into the open chat, or into the chat named. */
export type Upload = (files: File[], conversationId?: string | null) => Promise<void>;
type Ref<T> = { current: T };
interface ShareHost { boot: Ref<Bootstrap | null>; upload: Ref<Upload | null>; setDrafts: Dispatch<SetStateAction<Record<string, string>>> }
export interface SharedFile { url: string; name: string; mime: string; size: number }
export interface Shared { id: string; files: SharedFile[]; text: string | null; problems: string[] }
export interface Target { id: string; emoji: string; title: string; main: boolean }
type View = { kind: 'pick'; share: Shared } | { kind: 'failed'; message: string };

/** Where a share can go: her Kenaznia's chat first (the one-tap choice), then her open chats (rooms, not workers' chats),
 *  most recent first. Organized's own copy of these rules (modules/organized/web/home.ts mainChat, isTopic) is in the module. */
export function shareTargets(boot: Bootstrap): Target[] {
  const mainId = boot.manager.kind === 'here' ? boot.manager.conversationId : null;
  const manager = (c: ConversationSummary) => boot.agents.find(a => a.conversationId === c.id && a.role === 'manager');
  const row = (c: ConversationSummary): Target => c.id === mainId
    ? { id: c.id, emoji: c.emoji ?? '🌀', title: manager(c)?.name ?? c.title, main: true }
    : { id: c.id, emoji: c.emoji ?? '💬', title: c.title || 'Chat', main: false };
  const recent = (c: ConversationSummary) => c.lastMessage?.at ?? c.updatedAt;
  const open = boot.conversations.filter(c => !c.archived && (c.id === mainId || !c.agentId));
  return [...open.filter(c => c.id === mainId), ...open.filter(c => c.id !== mainId).sort((a, b) => recent(b) - recent(a))].map(row);
}

let host: ShareHost | null = null;
let root: HTMLElement | null = null;

/** Takes a share the app holds, now and whenever the app says another arrived. */
export function listen(boot: ShareHost['boot'], upload: ShareHost['upload'], setDrafts: ShareHost['setDrafts']): void {
  if (!host) window.addEventListener('kenan-share', () => void take());
  host = { boot, upload, setDrafts };
  void take();
}

async function take(): Promise<void> {
  const outcome = await call('takeShare', {});
  if (!outcome.ok) { show({ kind: 'failed', message: `Couldn't open what you shared: ${outcome.error.message}` }); return; }
  const share = outcome.value.share as Shared | null;
  if (share) show({ kind: 'pick', share });
}

function show(view: View | null): void {
  if (!root) {
    document.head.appendChild(document.createElement('style')).textContent = sheetStyle;
    root = document.body.appendChild(document.createElement('div'));
  }
  const boot = host?.boot.current;
  render(view && host && boot ? <ShareSheet key={view.kind === 'pick' ? view.share.id : view.message} view={view} boot={boot} host={host} close={() => show(null)}/> : null, root);
}

async function deliver(share: Shared, to: string, h: ShareHost): Promise<void> {
  window.dispatchEvent(new CustomEvent('kenan-open-conversation', { detail: { conversationId: to }, cancelable: true }));
  const text = share.text;
  if (text) h.setDrafts(all => ({ ...all, [to]: all[to] ? `${all[to]}\n${text}` : text }));
  if (!share.files.length) return;
  const files: File[] = [];
  for (const f of share.files) {
    const response = await fetch(f.url).catch(() => null);
    if (!response?.ok) { show({ kind: 'failed', message: `Couldn't attach “${f.name}”: the app no longer has it. Share it again.` }); return; }
    files.push(new File([await response.blob()], f.name, { type: f.mime }));
  }
  const upload = h.upload.current;
  if (!upload) { show({ kind: 'failed', message: 'Couldn\'t attach what you shared: the chat closed. Share it again.' }); return; }
  await upload(files, to);
}

const fileLine = (f: SharedFile) => `${f.mime.startsWith('image/') ? '🖼️' : '📄'} ${f.name}`;

function ShareSheet({ view, boot, host: h, close }: { view: View; boot: Bootstrap; host: ShareHost; close(): void }) {
  const [all, setAll] = useState(false);
  if (view.kind === 'failed') return <Frame label="Sharing to Kenan" close={close}><p className="share-problem" role="alert">{view.message}</p><div className="share-actions"><button onClick={close}>OK</button></div></Frame>;
  const { share } = view, targets = shareTargets(boot), shown = all ? targets : targets.slice(0, 8);
  const empty = !share.files.length && !share.text;
  return <Frame label="Send to which chat?" close={close}>
    <h2>{empty ? 'Nothing to send' : 'Send to which chat?'}</h2>
    {share.problems.map(p => <p key={p} className="share-problem" role="alert">{p}</p>)}
    {!empty && <ul className="share-what">{share.files.map(f => <li key={f.url}>{fileLine(f)}</li>)}{share.text && <li className="share-text">{share.text}</li>}</ul>}
    {!empty && <p className="share-hint">It goes into the chat's message box, not sent yet, so you can add words first.</p>}
    {!empty && <ul className="share-targets">{shown.map(t => <li key={t.id}><button className={t.main ? 'share-main' : undefined} onClick={() => { close(); void deliver(share, t.id, h); }}><span aria-hidden="true">{t.emoji}</span><span>{t.title}</span></button></li>)}</ul>}
    {!empty && !all && targets.length > shown.length && <button className="share-more" onClick={() => setAll(true)}>All chats ({targets.length})</button>}
    <div className="share-actions"><button onClick={close}>{empty ? 'OK' : 'Cancel'}</button></div>
  </Frame>;
}

function Frame({ label, close, children }: { label: string; close(): void; children: ReactNode }) {
  useOverlay(true, close);
  return <><button className="share-scrim" aria-label="Close" onClick={close}/><div className="share-sheet" role="dialog" aria-modal="true" aria-label={label}>{children}</div></>;
}
