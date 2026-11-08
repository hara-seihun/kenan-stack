import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Bootstrap, ConversationSummary } from '../shared/contract.js';
import { useOverlay } from './overlay.js';
import { useAnchoredMenu, useFocusInside } from './menuPlacement.js';
import { useRoomPress } from './roomPress.js';
import './roomMenu.css';

export const roomActionsAllowed = (c: ConversationSummary) => !c.agentId;
/** Agents in a topic don't make it a shared chat. */
export const sharedRoom = (boot: Bootstrap, c: ConversationSummary) => c.memberIds.some(id => id !== boot.me.id && boot.people.some(p => p.id === id && p.kind === 'human'));

/** The same confirmation on web and in Android's WebView, with Back/Escape and visible request failures. */
export function useLeaveChat(leave: (id: string) => Promise<void>) {
  const [room, setRoom] = useState<ConversationSummary | null>(null);
  return { requestLeave: setRoom, confirmation: room && <LeaveChat key={room.id} room={room} leave={leave} close={() => setRoom(null)}/> };
}
function LeaveChat({ room, leave, close }: { room: ConversationSummary; leave(id: string): Promise<void>; close(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), ref = useRef<HTMLDivElement>(null);
  useOverlay(true, close); useFocusInside(ref);
  return <div className="room-confirm-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div className="room-confirm" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Leave ${room.title}?`}>
      <h2>Leave {room.title}?</h2><p>You’ll lose access to this chat. The other members will keep it. To return, someone will need to add you again.</p>
      {error && <p role="alert">{error}</p>}
      <div className="actions"><button disabled={busy} onClick={close}>Cancel</button><button className="room-danger" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void leave(room.id).then(close, e => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); });
      }}>{busy ? 'Leaving…' : 'Leave chat'}</button></div>
    </div>
  </div>;
}

/** Classic's room row; Organized uses the same hold gesture with its existing TopicMenu. */
export function ClassicRoomRow(p: { c: ConversationSummary; boot: Bootstrap; selected: boolean; open(): void; closeRoom(archived: boolean): void; requestLeave(c: ConversationSummary): void; children: ReactNode }) {
  const [menu, setMenu] = useState(false), anchor = useRef<HTMLButtonElement>(null), allowed = roomActionsAllowed(p.c);
  const hold = useRoomPress(allowed, () => setMenu(true));
  return <>
    <button {...hold} ref={anchor} className={`${p.selected ? 'selected ' : ''}${allowed ? 'room-press' : ''}`} aria-current={p.selected ? 'page' : undefined} aria-haspopup={allowed ? 'menu' : undefined} aria-expanded={allowed ? menu : undefined} onClick={p.open}>{p.children}</button>
    {menu && allowed && <ClassicMenu anchor={anchor} close={() => setMenu(false)}>
      {sharedRoom(p.boot, p.c) ? <button role="menuitem" className="room-danger" onClick={() => { setMenu(false); p.requestLeave(p.c); }}>Leave chat</button>
        : <button role="menuitem" onClick={() => { setMenu(false); p.closeRoom(!p.c.archived); }}>{p.c.archived ? 'Reopen chat' : 'Close chat'}</button>}
    </ClassicMenu>}
  </>;
}
function ClassicMenu({ anchor, close, children }: { anchor: RefObject<HTMLButtonElement | null>; close(): void; children: ReactNode }) {
  const ref = useAnchoredMenu<HTMLDivElement>(anchor);
  useFocusInside(ref, anchor); useOverlay(true, close);
  return <><div className="room-menu-scrim" onPointerDown={e => { e.preventDefault(); e.stopPropagation(); close(); }}/><div ref={ref} className="room-menu" role="menu" tabIndex={-1}>{children}</div></>;
}
