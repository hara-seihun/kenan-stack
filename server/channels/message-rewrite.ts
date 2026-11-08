// Message copies can live on any linked service, even when its database does not hold the source chat.
// Only the owning service fans out. Receivers scrub local copies and never forward the request again.
import type { Message } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { scrubChatNotificationCopies } from '../chat-notify.js';
import { linkCall, type LinkResult } from './link.js';

export const MESSAGE_REWRITE_PATH = '/messages/rewrite-copies';
// Also allows a first cleanup while a large imported-history index is still being built.
const REWRITE_TIMEOUT_MS = 15 * 60_000;

function validMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return ['id', 'conversationId', 'authorId'].every(key => typeof m[key] === 'string' && (m[key] as string).length > 0)
    && typeof m.text === 'string' && Array.isArray(m.parts)
    && m.parts.every(part => part && typeof part === 'object' && typeof part.type === 'string')
    && ['human', 'assistant', 'tool', 'notice'].includes(m.role as string)
    && ['shown', 'background', 'silent'].includes(m.display as string)
    && ['streaming', 'done', 'error', 'stopped'].includes(m.state as string)
    && Number.isSafeInteger(m.seq) && (m.seq as number) >= 0
    && typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)
    && typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt)
    && (m.clientId === null || typeof m.clientId === 'string')
    && typeof m.clipped === 'boolean';
}

/** Root-only link handler: the source row need not exist in this service's database. */
export async function receiveMessageRewrite(deps: Deps, body: unknown): Promise<LinkResult<null>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_message_rewrite' };
  const { message, replacement } = body as Record<string, unknown>;
  if (!validMessage(message) || !(replacement === null || typeof replacement === 'string'))
    return { ok: false, error: 'invalid_message_rewrite' };
  try {
    const text = replacement ?? '[message deleted]';
    await deps.runtime.rewriteMessageCopies(message, text, async () => {
      await scrubChatNotificationCopies(deps, message, text, () => deps.store.scrubMessageCopies(message, text));
    });
    return { ok: true, value: null };
  } catch {
    // Store and runtime failures can contain message text. Never send their details across the link or log them here.
    return { ok: false, error: 'message_rewrite_failed' };
  }
}

/** Attempts every sibling concurrently, not just the first that answers. Safe to repeat with the same original. */
export async function rewriteLinkedMessageCopies(deps: Deps, message: Message, text: string | null): Promise<void> {
  const siblings = [...new Set(deps.config.link?.siblings ?? [])].filter(socket => socket !== deps.config.link?.listen);
  const results = await Promise.all(siblings.map(async socket => {
    try {
      const result = await linkCall<null>(socket, MESSAGE_REWRITE_PATH, { message, replacement: text }, REWRITE_TIMEOUT_MS);
      return result.ok;
    } catch { return false; }
  }));
  const failed = results.filter(ok => !ok).length;
  if (failed) throw new Error(`linked_message_rewrite_incomplete: ${failed} of ${siblings.length} linked services did not scrub their copies; retry with the original message`);
}
