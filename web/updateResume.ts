// Only client-owned editing state crosses a frontend update; messages are fetched afresh.
import type { FileInfo } from '../shared/contract.js';
import type { ReplyTarget } from './reply.js';
import type { Page } from './screens.js';

export type UpdateScroll = { id: string; top: number; following: boolean };
export type UpdateResume = {
  owner: string; active: string | null; page: Page;
  drafts: Record<string, string>; attachments: Record<string, FileInfo[]>; replies: Record<string, ReplyTarget | null>;
  range: { conversationId: string; before: number; limit: number } | null;
  scroll: UpdateScroll | null;
};
const KEY = 'kenan-update-resume';
export function takeUpdateResume(): UpdateResume | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as UpdateResume;
    if (!saved.owner || !saved.drafts || !saved.attachments || !saved.replies) return null;
    sessionStorage.removeItem(KEY);
    return saved;
  } catch { return null; }
}
export function saveUpdateResume(saved: UpdateResume): boolean {
  try { sessionStorage.setItem(KEY, JSON.stringify(saved)); return true; }
  catch { return false; } // No room to keep her work: leave this page running.
}
export function captureUpdateScroll(following: boolean): UpdateScroll | null {
  const box = document.querySelector<HTMLElement>('.transcript');
  if (!box) return null;
  const row = [...box.querySelectorAll<HTMLElement>(':scope > [data-id]')].find(row => row.offsetTop + row.offsetHeight > box.scrollTop);
  return row ? { id: row.dataset.id!, top: row.getBoundingClientRect().top - box.getBoundingClientRect().top, following } : null;
}
