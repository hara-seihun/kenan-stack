import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { plainPreview, shortCardLine } from '../shared/contract.js';

/** The closed card is always two short lines. Its full content is one tap away. */
export const shortSummary = (text: string): string => shortCardLine(plainPreview(text).replace(/\s*[:·]\s*/g, ' ').split(/\s+/).slice(0, 6).join(' '));

export function FoldCard({ category, summary, icon, status, failed = false, className = '', onOpen, children }: {
  category: string; summary: string; icon?: ReactNode; status?: ReactNode; failed?: boolean; className?: string;
  onOpen?: () => void; children: ReactNode | ((open: boolean) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  return <details className={`tool-card${failed ? ' failed' : ''}${className ? ` ${className}` : ''}`} onToggle={e => {
    const opened = e.currentTarget.open; setOpen(opened); if (opened) onOpen?.();
  }}>
    <summary title={`${category}\n${summary}`}>
      {icon}
      <span className="tool-line">
        <span className="tool-head"><strong>{shortCardLine(category.replace(/:+$/, ''))}</strong></span>
        <span className="tool-subject">{shortSummary(summary)}</span>
      </span>
      {status && <span className="tool-state">{status}</span>}
      <ChevronRight className="tool-chevron" size={15}/>
    </summary>
    {typeof children === 'function' ? children(open) : open ? children : null}
  </details>;
}
