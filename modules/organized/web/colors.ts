// Row tints for the Organized layout's colours (palettes in shared/colors.ts). Rows are tinted with precomputed
// #RRGGBBAA (no color-mix(), which older Android WebViews lack).
import type { GroupFamily } from '../../../shared/contract.js';
import { hex, toHex } from '../../../shared/colors.js';
export const FAMILY_NAMES: Record<GroupFamily, string> = { amber: 'Amber', garnet: 'Pink', plum: 'Purple', blue: 'Blue', teal: 'Teal', lime: 'Lime' };
export const TEXT = '#eef1ee';
export const PAGE = '#0e0f0e';

export const tileStyle = (color: string) => ({ background: `${color}52`, boxShadow: `inset 0 0 0 1px ${color}99` });

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

export { alphaOf, checkStyle, rowBackground, todoColors } from '../../../web/todo/colors.js';
