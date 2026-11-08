import type { Message } from '../shared/contract.js';
import type { Deps } from './types.js';
import { fail } from './db/errors.js';
import { scrubChatNotificationCopies } from './chat-notify.js';
import { rewriteLinkedMessageCopies } from './channels/message-rewrite.js';

/** One writer per message, so two devices cannot scrub against different versions. */
const writing = new Map<string, Promise<unknown>>();
export async function rewriteChatMessage(deps: Deps, personId: string, conversationId: string, messageId: string, text: string | null, agentRedaction = false): Promise<Message> {
  const previous = writing.get(messageId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const conversation = await deps.store.getConversation(conversationId, personId);
    if (!conversation?.memberIds.includes(personId)) fail('forbidden', 'Not a member of this conversation');
    const message = await deps.store.getMessage(conversationId, messageId);
    if (!message) return fail('not_found', 'Message not found');
    if (message.role !== 'human' || (!agentRedaction && message.authorId !== personId)) fail('forbidden', 'Only the author can change this message');
    if (message.deletedAt) return text === null ? message : fail('conflict', 'This message was deleted');
    if (text !== null && (!text.trim() || text.length > 1_000_000)) fail('invalid_input', 'Message needs 1–1000000 characters');
    const replacement = text ?? '[message deleted]';
    // Remote copies go first: on failure the original remains available for an idempotent retry.
    await rewriteLinkedMessageCopies(deps, message, text);
    let changed: Message | undefined;
    await deps.runtime.rewriteMessageCopies(message, replacement, () => scrubChatNotificationCopies(deps, message, replacement, async () => {
      changed = await deps.store.rewriteMessage(message, text);
    }));
    if (!changed) return fail('internal', 'Message rewrite did not commit');
    deps.bus.toConversation(conversationId, { type: 'message', message: changed });
    for (const member of conversation!.memberIds) {
      const fresh = await deps.store.getConversation(conversationId, member);
      if (fresh) deps.bus.toPerson(member, { type: 'conversation', conversation: fresh });
    }
    return changed;
  });
  writing.set(messageId, operation);
  try { return await operation; } finally { if (writing.get(messageId) === operation) writing.delete(messageId); }
}
