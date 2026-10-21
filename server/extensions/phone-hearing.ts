// Mishearing on a call. GPT Live answers the words it heard even when they make no sense in the conversation. On call
// 488e7d78 (2026-10-19) the person cut in while Kenan gave the offer address ("…à l'adresse offres"), Kenan heard
// "Quelle heure maintenant" and gave the time, the person asked the same thing again, got the same answer, and hung up.
// The phone prompt says how to handle this, but GPT Live does not apply it on its own, so the bridge watches both of its
// transcripts and tells it when the person cut in on an unfinished sentence and when they ask again what it just
// answered. Times are GPT Live's session timeline (the deltas' start_ms/end_ms), so the order of arrival, which
// interleaves the two transcripts, does not matter.

/** Person deltas this close together are one utterance. */
const UTTERANCE_GAP_MS = 1200;
/** Kenan's words ending this close before the person started, unfinished, were cut off. */
const CUT_IN_MS = 1500;
/** Transcript timing jitter: Kenan's words ending this soon after the person started were still said before them. */
const OVERLAP_MS = 300;
/** Longer utterances are recordings and menus replaying, not a person asking again. */
const REPEAT_MAX_WORDS = 12;
const REPEAT_SIMILARITY = 0.6;
const REPEAT_CONTAINED = 0.75;
const TAIL_WORDS = 12;
// A recording says the same thing again whatever Kenan said in between: the NRC talking clock (call 9d89b14a, 2026-10-19)
// repeats "NRC Eastern Daylight Time, nineteen hours twenty-six minutes and ten seconds" every 10 s with only the numbers
// changed, was cued as a person asking again, and GPT Live apologised in French over it. A repetition with only its
// numbers changed, or one this long word for word, is a recording; its later replays and cut-ins get no cue either.
const RECORDING_VERBATIM_WORDS = 8;
/** An earlier utterance this long is compared only once its repetition is about as long, so the numbers are heard. */
const DEFER_WORDS = 6;
const SAME_TEMPLATE = 0.85;
const NUMBER_WORDS = new Set('zero oh one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand un une deux trois quatre cinq sept huit neuf dix onze douze treize quatorze quinze seize vingt vingts trente quarante cinquante soixante cent cents mille'.split(' '));
const ACKNOWLEDGEMENTS = new Set('oui ouais ouin ok okay correct parfait daccord accord mm mhm hum hmm bon bien merci yes yeah yep sure right alright allo hello bonjour'.split(' '));

export type HearingCue = { kind: 'cut-off'; said: string } | { kind: 'repeat'; asked: string; answered: string; cutOff: string | null };
export type Timed = { delta: string; startMs: number; endMs: number };

const words = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const isNumber = (word: string) => /^\d+\p{L}{0,2}$/u.test(word) || NUMBER_WORDS.has(word);
/** The words with each run of numbers as one placeholder, so "ten seconds" and "twenty-six seconds" read alike. */
const template = (all: string[]) => all.map(w => isNumber(w) ? '#' : w).filter((w, i, t) => w !== '#' || t[i - 1] !== '#');
const numbers = (all: string[]) => all.filter(isNumber).join(' ');
function common(a: string[], b: string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const next = [0];
    for (let j = 0; j < b.length; j++) next.push(x === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!));
    row = next;
  }
  return row[b.length]!;
}
const alike = (a: string[], b: string[]) => a.length + b.length > 0 && 2 * common(a, b) / (a.length + b.length) >= SAME_TEMPLATE;
const tail = (text: string) => { const all = text.trim().split(/\s+/); return (all.length > TAIL_WORDS ? '…' : '') + all.slice(-TAIL_WORDS).join(' '); };
const finished = (text: string) => /[.!?…»"]\s*$/.test(text.trim());
const acknowledgement = (text: string) => words(text).every(w => ACKNOWLEDGEMENTS.has(w));
/** Whether `asked` repeats `earlier`: mostly the same words, or all but a little of `asked` inside an earlier utterance
 *  that ran on into it (a yes and the question in one breath). */
function repeats(asked: string[], earlier: string[]): boolean {
  const left = new Set(asked), right = new Set(earlier);
  const shared = [...left].filter(w => right.has(w)).length;
  return shared / (left.size + right.size - shared) >= REPEAT_SIMILARITY || (left.size >= 3 && shared / left.size >= REPEAT_CONTAINED);
}

type Utterance = { text: string; startMs: number; endMs: number; cued: boolean };

/** Watches GPT Live's transcripts of one call and returns at most one cue per utterance of the person. */
export class HearingWatch {
  private readonly kenanSaid: Timed[] = [];
  private current: Utterance | null = null;
  private previous: Utterance | null = null;
  private lastCut: string | null = null;
  /** Templates of what the line has played as a recording. */
  private readonly recordings: string[][] = [];

  kenan(said: Timed): void {
    this.kenanSaid.push(said);
    if (this.kenanSaid.length > 400) this.kenanSaid.splice(0, 200);
  }

  person(heard: Timed): HearingCue | null {
    const current = this.current;
    if (current && heard.startMs - current.endMs <= UTTERANCE_GAP_MS) {
      current.text += heard.delta;
      current.endMs = Math.max(current.endMs, heard.endMs);
    } else {
      if (current && !acknowledgement(current.text)) this.previous = current;
      this.current = { text: heard.delta, startMs: heard.startMs, endMs: heard.endMs, cued: false };
    }
    const utterance = this.current!;
    if (utterance.cued || acknowledgement(utterance.text) || this.replay(utterance) !== 'no') return null;
    const cue = this.repeat(utterance) ?? this.cutOff(utterance);
    if (cue) utterance.cued = true;
    if (cue?.kind === 'cut-off') this.lastCut = cue.said;
    return cue;
  }

  /** `replay`: the utterance so far replays a recording; `maybe`: it starts like the previous long utterance, so wait
   *  until it is as long before deciding; `no`: a person may be speaking. */
  private replay(utterance: Utterance): 'replay' | 'maybe' | 'no' {
    const asked = words(utterance.text), heard = template(asked);
    if (this.recordings.some(recording => alike(heard, recording.slice(0, heard.length)))) return 'replay';
    const earlier = this.previous ? words(this.previous.text) : [], played = template(earlier);
    if (played.length < 2 || !alike(heard, played.slice(0, heard.length))) return 'no';
    if (heard.length < played.length) return played.length >= DEFER_WORDS ? 'maybe' : 'no';
    if (!alike(heard, played) || (numbers(asked) === numbers(earlier) && played.length < RECORDING_VERBATIM_WORDS)) return 'no';
    this.recordings.push(played);
    return 'replay';
  }

  private repeat(utterance: Utterance): HearingCue | null {
    const before = this.previous;
    if (!before) return null;
    const answered = this.kenanSaid.filter(k => k.startMs >= before.startMs && k.endMs <= utterance.startMs + OVERLAP_MS).map(k => k.delta).join('');
    const asked = words(utterance.text), earlier = words(before.text);
    if (!answered.trim() || asked.length < Math.min(earlier.length, 3) || earlier.length < 2 || asked.length > REPEAT_MAX_WORDS || earlier.length > REPEAT_MAX_WORDS) return null;
    if (!repeats(asked, earlier)) return null;
    return { kind: 'repeat', asked: utterance.text.trim(), answered: tail(answered), cutOff: this.lastCut };
  }

  private cutOff(utterance: Utterance): HearingCue | null {
    const before = this.kenanSaid.filter(k => k.endMs <= utterance.startMs + OVERLAP_MS);
    const last = before.at(-1);
    if (!last || utterance.startMs - last.endMs > CUT_IN_MS) return null;
    const said = before.map(k => k.delta).join('');
    return finished(said) ? null : { kind: 'cut-off', said: tail(said) };
  }
}

/** What GPT Live is told for each cue. */
export function hearingNote(cue: HearingCue): string {
  if (cue.kind === 'cut-off') return `The person cut in while you were saying "${cue.said}", so they may not have heard the end of it. Unless their words clearly ask for something else, say that part again, slowly. If what you heard from them does not fit the conversation, check what they mean instead of answering the words.`;
  return `The person asked again what you just answered ("${cue.asked}"; you answered "${cue.answered}"). You probably misheard them, or your answer missed. Do not give the same answer again: ${cue.cutOff ? `they had cut in while you were saying "${cue.cutOff}", so they most likely want that; say it again slowly, or ` : ''}say what else they may mean and ask them.`;
}

/** After Kenan's goodbye, whether the bridge may hang up. GPT Live's transcript runs ahead of its audio, so both sides
 *  must be quiet on the transcript and Kenan's voice must have stopped reaching the phone; a reply the call agent is still
 *  writing holds the line (call 714bd84f: the answer to Alice's last question came after both goodbyes and was cut off),
 *  for at most REPLY_HOLD_MS after the goodbye. */
export const GOODBYE_QUIET_MS = 3500, VOICE_QUIET_MS = 1200, REPLY_HOLD_MS = 20_000;
/** After a goodbye, this long with no words from either side ends the call whatever the audio does: on call 9cbb9e63
 *  (2026-10-21, Dave's Kenan calling Kenan) GPT Live's stream carried full-size frames for 527 s after both goodbyes,
 *  so the voice test never passed and the line stayed open until the other side dropped. */
export const GOODBYE_CAP_MS = 15_000;
export type HangUp = { kind: 'wait' } | { kind: 'hold'; pendingReplies: number } | { kind: 'end'; unanswered: number };
export function goodbyeHangUp(s: { now: number; goodbyeAt: number; lastSpeech: number; lastKenanVoice: number; pendingReplies: number }): HangUp {
  if (s.now - Math.max(s.lastSpeech, s.goodbyeAt) > GOODBYE_CAP_MS) return { kind: 'end', unanswered: s.pendingReplies };
  if (s.now - s.lastSpeech <= GOODBYE_QUIET_MS || s.now - s.lastKenanVoice <= VOICE_QUIET_MS) return { kind: 'wait' };
  if (s.pendingReplies > 0 && s.now - s.goodbyeAt <= REPLY_HOLD_MS) return { kind: 'hold', pendingReplies: s.pendingReplies };
  return { kind: 'end', unanswered: s.pendingReplies };
}
