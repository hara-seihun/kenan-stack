// Row tints for the to-do rows (palettes in shared/colors.ts). Rows are tinted with precomputed #RRGGBBAA (no color-mix(),
// which older Android WebViews lack).
import type { Todo } from '../../shared/contract.js';
import { CHAT_ALPHA, WARM, hex, spread } from '../../shared/colors.js';
import { colourOrder } from '../../shared/todo.js';

/** Tint strength: her chat palette's own (shared/colors.ts CHAT_PALETTE); other colours (the to-do gradient, colours
 *  from before her palette) by hue ("Brighter", chosen on Android): yellows/oranges strong so they don't brown,
 *  lime/green medium, the rest light. Gold is capped at 50% so white 16px text keeps WCAG AA contrast (4.5:1). */
export function alphaOf(color: string): number {
  const own = CHAT_ALPHA.get(color);
  if (own !== undefined) return own;
  const [r, g, b] = hex(color);
  if (r > 200 && g > 150 && b < 80) return 0x80;
  if (r > 200 && g > 100 && b < 80) return 0x73;
  if (g > r && g > b && r > 80 && b < 120) return 0x52;
  if (r > 150 && b > 40 || b > 180 && r > 80 && g < 120) return 0x4d;
  return 0x38;
}
export const rowBackground = (color: string) => `${color}${alphaOf(color).toString(16).padStart(2, '0')}`;
export const checkStyle = (color: string) => ({ background: `${color}4d`, boxShadow: `inset 0 0 0 1.5px ${color}b3` });

/** To-do rows are coloured by where they sit now (Carol 2026-10-22): the warm rainbow from gold at the top to indigo at
 *  the bottom, spread over all open items in colourOrder, so moving an item up makes it warmer and an item has the same
 *  colour on Home, the To-do screen, a project page and its chat card (Carol 2026-10-25). Never a stored colour. */
export function todoColors(items: readonly Todo[], today: string): Map<string, string> {
  const rows = colourOrder(items, today), shades = spread(WARM, rows.length);
  return new Map(rows.map((t, i) => [t.id, shades[i]!]));
}
