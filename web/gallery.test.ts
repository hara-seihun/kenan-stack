import { describe, expect, it } from 'vitest';
import { swipeDirection } from './gallery.js';

describe('image viewer swipes', () => {
  it('swiping left goes to the next image, right to the previous', () => {
    expect(swipeDirection(-120, 10)).toBe(1);
    expect(swipeDirection(120, -8)).toBe(-1);
  });
  it('ignores taps, short drags and vertical scrolling', () => {
    expect(swipeDirection(10, 0)).toBe(0);
    expect(swipeDirection(-40, 0)).toBe(0);
    expect(swipeDirection(-80, 200)).toBe(0);
  });
});
