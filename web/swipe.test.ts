import { describe, expect, it } from 'vitest';
import { SWIPE_MAX_PX, SWIPE_REPLY_PX, swipeOffset, swipeReplies, swiping } from './swipe.js';

describe('swipe to reply', () => {
  it('ignores vertical scrolling and tiny movements', () => {
    expect(swiping(5, 0)).toBe(false);
    expect(swiping(20, 30)).toBe(false);
    expect(swiping(-40, 0)).toBe(false);
    expect(swiping(30, 4)).toBe(true);
  });
  it('follows the finger, then resists, capped', () => {
    expect(swipeOffset(-10)).toBe(0);
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(500)).toBe(SWIPE_MAX_PX);
  });
  it('replies only past the threshold', () => {
    expect(swipeReplies(SWIPE_REPLY_PX - 1, 0)).toBe(false);
    expect(swipeReplies(SWIPE_REPLY_PX, 5)).toBe(true);
    expect(swipeReplies(90, 60)).toBe(false);
  });
});
