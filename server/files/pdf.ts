// PDF previews (Alice 2026-10-31: "previews PDFs so I don't have to download them"): the server draws pages as JPEG
// with poppler (pdfinfo, pdftoppm), so the web app, the Android WebView and the iPhone home-screen app all show them
// as plain images, and a large PDF costs only the pages someone scrolls to.
import { execFile } from 'node:child_process';
import { PDF_PAGE_WIDTHS, type PdfInfo, type PdfPageWidth } from '../../shared/contract.js';
import { fail } from '../db/errors.js';

/** A page that takes longer than this to draw is broken or hostile; the viewer says so and keeps the download. */
const RENDER_TIMEOUT_MS = 30_000;

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile(command, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: RENDER_TIMEOUT_MS },
    (error, stdout, stderr) => error ? reject(new Error(stderr.toString().trim() || error.message)) : resolve(stdout)));
}

/** Page sizes in points as shown (a page rotated by 90 or 270 degrees swaps width and height), from `pdfinfo -f 1 -l N`. */
export function parsePdfInfo(text: string): PdfInfo {
  const count = Number(/^Pages:\s+(\d+)/m.exec(text)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error('no pages');
  const sizes = new Map<number, { width: number; height: number }>(), rotations = new Map<number, number>();
  for (const m of text.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+) pts/gm)) sizes.set(Number(m[1]), { width: Number(m[2]), height: Number(m[3]) });
  for (const m of text.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) rotations.set(Number(m[1]), Number(m[2]));
  const pages = Array.from({ length: count }, (_, i) => {
    const size = sizes.get(i + 1) ?? sizes.get(1) ?? { width: 612, height: 792 };
    return (rotations.get(i + 1) ?? 0) % 180 === 90 ? { width: size.height, height: size.width } : size;
  });
  return { pages };
}

/** Files never change once stored, so what pdfinfo said about one is kept for the life of the process. */
const infos = new Map<string, Promise<PdfInfo>>();

export function pdfInfo(path: string): Promise<PdfInfo> {
  let info = infos.get(path);
  if (!info) {
    info = run('pdfinfo', ['-f', '1', '-l', '100000', path]).then(out => parsePdfInfo(out.toString()));
    info.catch(() => infos.delete(path));
    infos.set(path, info);
  }
  return info.catch((e: unknown) => fail('invalid_input', `Can't read this PDF: ${e instanceof Error ? e.message : String(e)}`));
}

export const pdfPageWidth = (value: string | undefined): PdfPageWidth =>
  PDF_PAGE_WIDTHS.find(w => String(w) === value) ?? fail('invalid_input', `w must be one of ${PDF_PAGE_WIDTHS.join(', ')}`);

/** One page (1-based) as a JPEG `width` pixels wide. */
export async function pdfPage(path: string, page: number, width: PdfPageWidth): Promise<Buffer> {
  const { pages } = await pdfInfo(path);
  if (!Number.isInteger(page) || page < 1 || page > pages.length) fail('not_found', `This PDF has ${pages.length} pages`);
  return run('pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to-x', String(width), '-scale-to-y', '-1', '-jpeg', '-jpegopt', 'quality=85', path])
    .catch((e: unknown) => fail('invalid_input', `Can't draw page ${page}: ${e instanceof Error ? e.message : String(e)}`));
}
