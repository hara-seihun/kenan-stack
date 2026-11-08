// A to-do change from the app, applied locally the way the server applies it (optimistic updates and demo mode).
import type { Todo, TodoLevel } from '../../shared/contract.js';

export type TodoChange = Partial<{ text: string; level: TodoLevel; onDate: string | null; position: number; done: boolean; deleted: boolean; onHome: boolean; conversationId: string | null }>;
export function applyTodoChange(t: Todo, patch: TodoChange, now: number): Todo {
  return {
    ...t,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.level !== undefined ? { level: patch.level } : {}),
    ...(patch.onDate !== undefined ? { onDate: patch.onDate } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.onHome !== undefined ? { onHome: patch.onHome } : {}),
    ...(patch.done !== undefined ? { doneAt: patch.done ? now : null } : {}),
    ...(patch.deleted !== undefined ? { deletedAt: patch.deleted ? now : null } : {}),
    ...(patch.conversationId !== undefined ? { conversationId: patch.conversationId, ownRoom: false } : {}),
    updatedAt: now,
  };
}

/** The to-do pinned at the top of a chat: only the one the chat was made for (even when done), and only when it has
 *  details or a day, since a bare title is already the chat's name. Chats with to-dos merely linked to them show no card. */
export function chatTodo(items: Todo[], conversationId: string): Todo | null {
  return items.find(t => t.ownRoom && t.conversationId === conversationId && t.deletedAt === null && (t.details !== null || t.onDate !== null)) ?? null;
}
