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

// A sentence that only describes an option or says not to take it names no key to press. Call 2be6f3f4 (2026-10-27): the
// brief said the queue "will offer to press 1 for a callback: do NOT take the callback", and the bridge pressed 1 there.
const NOT_AN_INSTRUCTION = /\b(?:not|don't|never|ignore|avoid|skip|decline|offers?|offering|ne|n'|pas|jamais|ignore[rz]?|offre)\b|\bcall(?:-| )?backs?\b|\brappel/i;

/** The keys a brief says to press on a phone menu, in order. A key repeated within one clause is one press. Clauses, not
 *  sentences, are judged: on call f7393810 (2026-10-28) "Then, at the menu that offers partner services (1) and traveller
 *  customer service (2), press 2" was skipped whole for its "offers", and the bridge chose the partner queue itself. */
export function briefKeys(brief: string): Digits[] {
  const keys: Digits[] = [];
  for (const sentence of brief.split(/[.;:!?\n,]+(?:\s|$)/)) {
    if (NOT_AN_INSTRUCTION.test(sentence)) continue;
    const inSentence: string[] = [];
    for (const match of sentence.matchAll(BRIEF)) {
      const digit = key(match[1]!);
      if (digit && !inSentence.includes(digit)) { inSentence.push(digit); keys.push(digit); }
    }
  }
  return keys;
}

export type MenuPress = { key: Digits; why: 'brief' | 'replay' | 'language' | 'person' };
// With no key left from the brief, the bridge takes the menu toward a person (call a757ee0f, 2026-10-23: the school-tax
// menu offered "pour toute autre question, faites le zéro pour parler à l'un de nos agents", nobody pressed it, and Kenan
// talked over the menu), and picks the call's language when the menu offers it.
// An option for someone other than the caller: TuGo's menu (call e559897f, 2026-10-28) announced "for partner services,
// press 1" before "if you are a traveller with a customer service question, press 2", and the bridge pressed 1 into the
// partner queue.
const NOT_CALLER = /\b(?:partners?|partenaires?|brokers?|courtiers?|advisors?|conseillers? en voyages?|travel agents?|agents? de voyages?|agencies|agences?|providers?|fournisseurs?|hospitals?|h[ôo]pitaux|h[ôo]pital|clinics?|cliniques?|pharmac(?:y|ies|ie)|physicians?|m[ée]decins?|vendors?|merchants?|marchands?|dealers?|media|m[ée]dias|employers?|employeurs?|professionnels?|professionals?)\b/i;
const TO_PERSON = /\b(?:agent|agente|pr[ée]pos[ée]e?|repr[ée]sentante?|conseill[eè]re?|t[ée]l[ée]phoniste|standardiste|r[ée]ceptionniste|op[ée]rat(?:or|eur|rice)|representative|receptionist|someone|une personne|quelqu'un|parler (?:à|a|avec)|speak (?:to|with)|talk (?:to|with)|autres? (?:questions?|demandes?|renseignements?)|other (?:questions?|inquiries|enquiries|requests?)|toute autre|any other|all other|customer service|customer care|service (?:à|a) la client[eè]le|service client|service requests?|service calls?|demande de service)\b/i;
const LANGUAGES: Record<'en' | 'fr', RegExp> = { en: /\b(?:english|anglais)\b/i, fr: /\b(?:fran[cç]ais|french)\b/i };
/** The sentence around a key announcement: the option's words often come after the key ("faites le 0 pour parler à un agent"). */
const sentenceAround = (text: string, start: number, end: number) => {
  const before = text.slice(0, start), after = text.slice(end);
  const from = Math.max(before.lastIndexOf('.'), before.lastIndexOf('?'), before.lastIndexOf('!')) + 1;
  const stop = after.search(/[.?!]/);
  return before.slice(from) + text.slice(start, end) + (stop < 0 ? after : after.slice(0, stop));
};
/** Shared by Live, the call agent and line facts: answer the current prompt, not the whole call goal. */
export const MENU_SPEECH_RULE = 'Spoken phone menus: answer only the current question with one short answer, without greetings, politeness, explanations or a second request. For a yes/no question such as "Are you a healthcare provider?", say only "No" when that is the truthful answer, never "No. Agent, please." For a department question, use the department the brief names (for example "Front Store services"); ask for "Agent" only when that next menu offers it or asks how it can help. Follow the brief’s route in order. If a prompt repeats, simplify the answer to the exact accepted word, not the same failed phrase. Never guess an unoffered keypad shortcut such as 0. Emergency directions to hang up and dial 911 are not menu options.';

// Numbers to dial are not single menu keys, including spaced/hyphenated emergency and telephone numbers.
const keyOffered = (text: string, start: number, end: number): boolean => {
  const sentence = sentenceAround(text, start, end);
  return !/\b(?:emergency|urgence|hang up|raccroch)/i.test(sentence)
    && !/^\s*[-–.,]?\s*\d/.test(text.slice(end))
    && !/^\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|un|deux|trois|quatre|cinq|six|sept|huit|neuf)\b/i.test(text.slice(end));
};

export type MenuChoices = { language: 'en' | 'fr' | null; person: boolean };
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
  private languageDone = false;
  private personPresses = 0;
  /** Sentences announcing a key, waiting for the menu to say what the option is. */
  private open: { key: Digits; start: number; end: number }[] = [];
  constructor(private readonly pending: Digits[], private readonly choices: MenuChoices = { language: null, person: false }) {}

  get remaining(): readonly Digits[] { return this.pending; }

  /** GPT Live's transcript of the line. Returns the key to press now: the brief's next key once the line announces it,
   *  or the last key again when the menu replays the option it answered. */
  person(delta: string): MenuPress | null {
    this.heard += delta;
    LINE.lastIndex = 0;
    const scanStart = this.scanned;
    for (const match of this.heard.slice(scanStart).matchAll(LINE)) {
      const start = scanStart + match.index, end = start + match[0].length;
      const announced = key(match[1]!);
      this.scanned = end;
      if (!announced) continue;
      this.open.push({ key: announced, start, end });
    }
    return this.choose();
  }

  /** Keys the menu offered that the brief does not name: the call's language, then a person, judged once the option's
   *  sentence is complete. */
  private choose(): MenuPress | null {
    while (this.open.length) {
      const { key: offered, start, end } = this.open[0]!;
      const rest = this.heard.slice(end);
      const complete = /[.?!]/.test(rest) || this.open.length > 1;
      if (!complete) return null;
      this.open.shift();
      if (!keyOffered(this.heard, start, end)) continue;
      const option = label(this.heard.slice(Math.max(0, start - 120), start));
      this.options.set(offered, option);
      const last = this.last;
      if (last && last.key === offered && last.option === option && option && start >= last.at && last.replays < REPLAY_PRESSES) {
        this.last = { ...last, at: end, replays: last.replays + 1 };
        return { key: offered, why: 'replay' };
      }
      const sentence = sentenceAround(this.heard, start, end);
      const otherLanguage = this.choices.language !== null && Object.entries(LANGUAGES)
        .some(([code, words]) => code !== this.choices.language && words.test(sentence));
      if (offered === this.pending[0] && !otherLanguage) {
        this.pending.shift();
        this.last = { key: offered, option, at: end, replays: 0 };
        return { key: offered, why: 'brief' };
      }
      if (this.pending.length) continue;
      const language = this.choices.language;
      if (language && !this.languageDone && LANGUAGES[language].test(sentence)) {
        this.languageDone = true;
        this.last = { key: offered, option: label(this.heard.slice(Math.max(0, start - 120), start)), at: end, replays: 0 };
        return { key: offered, why: 'language' };
      }
      if (this.choices.person && this.personPresses < 1 && TO_PERSON.test(sentence) && !NOT_CALLER.test(sentence) && !/(?:rappel|call(?:ed)? back|callback|message)/i.test(sentence)) {
        this.personPresses++;
        this.last = { key: offered, option: label(this.heard.slice(Math.max(0, start - 120), start)), at: end, replays: 0 };
        return { key: offered, why: 'person' };
      }
    }
    return null;
  }

  /** The line went quiet: an option announced at the very end of the menu, with no full stop after it, is complete. */
  quiet(): MenuPress | null {
    if (!this.open.length) return null;
    this.heard += '.';
    return this.choose();
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

/** Options in the latest menu, for the call agent when deterministic choices do not cover it. */
export function menuOptions(transcript: string): { key: Digits; text: string }[] {
  const heard = transcript.slice(transcript.lastIndexOf('[Kenan pressed') + 1).split('Person:').slice(1).join(' ');
  const options = new Map<Digits, string>();
  for (const match of heard.matchAll(LINE)) {
    const digit = key(match[1]!);
    if (digit && keyOffered(heard, match.index, match.index + match[0].length)) options.set(digit, sentenceAround(heard, match.index, match.index + match[0].length).trim());
  }
  return [...options].map(([key, text]) => ({ key, text }));
}

/** A menu key must actually have been offered. Longer entries can be account numbers, PINs or other requested data. */
export function menuKeyError(state: string | null, transcript: string, digits: string): string | null {
  if (state !== 'menu' || !/^[0-9*#]$/.test(digits)) return null;
  const offered = menuOptions(transcript);
  return offered.some(option => option.key === digits) ? null
    : `phone_menu_key_not_offered: ${digits} was not offered by the current menu. ${offered.length ? `Offered keys: ${offered.map(option => option.key).join(', ')}.` : 'No keypad options were offered; answer the spoken prompt instead.'}`;
}
