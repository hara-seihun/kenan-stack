// Files a paste or drop carries, so they become attachments like the Attach button's (Dave 2026-10-23: ⌘V of a
// screenshot on his Mac did nothing). A paste keeps its text when the clipboard holds real words beside a picture,
// as Excel and Word do with a rendered image of the cells; a Finder copy's file names or Copy Image's URL are not words.

export type Transfer = Pick<DataTransfer, 'types' | 'getData'> & { files: ArrayLike<File>; items?: ArrayLike<{ kind: string; getAsFile(): File | null }> };

export type PastePlan = { kind: 'text' } | { kind: 'files'; files: File[] };

export function transferFiles(data: Transfer): File[] {
  if (data.files.length) return Array.from(data.files);
  return Array.from(data.items ?? []).flatMap(item => item.kind === 'file' ? [item.getAsFile()].filter((f): f is File => f !== null) : []);
}

export function carriesFiles(data: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(data.types).includes('Files');
}

export function pastePlan(data: Transfer, now: Date): PastePlan {
  const files = transferFiles(data);
  if (!files.length) return { kind: 'text' };
  const text = Array.from(data.types).includes('text/plain') ? data.getData('text/plain').trim() : '';
  const names = new Set(files.map(f => f.name));
  const onlyNames = text.split(/\r?\n/).every(line => names.has(line.trim()) || names.has(line.trim().split('/').pop() ?? ''));
  const onlyUrl = /^https?:\/\/\S+$/.test(text);
  if (text && !onlyNames && !onlyUrl) return { kind: 'text' };
  return { kind: 'files', files: files.map((file, i) => named(file, now, files.length > 1 ? i + 1 : null)) };
}

/** A clipboard picture arrives as "image.png" (Safari, Chrome); give it a name that tells several apart. */
function named(file: File, now: Date, index: number | null): File {
  const generic = /^image\.(\w+)$/i.exec(file.name);
  if (!generic && file.name) return file;
  const ext = generic?.[1] ?? file.type.split('/')[1];
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} at ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
  return new File([file], `Pasted image ${stamp}${index === null ? '' : ` (${index})`}${ext ? `.${ext.toLowerCase()}` : ''}`, { type: file.type, lastModified: file.lastModified });
}

/** Writes text to the clipboard: the Clipboard API (granted without a gesture in Chrome and the Android WebView), then the older copy command. */
export async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* no Clipboard API or refused: try the copy command */ }
  const area = document.createElement('textarea');
  area.value = text; area.readOnly = true; area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area); area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}
