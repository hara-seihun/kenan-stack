// Custom emoji registry: the one place that knows them. ":name:" (or an alias) in a message shows the image inline, and typing ":na" in the
// composer completes from the same list. Nothing else lists emoji.
// To add one: put two images in web/public/emoji/ (NAME.png 64 px inline, under 30 KB; NAME-128.png 128 px shown alone, under 40 KB; square, transparent
// background) and add its name to STILL below (animated WebP: a line in MOTION). Shortcodes are lowercase letters, digits
// and hyphens, at least 2 characters. A message of only 1-3 emoji shows them as big emotes (Discord style); among words they stay inline.
type Entry = { file: string; big: string; aliases?: readonly string[] };
// Still images are `NAME.png` (64 px) and `NAME-128.png`: list the name here. Anything else (animated WebP, aliases) is spelled out in MOTION.
const STILL = 'kenan';
const MOTION: Record<string, Entry> = {};
export const EMOJI: Readonly<Record<string, Entry>> = {
  ...Object.fromEntries(STILL.split(' ').map(name => [name, { file: `${name}.png`, big: `${name}-128.png` }])),
  ...MOTION,
};
const CODES = Object.entries(EMOJI).flatMap(([name, e]) => [name, ...e.aliases ?? []].map(code => ({ code, name })));
export const emojiSrc = (name: string, size: 'file' | 'big' = 'file'): string => `./emoji/${EMOJI[name]![size]}`;
const SHORTCODE = /:([a-z0-9][a-z0-9-]*):/g;

export type Emoji = { code: string; name: string };
export type TextOrEmoji = string | Emoji;

/** Splits plain text into its text and the known shortcodes in it; an unknown ":word:" stays text. */
export function withEmoji(text: string): TextOrEmoji[] {
  const parts: TextOrEmoji[] = [];
  let last = 0;
  for (const match of text.matchAll(SHORTCODE)) {
    const emoji = CODES.find(c => c.code === match[1]);
    if (!emoji) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ code: match[0], name: emoji.name });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export type Suggestion = { start: number; matches: string[] };

/** The ":re" being typed just before the caret. Only after a space or the start, so "12:30" and "http:" never match. */
export function typedShortcode(text: string, caret: number): { start: number; query: string } | null {
  const typed = /(?:^|\s):([a-z0-9][a-z0-9_+-]+)$/i.exec(text.slice(0, caret));
  return typed ? { start: caret - typed[1]!.length - 1, query: typed[1]!.toLowerCase() } : null;
}

/** The custom emoji the typed shortcode could become. */
export function suggest(text: string, caret: number): Suggestion | null {
  const typed = typedShortcode(text, caret);
  const matches = typed ? [...new Set(CODES.filter(c => c.code.startsWith(typed.query)).map(c => c.name))] : [];
  return typed && matches.length ? { start: typed.start, matches } : null;
}

/** The emoji of a message that is nothing but 1-3 of them (Discord's "jumbo"), else null. */
export function onlyEmoji(text: string): Emoji[] | null {
  const parts = withEmoji(text).filter(part => typeof part !== 'string' || part.trim() !== '');
  return parts.length >= 1 && parts.length <= 3 && parts.every(part => typeof part !== 'string') ? parts as Emoji[] : null;
}
