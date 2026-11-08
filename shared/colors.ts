// Carol's colour system for the Organized layout (memory/preferences.md "Readability", approved mockups design/final):
// warm for what waits on her, cool for topics. Every chat keeps its own colour (member.color, set once by
// the server: pickColor for a new chat, positionColors to freeze what older chats showed); the palettes and both rules
// live here so the server and the web agree. web/organized/colors.ts turns a colour into row tints.
import type { ChatGroup, ConversationSummary, GroupFamily } from './contract.js';
export const WARM = ['#ffc21a', '#ff8410', '#e83a3a', '#d63384', '#b23fb8', '#8a4fd6', '#5f63d8'] as const;
/** Calendar events' cool colours (CalendarViews); chats use CHAT_PALETTE. */
export const COOL = ['#9bc53d', '#5fb85a', '#2fb3a8', '#5b7fd0', '#7a6fc0', '#9a48b8'] as const;
/** Her chat palette (Carol 2026-10-25, final round-3 "E3", mockup design/chat-palette/round3/E3.png; no coral, no warm
 *  red): every colour a chat, project or shopping section can have, with the alpha of its row wash over the page. Strong
 *  veils so rows read as colour, not as a dark page: gold 0x8a (E3's 0x8c less 1%, so white text keeps WCAG AA),
 *  orange and the blues 0x86, lime and sea green 0x70, lavender and pink 0x79, violet and magenta 0x6c. */
export const CHAT_PALETTE = [
  ['#f2b42a', 'Gold', 0x8a], ['#f08a2e', 'Orange', 0x86], ['#9bc53d', 'Lime', 0x70], ['#17b8a0', 'Sea green', 0x70],
  ['#6aafff', 'Pale blue', 0x86], ['#2f6ff2', 'Royal blue', 0x86], ['#8a64f0', 'Violet', 0x6c], ['#c9a0ff', 'Lavender', 0x79],
  ['#cc3f9e', 'Magenta', 0x6c], ['#f06fb7', 'Pink', 0x79],
] as const satisfies readonly (readonly [string, string, number])[];
/** The colours a reader can give a person's messages in a chat (a soft red and a warm yellow among them). */
export const MEMBER_COLORS = [
  ['#e5575a', 'Red'], ['#f08a2e', 'Orange'], ['#f2b42a', 'Yellow'], ['#9bc53d', 'Green'],
  ['#17b8a0', 'Teal'], ['#6aafff', 'Blue'], ['#8a64f0', 'Violet'], ['#f06fb7', 'Pink'],
] as const satisfies readonly (readonly [string, string])[];
type ChatColor = typeof CHAT_PALETTE[number][0];
const [GOLD, ORANGE, LIME, SEA, PALE, ROYAL, VIOLET, LAVENDER, MAGENTA, PINK] = CHAT_PALETTE.map(([c]) => c) as ChatColor[] as [ChatColor, ChatColor, ChatColor, ChatColor, ChatColor, ChatColor, ChatColor, ChatColor, ChatColor, ChatColor];
/** Pinned topics: Business orange, B2b magenta, then the cool blues and greens. */
export const PINNED = [ORANGE, MAGENTA, ROYAL, LIME, PALE, VIOLET, GOLD, SEA, LAVENDER, PINK] as const;
/** Chat group colour families (Chats sections): two neighbouring colours of her palette each, so a group's rows read as
 *  one family while scrolling; the second is the family's swatch. `garnet` is the stored name of the pink family.
 *  OTHER (ungrouped) uses the whole palette, cool first. */
export const FAMILIES: Record<GroupFamily, readonly ChatColor[]> = {
  amber: [GOLD, ORANGE],
  garnet: [PINK, MAGENTA],
  plum: [LAVENDER, VIOLET],
  blue: [PALE, ROYAL],
  teal: [PALE, SEA],
  lime: [SEA, LIME],
};
export const OTHER = [LIME, ROYAL, VIOLET, SEA, MAGENTA, PALE, LAVENDER, GOLD, PINK, ORANGE] as const;
/** The "Change colour" sheet's swatches: the whole palette. */
type Swatch = readonly [ChatColor, string];
export const SWATCHES = CHAT_PALETTE.map(([c, name]) => [c, name] as const) as readonly Swatch[] as readonly [Swatch, Swatch, Swatch, ...Swatch[]];
export const CHAT_ALPHA: ReadonlyMap<string, number> = new Map(CHAT_PALETTE.map(([c, , a]) => [c, a]));

export const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
export const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

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


/** Most recent activity first: the order of every chat list. */
export const byRecent = (a: ConversationSummary, b: ConversationSummary) => (b.lastMessage?.at ?? b.updatedAt) - (a.lastMessage?.at ?? a.updatedAt);

/** Each open topic's colour as the Organized screens showed it while colours followed position (until 2026-10-22): its own
 *  colour when set; a project page the pinned palette by its place among projects (pinned first, then recent); any other
 *  topic its group section's palette in turn (Other for none or an unknown group) by recency. `topics` are the open topics of one
 *  person (no worker chats, not her main chat). */
export function positionColors(topics: readonly ConversationSummary[], groups: readonly ChatGroup[]): Map<string, string> {
  const out = new Map<string, string>(), open = topics.filter(c => !c.archived);
  const projects = open.filter(c => c.project).sort((a, b) => (a.pinnedAt ?? Infinity) - (b.pinnedAt ?? Infinity) || byRecent(a, b));
  projects.forEach((c, i) => out.set(c.id, c.color ?? PINNED[i % PINNED.length]!));
  const families = new Map(groups.map(g => [g.id, g.family] as const)), sections = new Map<string | null, ConversationSummary[]>();
  for (const c of open.filter(c => !c.project).sort(byRecent)) {
    const key = c.groupId !== null && families.has(c.groupId) ? c.groupId : null;
    sections.set(key, [...(sections.get(key) ?? []), c]);
  }
  for (const [key, items] of sections) {
    const palette: readonly string[] = key === null ? OTHER : FAMILIES[families.get(key)!];
    items.forEach((c, i) => out.set(c.id, c.color ?? palette[i % palette.length]!));
  }
  return out;
}

/** A new topic's colour: from its section's palette, the one least like the topics it will sit next to (the most recent
 *  in that section, nearest first), then the one that section uses least, then palette order. */
export function pickColor(palette: readonly string[], neighbours: readonly string[], used: readonly string[]): string {
  const distance = (a: string, b: string) => { const x = hex(a), y = hex(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  const score = (c: string) => [Math.min(Infinity, ...neighbours.slice(0, 2).map(n => distance(c, n))), -used.filter(u => u === c).length] as const;
  let best = palette[0]!;
  for (const c of palette.slice(1)) {
    const [d, u] = score(c), [bd, bu] = score(best);
    if (d > bd || d === bd && u > bu) best = c;
  }
  return best;
}
