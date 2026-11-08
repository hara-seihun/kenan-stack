// Exact spoken commands for what Kenan is presenting ("next slide", "Kenan, go to slide 3", "stop sharing"), matched
// deterministically from GPT Live's input transcript, like the leave matcher in meeting-consent.ts. They move the slide
// or stop the share at once instead of waiting for a delegation to the meeting agent.
//
// GPT LIVE HAS NO TURNS (see the top of meeting-voice.ts). This module never decides whether or when the voice speaks: it
// only recognises a command addressed to Kenan, or a bare imperative command, and the runtime carries it out and tells the
// voice what the system did, as context.
import { addressed } from './meeting-consent.js';

export type ScreenCommand =
  | { kind: 'slide'; to: 'next' | 'previous' | 'first' | 'last' | number }
  | { kind: 'stop' };

/** A stable key for a command, for deduplication and logs: "slide:next", "slide:3", "stop". */
export const commandKey = (command: ScreenCommand) => command.kind === 'stop' ? 'stop' : `slide:${command.to}`;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NUMBER = String.raw`(\d{1,2}|${NUMBER_WORDS.slice(1).join('|')})`;
/** Words that may come before a command without changing it: "please next slide", "can you go back", "you can stop sharing". */
const LEAD = String.raw`(?:(?:ok|okay|alright|all right|so|and|now|please|kindly|can you|could you|would you|will you|you can|you could|you|go ahead and|let's|lets)\s+)*`;
/** Words that may follow a command without changing it: "next slide please", "stop sharing now, thanks". */
const TAIL = String.raw`(?:\s+(?:please|now|thanks|thank you|for me|for us|again))*`;
const SLIDE_WORD = String.raw`(?:slide|page)`;
/** Each command, matched against a whole clause (after the address and lead words). */
const COMMANDS: { re: RegExp; command: (m: RegExpExecArray) => ScreenCommand; addressedOnly?: boolean }[] = [
  { re: new RegExp(String.raw`^(?:(?:go|move|skip|advance|jump)\s+(?:on\s+)?(?:to\s+)?)?(?:the\s+)?next\s+${SLIDE_WORD}$`), command: () => ({ kind: 'slide', to: 'next' }) },
  { re: new RegExp(String.raw`^(?:(?:go|move|jump)\s+(?:back\s+)?(?:to\s+)?)?(?:the\s+)?previous\s+${SLIDE_WORD}$`), command: () => ({ kind: 'slide', to: 'previous' }) },
  { re: new RegExp(String.raw`^(?:go\s+back(?:\s+(?:one|a)\s+${SLIDE_WORD})?|back\s+(?:one|a)\s+${SLIDE_WORD})$`), command: () => ({ kind: 'slide', to: 'previous' }) },
  { re: new RegExp(String.raw`^(?:(?:go|move|jump|skip)\s+(?:back\s+)?(?:to\s+)?)?(?:the\s+)?first\s+${SLIDE_WORD}$`), command: () => ({ kind: 'slide', to: 'first' }) },
  { re: new RegExp(String.raw`^(?:(?:go|move|jump|skip)\s+(?:on\s+)?(?:to\s+)?)?(?:the\s+)?(?:last|final)\s+${SLIDE_WORD}$`), command: () => ({ kind: 'slide', to: 'last' }) },
  { re: new RegExp(String.raw`^(?:(?:go|move|jump|skip|switch|back)\s+(?:back\s+)?to\s+|show\s+(?:us\s+|me\s+)?)${SLIDE_WORD}\s+(?:number\s+)?${NUMBER}$`), command: m => ({ kind: 'slide', to: toNumber(m[1]!) }) },
  // "Kenan, next": the input transcript stopped after "next" once the voice began answering (November 6, 2026). Only
  // when addressed to Kenan by name, and only while a deck is up (the caller checks).
  { re: /^next(?:\s+one)?$/, command: () => ({ kind: 'slide', to: 'next' }), addressedOnly: true },
  // "(the|your)" alone: the input transcript stopped at "stop sharing your" once the voice began answering.
  { re: /^stop\s+(?:sharing|presenting|the\s+share|the\s+presentation|screen\s*sharing)(?:\s+(?:the|your)(?:\s+screen)?)?$/, command: () => ({ kind: 'stop' }) },
];
const toNumber = (word: string) => /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word);

/** One clause as plain lower-case words: curly apostrophes straightened, punctuation except apostrophes removed. */
const words = (clause: string) => clause.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9'\s-]+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

/** A whole clause that is one command, give or take lead and tail words, or null. */
function command(clause: string, addressedToKenan = false): ScreenCommand | null {
  const body = new RegExp(String.raw`^${LEAD}(.+?)${TAIL}$`).exec(clause)?.[1];
  if (!body) return null;
  for (const c of COMMANDS) { if (c.addressedOnly && !addressedToKenan) continue; const m = c.re.exec(body); if (m) return c.command(m); }
  return null;
}

/**
 * The presenting command in an utterance, or null. It fires only for a clause that is entirely one command, either
 * addressed to Kenan ("Kenan, next slide", "next slide, Kenan", "hey Kenan, can you go to slide three") or a bare
 * imperative of at most six words that starts with the command ("next slide", "next slide please", "stop sharing").
 * "The next slide should cover pricing", "Rivka, next slide", "don't stop sharing yet" and "Kenan, what's on the next
 * slide?" are not commands. At most one command per utterance: the first.
 */
export function matchScreenCommand(text: string, wakeNames: string[]): ScreenCommand | null {
  const names = [...new Set(['kenan', ...wakeNames.map(n => n.toLowerCase().replace(/[^a-z]/g, ''))].filter(Boolean))];
  const name = String.raw`(?:${names.join('|')})`;
  const greeting = String.raw`(?:(?:hey|hi|ok|okay|so|um|uh|yo|well|oh|alright)\s+)*`;
  for (const raw of text.split(/[.!?;\n]+/)) {
    if (!raw.trim()) continue;
    const clause = words(raw);
    if (!clause) continue;
    // Addressed: the name first ("Kenan, next slide") or last ("next slide, Kenan"); the rest must be the command.
    if (addressed(raw, wakeNames)) {
      const first = new RegExp(String.raw`^${greeting}${name}\s+(.+)$`).exec(clause)?.[1];
      const last = new RegExp(String.raw`^(.+?)\s+${name}$`).exec(clause)?.[1];
      const found = (first && command(first, true)) || (last && command(last, true));
      if (found) return found;
      continue;
    }
    // Bare: a short imperative that starts with the command itself (lead words such as "please" allowed).
    if (clause.split(' ').length > 6) continue;
    const found = command(clause);
    if (found) return found;
  }
  return null;
}

/** How long an identical command is ignored after it fired (the transcript repeating itself, or someone saying it twice). */
export const COMMAND_DEDUPE_MS = 2_500;
/** One command per utterance, and an identical command within COMMAND_DEDUPE_MS of the last one is a repeat. */
export class CommandDedupe {
  private last: { key: string; at: number } | null = null;
  /** Whether this command should run now; records it when it does. */
  admit(command: ScreenCommand, now: number): boolean {
    const key = commandKey(command);
    if (this.last && this.last.key === key && now - this.last.at < COMMAND_DEDUPE_MS) return false;
    this.last = { key, at: now };
    return true;
  }
}
