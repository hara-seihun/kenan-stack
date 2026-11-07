/** Swipe a message to the right to reply, like Signal. Pure decision logic, so it can be tested without a DOM. */
export const SWIPE_REPLY_PX = 64;
export const SWIPE_MAX_PX = 88;

/**
 * Whether a touch that moved by (dx, dy) is a reply swipe in progress: rightward, clearly more horizontal than vertical,
 * so vertical scrolling and text-selection drags (which start with no movement) are left alone.
 */
export function swiping(dx: number, dy: number): boolean {
  return dx > 12 && Math.abs(dy) < 24 && dx > Math.abs(dy) * 2;
}

/** How far the message follows the finger: 1:1 up to the threshold, then resisting, capped. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_REPLY_PX) return dx;
  return Math.min(SWIPE_MAX_PX, SWIPE_REPLY_PX + (dx - SWIPE_REPLY_PX) * 0.3);
}

/** Released far enough right to reply. */
export const swipeReplies = (dx: number, dy: number): boolean => dx >= SWIPE_REPLY_PX && Math.abs(dy) < 40;
