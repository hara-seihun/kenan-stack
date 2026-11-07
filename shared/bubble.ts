/** A person's own message bubble colour: #RRGGBB that white text reads on at WCAG AA (4.5:1) or better. */
export const BUBBLE_MIN_CONTRAST = 4.5;
const HEX = /^#[0-9a-fA-F]{6}$/;
const channel = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** Contrast of white text on `hex` (#RRGGBB), from 1 to 21. */
export function whiteContrast(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}
export const isBubbleColor = (value: unknown): value is string => typeof value === 'string' && HEX.test(value) && whiteContrast(value) >= BUBBLE_MIN_CONTRAST;
