/**
 * Meeting notes are posted once per real meeting end. A session id can see more than one end (an operator
 * re-claims it after a false start), so the notice's client id carries the end time too: a different end is a
 * different post, while a repeat of the same end (a retried delivery) is recognised by the unique client id and
 * sends neither the notice nor the manager message again.
 */
export const notesEndKey = (leftAt: number | null): string => leftAt === null ? 'unknown' : String(leftAt);
export const notesClientId = (sessionId: string, leftAt: number | null): string => `meeting-notes:${sessionId}:${notesEndKey(leftAt)}`;

/** PostgreSQL's unique violation on the message client id. */
export function isDuplicateClientId(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return e.constraint === 'message_client' || (e.code === '23505' && /message_client/.test(String(e.message ?? ''))) || /unique constraint "?message_client"?/.test(String(e.message ?? ''));
}

export type NotesPost = 'posted' | 'already-posted' | 'notice-failed';
export async function postNotesOnce(append: () => Promise<unknown>, tell: () => Promise<unknown>, logError: (message: string) => Promise<unknown>): Promise<NotesPost> {
  try { await append(); }
  catch (error) {
    if (isDuplicateClientId(error)) return 'already-posted';
    await logError(error instanceof Error ? error.message : String(error));
    await tell();
    return 'notice-failed';
  }
  await tell();
  return 'posted';
}
