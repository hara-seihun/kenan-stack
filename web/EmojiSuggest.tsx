// The composer's completions: ":re" lists the custom emoji that match, "@do" the people and Kenaznias a message can be addressed to (web/mention.ts); tap or pick with the keys.
import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from 'react';
import type { Standard } from './emoji-unicode.js';
import { emojiSrc, suggest, typedShortcode } from './emoji.js';
import { suggestMention } from './mention.js';

type Field = HTMLTextAreaElement | HTMLInputElement;
type Chosen = { id: string; index: number };
type Item = { key: string; insert: string; label: string; emoji: string | null; char?: string };

export function useEmojiSuggest(text: string, setText: (text: string) => void, input: RefObject<Field | null>, mentions: readonly string[] = []) {
  const [caret, setCaret] = useState(0), [chosen, choose] = useState<Chosen>({ id: '', index: 0 }), [closed, close] = useState('');
  const [standard, setStandard] = useState<((query: string) => Standard[]) | null>(null);
  const typed = typedShortcode(text, caret);
  useEffect(() => { if (typed && standard === null) void import('./emoji-unicode.js').then(m => setStandard(() => m.suggestStandard)); }, [typed !== null, standard]);
  const custom = suggest(text, caret), plain = typed && standard ? standard(typed.query) : [];
  const emoji = typed && (custom || plain.length) ? { start: typed.start, items: [
    ...(custom?.matches ?? []).map((n): Item => ({ key: n, insert: `:${n}: `, label: `:${n}:`, emoji: n })),
    ...plain.map((s): Item => ({ key: `u:${s.name}`, insert: `${s.char} `, label: `:${s.name}:`, emoji: null, char: s.char }))].slice(0, 10) } : null;
  const who = emoji ? null : suggestMention(text, caret, mentions);
  const hit: { start: number; items: Item[]; name: string } | null = emoji ? { start: emoji.start, name: 'Emoji', items: emoji.items }
    : who ? { start: who.start, name: 'Mention', items: who.matches.map(n => ({ key: n, insert: `@${n} `, label: `@${n}`, emoji: null })) } : null;
  const id = hit ? `${hit.start}:${hit.items.map(i => i.key).join()}` : '';
  const open = hit !== null && closed !== id ? hit : null;
  const index = chosen.id === id ? chosen.index : 0;
  const insert = (item: Item) => {
    if (!open) return;
    const at = open.start + item.insert.length;
    setText(`${text.slice(0, open.start)}${item.insert}${text.slice(caret)}`);
    setCaret(at);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(at, at); });
  };
  const move = (by: number) => choose({ id, index: (index + by + open!.items.length) % open!.items.length });
  return {
    track: (event: SyntheticEvent<Field>) => setCaret(event.currentTarget.selectionStart ?? 0),
    /** True when the key was for the list, so the composer must not also act on it (Enter must not send). */
    onKey(event: KeyboardEvent<Field>): boolean {
      if (!open || event.nativeEvent.isComposing) return false;
      const key = event.key === 'ArrowDown' ? () => move(1) : event.key === 'ArrowUp' ? () => move(-1)
        : event.key === 'Tab' || event.key === 'Enter' ? () => insert(open.items[index]!)
        : event.key === 'Escape' ? () => close(id) : null;
      if (!key) return false;
      event.preventDefault(); key(); return true;
    },
    list: open && <ul className="emoji-suggest" role="listbox" aria-label={open.name}>{open.items.map((item, i) =>
      <li key={item.key} role="option" aria-selected={i === index}><button type="button" tabIndex={-1} className={i === index ? 'on' : undefined}
        onPointerDown={event => event.preventDefault()} onClick={() => insert(item)}>{item.emoji && <img src={emojiSrc(item.emoji)} alt=""/>}{item.char && <span className="emoji-char">{item.char}</span>}{item.label}</button></li>)}</ul> as ReactNode,
  };
}
