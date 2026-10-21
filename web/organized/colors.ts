// Carol's colour system for the Organized layout (memory/preferences.md "Readability", approved mockups design/final):
// a gradient by position. Warm for what waits on her, cool for recent topics. Rows are tinted with precomputed
// #RRGGBBAA (no color-mix(), which older Android WebViews lack).
export const WARM = ['#ffc21a', '#ff8410', '#e83a3a', '#d63384', '#b23fb8', '#8a4fd6', '#5f63d8'] as const;
export const COOL = ['#9bc53d', '#5fb85a', '#2fb3a8', '#5b7fd0', '#7a6fc0', '#9a48b8'] as const;
/** Pinned topics: Candef orange, B2b magenta, then the cool blues and greens. */
export const PINNED = ['#ff9433', '#c03b8f', '#5b7fd0', '#9bc53d', '#2fb3a8', '#7a6fc0'] as const;
export const TEXT = '#eef1ee';
export const PAGE = '#0e0f0e';

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** n colours spread along `stops`: exact stops while they suffice (3 warm = gold, orange, magenta, keeping gold and
 *  orange far apart from amber; 3 cool = lime, Pacific blue, plum), interpolated between stops beyond that. */
export function spread(stops: readonly string[], n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [stops[0]!];
  if (stops === WARM && n === 3) return [WARM[0], WARM[1], WARM[4]];
  if (stops === COOL && n === 3) return [COOL[0], COOL[3], COOL[5]];
  if (n <= stops.length) return Array.from({ length: n }, (_, i) => stops[Math.round(i * (stops.length - 1) / (n - 1))]!);
  return Array.from({ length: n }, (_, i) => {
    const t = i * (stops.length - 1) / (n - 1), lo = Math.floor(t), hi = Math.min(lo + 1, stops.length - 1), f = t - lo;
    const a = hex(stops[lo]!), b = hex(stops[hi]!);
    return toHex(a.map((v, k) => v + (b[k]! - v) * f));
  });
}

/** Tint strength by hue ("Brighter", chosen on Android): yellows/oranges strong so they don't brown, lime/green
 *  medium, the rest light. Gold is capped at 50% so white 16px text keeps WCAG AA contrast (4.5:1). */
export function alphaOf(color: string): number {
  const [r, g, b] = hex(color);
  if (r > 200 && g > 150 && b < 80) return 0x80;
  if (r > 200 && g > 100 && b < 80) return 0x73;
  if (g > r && g > b && r > 80 && b < 120) return 0x52;
  if (r > 150 && b > 40 || b > 180 && r > 80 && g < 120) return 0x4d;
  return 0x38;
}
export const rowBackground = (color: string) => `${color}${alphaOf(color).toString(16).padStart(2, '0')}`;
export const tileStyle = (color: string) => ({ background: `${color}52`, boxShadow: `inset 0 0 0 1px ${color}99` });
export const checkStyle = (color: string) => ({ background: `${color}4d`, boxShadow: `inset 0 0 0 1.5px ${color}b3` });

const linear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb: number[]) => 0.2126 * linear(rgb[0]!) + 0.7152 * linear(rgb[1]!) + 0.0722 * linear(rgb[2]!);
/** The opaque colour a #RRGGBBAA tint shows over the page. */
export function composite(tint: string, under: string = PAGE): string {
  const a = parseInt(tint.slice(7, 9), 16) / 255, top = hex(tint), base = hex(under);
  return toHex(top.map((v, k) => v * a + base[k]! * (1 - a)));
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
