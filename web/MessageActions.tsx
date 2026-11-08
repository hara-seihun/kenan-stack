import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '../shared/contract.js';
import { api } from './client.js';
import { writeClipboard } from './clipboard.js';
import { useOverlay } from './overlay.js';
import { useAboveKeyboard, useAnchoredMenu, useFocusInside } from './menuPlacement.js';
import { beginUpdateActivity } from './updateActivity.js';
import './roomMenu.css';
import './messageActions.css';

/** Uses the app's overlays, so Android Back and Escape behave just like the web app. */
export function MessageActions({ message, anchor, changed, close }: { message: Message; anchor: RefObject<HTMLElement | null>; changed(m: Message): void; close(): void }) {
  const [action, setAction] = useState<'menu' | 'edit' | 'delete'>('menu');
  useEffect(() => beginUpdateActivity(), []);
  useEffect(() => { if (message.deletedAt) close(); }, [message.deletedAt]);
  return createPortal(action === 'menu'
    ? <ActionsMenu anchor={anchor} close={close} edit={() => setAction('edit')} remove={() => setAction('delete')} text={message.text}/>
    : <MessageDialog key={action} message={message} action={action} changed={changed} close={close}/>, document.body);
}

function ActionsMenu({ anchor, close, edit, remove, text }: { anchor: RefObject<HTMLElement | null>; close(): void; edit(): void; remove(): void; text: string }) {
  const ref = useAnchoredMenu<HTMLDivElement>(anchor), [error, setError] = useState(false);
  useFocusInside(ref, anchor); useOverlay(true, close);
  return <><div className="room-menu-scrim" onPointerDown={e => { e.preventDefault(); e.stopPropagation(); close(); }}/>
    <div ref={ref} className="room-menu message-actions-menu" role="menu" aria-label="Message actions" tabIndex={-1}>
      <button role="menuitem" onClick={edit}>Edit</button>
      <button role="menuitem" className="room-danger" onClick={remove}>Delete</button>
      {text && <button role="menuitem" onClick={() => void writeClipboard(text).then(ok => ok ? close() : setError(true))}>Copy message</button>}
      {error && <p role="alert">Couldn’t copy message.</p>}
    </div></>;
}

function MessageDialog({ message, action, changed, close }: { message: Message; action: 'edit' | 'delete'; changed(m: Message): void; close(): void }) {
  const [text, setText] = useState(message.text), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const backdrop = useAboveKeyboard<HTMLDivElement>(), ref = useRef<HTMLDivElement>(null), editor = useRef<HTMLTextAreaElement>(null), saving = useRef(false);
  useOverlay(true, () => { if (!saving.current) close(); }); useFocusInside(ref);
  useEffect(() => { if (action === 'edit') { const el = editor.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [action]);
  const empty = !text.trim();
  async function submit() {
    if (saving.current || (action === 'edit' && (empty || text === message.text))) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const { message: updated } = await api<{ message: Message }>(`/conversations/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}`, action === 'edit' ? 'PATCH' : 'DELETE', action === 'edit' ? { text } : undefined);
      changed(updated); close();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <div ref={backdrop} className="room-confirm-backdrop message-dialog-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div ref={ref} className="room-confirm message-dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-label={action === 'edit' ? 'Edit message' : 'Delete message?'}>
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h2>{action === 'edit' ? 'Edit message' : 'Delete message?'}</h2>
        {action === 'edit' ? <textarea ref={editor} aria-label="Message text" value={text} disabled={busy} onChange={e => setText(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}/>
          : <p>This message will be deleted for everyone in this chat.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="actions"><button type="button" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" className={action === 'delete' ? 'room-danger' : undefined} disabled={busy || (action === 'edit' && (empty || text === message.text))}>{busy ? (action === 'edit' ? 'Saving…' : 'Deleting…') : action === 'edit' ? 'Save' : 'Delete'}</button></div>
      </form>
    </div>
  </div>;
}
