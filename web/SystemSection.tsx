import { useState, type ReactNode } from 'react';
import './systemSection.css';

/** Environment repairs stay available without crowding the person's work. */
export function SystemSection({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return <details className="system-section" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>System <span className="system-count">({count})</span></summary>
    {open && children}
  </details>;
}
