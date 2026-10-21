import { describe, expect, it } from 'vitest';
import { COOL, PINNED, TEXT, WARM, composite, contrast, rowBackground, spread } from './colors.js';

describe('Organized colours', () => {
  it('every tinted row keeps white 16px text at WCAG AA (4.5:1), for any list length', () => {
    const all = [...PINNED, ...[1, 2, 3, 5, 7, 12].flatMap(n => [...spread(WARM, n), ...spread(COOL, n)])];
    for (const color of all) expect(contrast(TEXT, composite(rowBackground(color))), color).toBeGreaterThanOrEqual(4.5);
  });
  it('spreads three items far apart and never repeats neighbours in long lists', () => {
    expect(spread(WARM, 3)).toEqual(['#ffc21a', '#ff8410', '#b23fb8']);
    expect(spread(COOL, 3)).toEqual(['#9bc53d', '#5b7fd0', '#9a48b8']);
    const long = spread(WARM, 12);
    expect(new Set(long).size).toBe(12);
    expect(long[0]).toBe(WARM[0]); expect(long.at(-1)).toBe(WARM.at(-1));
  });
});
