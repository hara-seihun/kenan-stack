import { readFile } from 'node:fs/promises';
import type { ImageContent } from '@earendil-works/pi-ai';
import { detectSupportedImageMimeTypeFromFile, resizeImage } from '@earendil-works/pi-coding-agent';
import type { AgentInput, Deps } from '../types.js';

export type PromptInput = { text: string; images: ImageContent[] };

type Attachment =
  | { kind: 'missing'; id: string }
  | { kind: 'file'; note: string }
  | { kind: 'image'; note: string; image: ImageContent }
  | { kind: 'unreadable-image'; note: string };

/** A stored image is sent to the model inline, resized to the provider's inline limit; every attachment also names its path so tools can use the original. */
async function attachment(deps: Pick<Deps, 'store'>, id: string): Promise<Attachment> {
  const file = await deps.store.getFile(id);
  if (!file) return { kind: 'missing', id };
  const note = `Attached file: ${file.name} (${file.mime}), path: ${file.path}`;
  const sniffed = await detectSupportedImageMimeTypeFromFile(file.path).then(mimeType => ({ ok: true as const, mimeType }), (error: unknown) => ({ ok: false as const, error: String(error) }));
  if (!sniffed.ok) return { kind: 'missing', id: `${id} (${file.name}): ${sniffed.error}` };
  if (!sniffed.mimeType) return { kind: 'file', note };
  const resized = await resizeImage(await readFile(file.path), sniffed.mimeType);
  return resized
    ? { kind: 'image', note: resized.wasResized ? `${note} (shown resized to ${resized.width}x${resized.height}; original ${resized.originalWidth}x${resized.originalHeight})` : note, image: { type: 'image', data: resized.data, mimeType: resized.mimeType } }
    : { kind: 'unreadable-image', note: `${note} (could not be shown inline; open it from the path)` };
}

export async function promptInput(deps: Pick<Deps, 'store'>, input: AgentInput): Promise<PromptInput> {
  const attachments = await Promise.all((input.fileIds ?? []).map(id => attachment(deps, id)));
  const lines = attachments.map(a => a.kind === 'missing' ? `Attached file ${a.id} is not stored.` : a.note);
  const images = attachments.flatMap(a => a.kind === 'image' ? [a.image] : []);
  const header = input.kind === 'human' ? '' : `[${input.kind} from ${input.fromId}]\n`;
  return { text: header + [input.text, ...lines].join('\n'), images };
}
