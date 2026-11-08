// Hold and hand over (goal da7254ac, 2026-10-25): Kenan dials, gets through the menus and waits on hold, and the person
// it assists joins the call the moment a person picks up, so they spend minutes on a call instead of the whole hold.
// JMP's SIP account carries one outbound call at a time (a second concurrent INVITE is answered and cleared 4 s later),
// so Kenan cannot ring the owner while it holds the call. Instead the owner is alerted (an urgent push) and calls Kenan's
// line from their own phone; the answering channel moves that inbound channel into this call's bridge. The owner may also
// call in early and wait on hold with Kenan. Once both a person and the owner are on the line, GPT Live introduces them in
// a sentence or two and leaves the call; the two talk directly through Asterisk's bridge until one hangs up.
// What GPT Live learns here are facts it could not hear for itself (the owner is being alerted, has joined, dropped off),
// added with session.thinking.append; the prompt's HANDOFF_RULE says what it does about them, and it decides when to
// speak. The bridge decides only when GPT Live leaves the call.
// Pure and clocked by the caller, like phone-ivr.ts.

/** The owner is asked to call in; if they have not joined this long after a person picked up, GPT Live learns they can't come. */
export const OWNER_WAIT_MS = 120_000;
/** After the owner and a person are both on the line, Kenan leaves once its voice has been quiet this long after speaking… */
export const INTRO_QUIET_MS = 1_500;
/** Speech that starts this soon after the owner joined is the sentence GPT was already saying, resuming after a pause:
 *  GPT Live takes longer than this to react to a new fact (test call 9ebcae16 left on such a pause, before the
 *  introduction). */
export const INTRO_REACTION_MS = 700;
/** …or this long after that, whatever it is doing. */
export const INTRO_CAP_MS = 20_000;
/** Once the owner has the call, it lasts at most this long. */
export const HANDED_OVER_MAX_MS = 4 * 3600_000;

export type HandoffStep =
  | { kind: 'call-owner' }                       // a person is waiting: alert the owner and keep the person on the line
  | { kind: 'fact'; content: string; note: string }       // added to GPT Live's context (session.thinking.append)
  | { kind: 'leave' };                           // the introduction is done: Kenan leaves the call

const WHO = 'the person you assist (by the name the brief gives them)';
export const HANDOFF_RULE = `Handover: on this call ${WHO} takes over from you once a person answers. They are alerted the moment a person picks up and join the call themselves within a minute or two, often sooner. Your part is to get through the menus and the hold queue, then keep the person on the line: say in one sentence what the call is about, say that ${WHO} is joining the call in a moment, and ask them to hold briefly. While you wait, answer simple questions from the brief, but leave the business itself to ${WHO}. When you learn they have joined and a person is on the line, introduce them to each other in one or two short sentences (for example "Okay, Alice's on the line now. Alice, this is Mike at reservations, about your baggage question.") and then stop talking: you leave the call and they carry on without you. If they can't come in time, tell the person politely and ask how ${WHO} can reach them directly (a direct number or extension, a case or reference number, their hours).`;

const PICKED_UP = (heard: string) => `Fact about the call: a person has picked up (they said: "${heard.slice(-160)}"). ${WHO} has been alerted and is joining in a moment.`;
const PICKED_UP_OWNER_HERE = (heard: string) => `Fact about the call: a person has picked up (they said: "${heard.slice(-160)}"), and ${WHO} is already on the line, listening.`;
const PERSON_ON_LINE = `Fact about the call: a person is on the line. ${WHO} has been alerted and is joining in a moment.`;
const OWNER_JOINED = `Fact about the call: ${WHO} has just joined the call and hears you both.`;
const OWNER_ON_HOLD = `Fact about the call: ${WHO} has joined the call and is waiting on hold with you; no person has picked up yet.`;
const OWNER_MISSED = `Fact about the call: ${WHO} can't come to the phone right now.`;
const OWNER_DROPPED = `Fact about the call: ${WHO} dropped off the call before you left it, and may call back in.`;

/** The handover's state for one call. `person`: a person is on the line now (the line is talking). */
export class Handoff {
  private ownerPresent = false;
  private person = false;
  private askedAt: number | null = null;
  private missed = false;
  private introducing: { since: number; spokeAt: number | null } | null = null;
  private lastVoiceMs = 0;
  private done = false;

  get handedOver(): boolean { return this.done; }
  get ownerOnLine(): boolean { return this.ownerPresent; }
  /** The owner has been asked to call in and has not joined yet: the person is holding for them, so a quiet line is not an
   *  unanswered message. */
  get waitingForOwner(): boolean { return this.askedAt !== null && !this.ownerPresent && !this.missed && !this.done; }

  /** The line's state changed: `talking` means a person is on it; `heard` is what they said. */
  line(nowMs: number, talking: boolean, picked: boolean, heard: string): HandoffStep[] {
    if (this.done) return [];
    const was = this.person;
    this.person = talking;
    if (!talking || was) return [];
    if (this.ownerPresent) return this.introduce(nowMs, { kind: 'fact', content: PICKED_UP_OWNER_HERE(heard), note: 'a person picked up; the person Kenan assists is already on the line' });
    if (this.askedAt !== null) return [];
    this.askedAt = nowMs;
    return [{ kind: 'call-owner' }, picked
      ? { kind: 'fact', content: PICKED_UP(heard), note: 'a person picked up: the person Kenan assists is alerted to call in' }
      : { kind: 'fact', content: PERSON_ON_LINE, note: 'a person is on the line: the person Kenan assists is alerted to call in' }];
  }

  /** The owner's own phone joined the call's bridge. */
  ownerJoined(nowMs: number): HandoffStep[] {
    if (this.done || this.ownerPresent) return [];
    this.ownerPresent = true;
    if (this.person) return this.introduce(nowMs, { kind: 'fact', content: OWNER_JOINED, note: 'the person Kenan assists joined the call' });
    return [{ kind: 'fact', content: OWNER_ON_HOLD, note: 'the person Kenan assists joined the call and waits on hold with Kenan' }];
  }

  /** The owner's phone left before Kenan handed over. */
  ownerLeft(): HandoffStep[] {
    if (this.done || !this.ownerPresent) return [];
    this.ownerPresent = false; this.introducing = null;
    return [{ kind: 'fact', content: OWNER_DROPPED, note: 'the person Kenan assists dropped off before the handover' }];
  }

  /** Kenan's voice went out to the line at `nowMs`. Only speech that starts after the owner joined counts as the
   *  introduction: a sentence already under way then is not it. */
  kenanVoice(nowMs: number): void {
    const intro = this.introducing;
    if (intro && nowMs >= intro.since + INTRO_REACTION_MS && (intro.spokeAt !== null || nowMs - this.lastVoiceMs > 500)) intro.spokeAt = nowMs;
    this.lastVoiceMs = nowMs;
  }

  tick(nowMs: number): HandoffStep[] {
    if (this.done) return [];
    const intro = this.introducing;
    if (intro && ((intro.spokeAt !== null && nowMs - intro.spokeAt >= INTRO_QUIET_MS) || nowMs - intro.since >= INTRO_CAP_MS)) {
      this.done = true;
      return [{ kind: 'leave' }];
    }
    if (this.askedAt !== null && !this.ownerPresent && !this.missed && this.person && nowMs - this.askedAt >= OWNER_WAIT_MS) {
      this.missed = true;
      return [{ kind: 'fact', content: OWNER_MISSED, note: `the person Kenan assists had not joined ${OWNER_WAIT_MS / 1000} s after a person picked up` }];
    }
    return [];
  }

  private introduce(nowMs: number, cue: HandoffStep): HandoffStep[] {
    this.introducing = { since: nowMs, spokeAt: null };
    return [cue];
  }
}
