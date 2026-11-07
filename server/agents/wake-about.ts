// "Only messages about X" for Signal and text wakes (2026-11-02: a held wake on Signal from Frank fired on "morp" and on a
// bare paper link). A wake with `about` fires only on a message that matches its sender/query AND that a small model
// says is about it. Judging never blocks the wake tick: an unjudged message starts one model call and counts as not yet
// matching; the verdict lands in memory and the next tick (asked for at once) uses it. A message the model can't judge
// after JUDGE_ATTEMPTS fires the wake: a missed reply costs more than a stray one.
import type { PersonConfig } from '../config.js';
import { channelSetup } from '../channels/settings.js';

export const JUDGE_ATTEMPTS = 3;
const TEXT_CHARS = 2000;

/** The Haiku model the person's message watcher uses, which also judges `about`; null when they have no watcher. */
export function aboutModel(person: Pick<PersonConfig, 'id' | 'extensions' | 'signalStore' | 'extensionConfigPath' | 'channels'>): string | null {
  try { const setup = channelSetup(person); return setup.kind === 'configured' ? setup.filter.model : null; } catch { return null; }
}

export function aboutPrompt(about: string, from: string, text: string): string {
  return [
    `An assistant is waiting for a particular message. It wants: ${about}`,
    `A new message arrived from ${from}:`, `"""`, text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text, `"""`,
    'Is this message what it is waiting for? Small talk, reactions, jokes and links with nothing on that subject are not. Reply with exactly one word: yes or no.',
  ].join('\n');
}

/** The model's one-word answer, or null when it gave neither. */
export function parseAbout(reply: string): boolean | null {
  const word = /\b(yes|no)\b/i.exec(reply)?.[1]?.toLowerCase();
  return word === 'yes' ? true : word === 'no' ? false : null;
}

export type Ask = (prompt: string) => Promise<string>;

/** Verdicts by wake and message, kept in memory while the wake is pending. */
export class AboutJudge {
  private verdicts = new Map<string, boolean>();
  private failures = new Map<string, number>();
  private asking = new Set<string>();
  constructor(private readonly ask: (personId: string) => Ask | null, private readonly judged: () => void, private readonly log: (text: string) => void) {}

  /** true or false once judged; null while the model call is under way (started here on first sight). */
  verdict(personId: string, wakeId: string, about: string, message: { key: string; from: string; text: string }): boolean | null {
    const key = `${wakeId}|${message.key}`;
    const known = this.verdicts.get(key);
    if (known !== undefined) return known;
    if (this.asking.has(key)) return null;
    const ask = this.ask(personId);
    if (!ask) return true;
    this.asking.add(key);
    void ask(aboutPrompt(about, message.from, message.text)).then(parseAbout, (e: unknown) => { this.log(`about judge: ${e}`); return null; }).then(answer => {
      this.asking.delete(key);
      if (answer === null) {
        const failed = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, failed);
        if (failed < JUDGE_ATTEMPTS) { this.judged(); return; }
        this.log(`about judge: no verdict after ${failed} attempts for wake ${wakeId}; firing it`);
        answer = true;
      }
      this.failures.delete(key);
      this.verdicts.set(key, answer);
      this.judged();
    });
    return null;
  }

  /** Forgets verdicts of wakes no longer pending. */
  keepOnly(pending: ReadonlySet<string>): void {
    for (const map of [this.verdicts, this.failures]) for (const key of map.keys()) if (!pending.has(key.slice(0, key.indexOf('|')))) map.delete(key);
  }
}
