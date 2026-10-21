// Phone menu keys the brief names, pressed by the bridge itself. GPT Live is told to delegate a menu key, but it does not
// do so reliably: on 2026-10-19 (call c6084b75) the menu said "pour l'achat ou la vente de votre instrument, faites-le 3",
// the brief said to press 3 at once, and no key was pressed; the call only reached the mailbox because the menu fell
// through. The brief's keypress instructions are an ordered list of keys; each is pressed once, as soon as the line's
// transcript announces a menu option with that key.
import { parseDigits, type Digits } from './phone-dtmf.js';

const VERB = String.raw`(?:press(?:ing)?|dial(?:ing)?|enter|select|key|push|presse[rz]?|pressez|appuie[rz]?|appuyez|appuyant|tape[rz]?|tapez|compose[rz]?|composez|fai(?:s|tes|re)|touche|signale[rz]?|signalez)`;
const LINK = String.raw`(?:[- ](?:le|la|l'|sur|sur le|sur la|the|key|number|option|touche|la touche|le chiffre|le numéro))*`;
const WORDS: Record<string, string> = {
  zéro: '0', zero: '0', un: '1', one: '1', deux: '2', two: '2', trois: '3', three: '3', quatre: '4', four: '4', cinq: '5', five: '5',
  six: '6', sept: '7', seven: '7', huit: '8', eight: '8', neuf: '9', nine: '9', étoile: '*', star: '*', dièse: '#', carré: '#', pound: '#', hash: '#',
};
// A single key: a numeral not part of a longer number (a phone number, an address), *, #, or a spoken digit.
const KEY = String.raw`(\d(?!\d)|[*#]|${Object.keys(WORDS).join('|')})(?![\p{L}\d])`;
/** In a brief, only numerals, * and # count, after a keypress verb: "fais presser 3", "press 1 for French". */
const BRIEF = new RegExp(String.raw`(?<![\p{L}])${VERB}${LINK}\s*(\d(?!\d)|[*#])(?![\p{L}\d])`, 'giu');
/** On the line, a menu announces its keys in words or numerals: "faites-le 3", "appuyez sur le un", "press one". */
const LINE = new RegExp(String.raw`(?<![\p{L}])${VERB}${LINK}\s*${KEY}`, 'giu');

const key = (raw: string): Digits | null => {
  const parsed = parseDigits(WORDS[raw.toLowerCase()] ?? raw);
  return parsed.ok ? parsed.value : null;
};

/** The keys a brief says to press on a phone menu, in order. A key repeated within one sentence is one press. */
export function briefKeys(brief: string): Digits[] {
  const keys: Digits[] = [];
  for (const sentence of brief.split(/[.;!?\n]+(?:\s|$)/)) {
    const inSentence: string[] = [];
    for (const match of sentence.matchAll(BRIEF)) {
      const digit = key(match[1]!);
      if (digit && !inSentence.includes(digit)) { inSentence.push(digit); keys.push(digit); }
    }
  }
  return keys;
}

export type MenuPress = { key: Digits; why: 'brief' | 'replay' };
/** A menu replaying the option a press answered means the press did not register: it is pressed again this many times. */
export const REPLAY_PRESSES = 2;
const label = (before: string) => before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('?'), before.lastIndexOf('!')) + 1).toLowerCase().replace(/[^\p{L}]/gu, '');

/** Watches what the line says for the menu options the brief names, and for a menu replaying after a press; returns
 *  each key to press. */
export class MenuWatch {
  private heard = '';
  private scanned = 0;
  /** The option each key was last announced with. */
  private readonly options = new Map<Digits, string>();
  private last: { key: Digits; option: string; at: number; replays: number } | null = null;
  constructor(private readonly pending: Digits[]) {}

  get remaining(): readonly Digits[] { return this.pending; }

  /** GPT Live's transcript of the line. Returns the key to press now: the brief's next key once the line announces it,
   *  or the last key again when the menu replays the option it answered. */
  person(delta: string): MenuPress | null {
    this.heard += delta;
    LINE.lastIndex = 0;
    for (const match of this.heard.slice(this.scanned).matchAll(LINE)) {
      const start = this.scanned + match.index, end = start + match[0].length;
      const announced = key(match[1]!);
      const option = label(this.heard.slice(Math.max(this.scanned, start - 120), start));
      this.scanned = end;
      if (!announced) continue;
      this.options.set(announced, option);
      const last = this.last;
      if (last && last.key === announced && last.option === option && option && start >= last.at && last.replays < REPLAY_PRESSES) {
        this.last = { ...last, at: end, replays: last.replays + 1 };
        return { key: announced, why: 'replay' };
      }
      if (announced === this.pending[0]) {
        this.pending.shift();
        this.last = { key: announced, option, at: end, replays: 0 };
        return { key: announced, why: 'brief' };
      }
    }
    return null;
  }

  /** Someone else pressed keys (the call agent): the brief's next keys they cover are done, and a single key is pressed
   *  again if the menu replays the option it answers. */
  pressed(digits: string): void {
    for (const digit of digits) if (digit === this.pending[0]) this.pending.shift();
    const single = parseDigits(digits);
    if (single.ok && single.value.length === 1) {
      const option = this.options.get(single.value);
      this.last = option ? { key: single.value, option, at: this.heard.length, replays: 0 } : null;
    }
  }
}
