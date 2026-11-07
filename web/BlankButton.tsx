// The 🧪 button beside "＋ New room" (Classic) and "＋ New chat" (Organized): a compact square that opens a small popover
// anchored to it, where one tap on a model starts a blank chat (Alice, 2026-11-01). The popover is a lazy chunk (web/BlankChat.tsx).
import { lazy, Suspense, useRef, useState } from 'react';
import type { BlankStarted } from './blank.js';
const BlankPopover = lazy(() => import('./BlankChat.js'));

export function BlankButton({ started, className }: { started(chat: BlankStarted): void; className?: string }) {
  const [open, setOpen] = useState(false), button = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={button} type="button" className={className ? `blank-trigger ${className}` : 'blank-trigger'} aria-label="Blank chat" title="Blank chat: a model with no context" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>🧪</button>
    {open && <Suspense fallback={null}><BlankPopover anchor={button} close={() => setOpen(false)} started={chat => { setOpen(false); started(chat); }}/></Suspense>}
  </>;
}
