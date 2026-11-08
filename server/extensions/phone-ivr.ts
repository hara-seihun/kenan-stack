// Automated lines on phone calls: phone menus, recorded announcements and hold queues. GPT Live hears these as a
// person and talks over them. On call a757ee0f (2026-10-23, the Toronto school-tax office) Kenan's opening ran into the
// menu, the bridge's hearing watch took each menu sentence for the person cutting in, told GPT to say the cut-off part
// again, and Kenan repeated the property's roll number eight times over the menu; no key was pressed, so the call only
// reached the agent queue because the menu fell through.
// The bridge reads the line's transcript: once it shows menu or queue wording, the line is automated until a person
// answers (a greeting, a name, an offer to help); a system asking for a spoken answer ("dites-le maintenant") is noted
// too. Its states are what the server shows as the call's live state and what the bridge adds to GPT Live's context as
// facts (session.thinking.append). The bridge never mutes GPT Live or decides when it speaks: GPT Live hears the line and
// chooses for itself (GPT Live has no turns; see the top of phone-bridge.ts).
// On call cb5973e8 (2026-10-23, Toronto 311) the first word of the welcome ("Bienvenue") and later a recorded sentence
// between two prompts ("Nos équipes demeurent disponibles pour vous accompagner. Si vous") were each taken for a person
// picking up: an utterance's end was measured on GPT Live's audio timeline against the wall clock, so every utterance was
// judged at the next check, a few words in, and the unanswered-message rule then hung up while the menu processed. Utterances now end on the wall
// clock; after a menu only a greeting, a question or a person's own wording is a person; words judged a person on their
// own are re-read until the line's next utterance, so recorded wording makes the line a system again; and a prompt
// for a spoken answer is a menu whatever the state, answered with only the short item it asks for.
// Pure and clocked by the caller, so a scripted line drives it exactly as a live call does.

import { MENU_SPEECH_RULE } from './phone-menu.js';

export type LineState = 'dialling' | 'connected' | 'menu' | 'hold' | 'talking' | 'voicemail';
/** The call's live state as agents see it: the line's state, or on a handoff call (phone-handoff.ts) `joining` (a person
 *  is holding while the owner is asked to call in) and `handed-over` (Kenan has left; the owner has the call). */
export const CALL_STATES = ['dialling', 'connected', 'menu', 'hold', 'talking', 'joining', 'handed-over', 'voicemail'] as const;
export type CallState = typeof CALL_STATES[number];

const MENU = /(?:faites|fa[iî]tes|appuyez|tapez|composez|signalez|press|dial|enter|select|oprima|marque|presione)\s*(?:-?le |sur |la touche |le |the |key )*(?:\d|[*#]|un|deux|trois|quatre|cinq|six|sept|huit|neuf|z[ée]ro|[ée]toile|carr[ée]|di[eè]se|one|two|three|four|five|six|seven|eight|nine|zero|star|pound|uno|dos|tres|cuatro|cinco|siete|ocho|nueve|cero)(?![\p{L}\d])|options? du menu|menu options|main menu|menu principal/iu;
const RECORDING = /(?:cet |this |votre |your )?appel (?:sera|peut [eê]tre|est) enregistr|call (?:may|will) be (?:recorded|monitored)|fins? de (?:contr[oô]le de )?qualit|quality (?:assurance|and training|purposes)|bienvenue (?:au|à|chez|a)(?![\p{L}])|welcome to\b|thank you for calling|merci d'avoir appel|nos heures d'ouverture|our (?:office )?hours|site (?:web|internet)|website|www\.|point (?:ca|com)|dot (?:ca|com)|robot de clavardage|renseignements personnels|personal information|si vous connaissez|if you know (?:the|your)/iu;
const QUEUE = /patienter|restez en ligne|rester en ligne|temps d'attente|attente (?:estim|pr[ée]vu)|prochain(?:e)? (?:agent|pr[ée]pos[ée]|conseill|repr[ée]sentant)|disponible sous peu|tous nos (?:agents|pr[ée]pos[ée]s|conseillers|repr[ée]sentants)|votre appel est important|priorit[ée] d'appel|en file|please (?:hold|stay on the line|continue to hold|remain on the line)|stay on the line|next available|wait time|your call is important|all (?:of )?our (?:agents|representatives|staff)|in (?:the )?queue|being transferred|transf[ée]r(?:er|é|ons) votre appel|transferring your call|transfer you|connect you (?:to|with)|connecting you/i;
// What only a person says when they pick up a queue: their name, an offer to help, "speaking".
const PERSON = /[àa] l'appareil|(?:je peux|puis-je|est-ce que je peux|comment (?:je )?(?:peux|puis)[- ]je|que puis-je) (?:vous )?aider|how (?:can|may) i (?:help|assist)|what can i do for you|speaking[.,!?]|(?:my name is|je m'appelle|mon nom est|ici) [\p{L}]+|vous parlez (?:à|avec)|you(?:'re| are) speaking (?:to|with)/iu;
// A person introducing themself by name: "This is Rhee from Alaska Airlines", "my name is Dana, how can I help". It means a
// person has taken over from a voice bot: on test call 9ebcae16 the agent's "Good afternoon. This is Rhee from Alaska Airlines" came in
// one breath with the bot's transfer words and was only taken for a person when she said hello again.
const INTRODUCTION = /\b(?:[Tt]his is|[Mm]y name is|[Jj]e m'appelle|[Ii]ci|[Cc]'est) [\p{Lu}][\p{L}'-]+(?: [\p{Lu}][\p{L}'-]+)?(?:,? (?:from|with|at|de|chez|speaking|à l'appareil)\b|[,.]? (?:how|may|what|can|comment|puis|que)\b)/u;
// A system asking for a spoken answer: GPT may say it.
const SPEECH_PROMPT = /\bdites\b|vous pouvez (?:le |la |les )?(?:dire|nommer)|(?:veuillez|pouvez-vous) (?:dire|nommer|[ée]noncer)|en quelques mots|\bsay\b|tell (?:me|us) (?:in a few words|briefly|the reason|what|why|which)|in a few words|briefly (?:tell|describe)|(?:please )?(?:state|speak) (?:your|the)|please state/i;
// Queue wording only a recording uses; a person saying "un instant" or "please hold" is still a person.
const QUEUE_RECORDED = /temps d'attente|attente (?:estim|pr[ée]vu)|prochain(?:e)? (?:agent|pr[ée]pos[ée]|conseill|repr[ée]sentant) disponible|tous nos (?:agents|pr[ée]pos[ée]s|conseillers|repr[ée]sentants)|votre appel est important|priorit[ée] d'appel|next available|estimated wait|your call is important|all (?:of )?our (?:agents|representatives)/i;
// Recorded app advertisements can replace a person after a transfer, including on inbound callbacks.
const HOLD_ADVERTISEMENT = /\bdownload (?:the|our) [^.!?]{0,70}\bapp (?:today|from)\b|\bmanage prescription refills and check (?:your )?order status\b/i;
const GREETING = /(?:^|[^\p{L}])(?:oui|allo|allô|bonjour|bonsoir|hello|hi|hey|yes|good (?:morning|afternoon|evening))(?![\p{L}])/iu;
const MUSIC = /^[\s♪♫()[\].,-]*(?:music|musique)?[\s♪♫()[\].,-]*$/i;
// A conversational voice bot ("you're speaking with the virtual assistant for Alaska Airlines… How can I help you today?",
// 2026-10-25, call 4b1119c6) asks questions the way a person does. Once the line has said it is a virtual or automated
// assistant, its questions are prompts for a spoken answer, not a person picking up, and Kenan may answer it, until the
// line goes quiet for a transfer (BOT_TRANSFER_GAP_MS): then the next greeting is a person again. Its own queue wording
// ("before I connect you with an agent, could I get your name?") does not end it.
const BOT = /virtual (?:assistant|agent)|automated (?:assistant|agent|attendant|system)|digital assistant|\bAI (?:assistant|agent)|assistante? virtuel|agent virtuel|assistante? num[ée]rique|asistente virtual/iu;
export const BOT_TRANSFER_GAP_MS = 8_000;
/** After a menu or queue, an utterance this short with nothing automated about it is a person picking up. */
const PERSON_MAX_WORDS = 14;
/** Line deltas this close together are one utterance. */
const UTTERANCE_GAP_MS = 1200;

export type Timed = { delta: string; startMs: number; endMs: number };
export type LineChange = { state: LineState; why: string; heard: string };

const automatedText = (text: string) => MENU.test(text) || RECORDING.test(text) || QUEUE.test(text) || HOLD_ADVERTISEMENT.test(text);

export class AutomatedLine {
  private current: LineState;
  /** The line's current utterance: its words, where it ends on GPT Live's audio timeline (to join deltas), and when its
   *  last delta arrived on the wall clock (to know it has ended). */
  private utterance: { text: string; endMs: number; lastAtMs: number; judged: boolean; prompted: boolean } | null = null;
  /** Talking was inferred from words with nothing automated about them, not from a person's own wording: until the line's
   *  next utterance is judged, recorded wording makes the line a system again. */
  private unsure = false;
  private systemLast = false;
  /** Whether a menu or queue has been heard on this call: a short question or greeting after one is a person. */
  private wasAutomated = false;
  /** The line has said it is a voice bot, and has not gone quiet or played a queue since. */
  private bot = false;
  private lastWordsAtMs: number | null = null;

  constructor(initial: LineState = 'dialling') { this.current = initial; }

  get state(): LineState { return this.current; }
  /** Hearing cues are for people only: a recording repeating is not someone asking again or cutting in. */
  get automated(): boolean { return this.current === 'menu' || this.current === 'hold'; }

  /** The line picked up. */
  answered(): LineChange | null { return this.set('connected', 'answered', ''); }
  /** The line's latest words were a recording, a menu or a prompt for a spoken answer: a silence now is the system
   *  processing or waiting, never an unanswered message. */
  get systemSpokeLast(): boolean { return this.systemLast; }
  /** A mailbox is recording. */
  voicemail(): LineChange | null { this.systemLast = false; return this.set('voicemail', 'mailbox', ''); }
  /** A key was pressed on a menu. */
  pressed(): LineChange | null { this.systemLast = true; return this.set('menu', 'key pressed', ''); }

  /** GPT Live's transcript of the line. Returns the new state when this delta changes it. */
  line(heard: Timed, nowMs: number): LineChange | null {
    if (this.current === 'dialling') return null;
    // A menu may disprove a prior mailbox cue; voicemail is an observation, not an irreversible state.
    if (this.bot && this.lastWordsAtMs !== null && nowMs - this.lastWordsAtMs >= BOT_TRANSFER_GAP_MS) this.bot = false;
    this.lastWordsAtMs = nowMs;
    const u = this.utterance;
    if (u && heard.startMs - u.endMs <= UTTERANCE_GAP_MS) { u.text += heard.delta; u.endMs = Math.max(u.endMs, heard.endMs); u.lastAtMs = nowMs; }
    else this.utterance = { text: heard.delta, endMs: heard.endMs, lastAtMs: nowMs, judged: false, prompted: false };
    const text = this.utterance!.text.replace(/\s+/g, ' ').trim();
    if (!text || (this.current === 'voicemail' && !MENU.test(text))) return null;
    if (automatedText(text) || SPEECH_PROMPT.test(text) || BOT.test(text)) this.systemLast = true;
    if (BOT.test(text) && !this.bot) {
      this.bot = true; this.wasAutomated = true; this.unsure = false;
      return this.set(this.current === 'hold' ? 'hold' : 'menu', 'a voice bot', text) ?? { state: this.current, why: 'a voice bot', heard: text };
    }
    // A queue's own recordings ("your call is important", "next available agent") mean the bot has handed the call on.
    if (this.bot && QUEUE_RECORDED.test(text)) this.bot = false;
    // After a menu, queue or bot, an agent introducing themself by name is a person, whatever came before in the same breath.
    if (this.wasAutomated && this.current !== 'talking') {
      const said = text.split(/(?<=[.!?])\s+/).slice(-2).join(' ');
      if (INTRODUCTION.test(said) && !BOT.test(said) && !MENU.test(said)) { this.bot = false; this.unsure = false; this.systemLast = false; return this.set('talking', 'a person answered', said); }
    }
    if (HOLD_ADVERTISEMENT.test(text)) { this.wasAutomated = true; this.systemLast = true; this.unsure = false; return this.set('hold', 'queue announcement', text); }
    if (PERSON.test(text) && !MENU.test(text) && !this.bot) { this.unsure = false; this.systemLast = false; return this.set('talking', this.automated ? 'a person answered' : 'a person spoke', text); }
    // A person on the line becomes a system again only by wording no person uses: a menu's keys or a queue recording. Words only taken
    // for a person are re-read: a recording's wording or a prompt for a spoken answer makes the line a system again.
    if (this.current === 'talking') {
      const back = this.unsure && (SPEECH_PROMPT.test(text) || RECORDING.test(text) || QUEUE.test(text));
      if (back) this.unsure = false;
      if (back && SPEECH_PROMPT.test(text)) return this.speechPrompt(text);
      if (MENU.test(text) || (back && RECORDING.test(text))) { this.wasAutomated = true; return this.set('menu', MENU.test(text) ? 'menu options' : 'recorded announcement', text); }
      if (QUEUE_RECORDED.test(text) || back) { this.wasAutomated = true; return this.set('hold', 'queue announcement', text); }
      return null;
    }
    // A prompt opens GPT's window once; the rest of the same utterance must not close it again.
    if (SPEECH_PROMPT.test(text)) return this.speechPrompt(text);
    if (QUEUE.test(text)) { this.wasAutomated = true; return this.set('hold', 'queue announcement', text); }
    if (MENU.test(text) || RECORDING.test(text)) {
      this.wasAutomated = true; 
      return this.set(this.current === 'hold' ? 'hold' : 'menu', MENU.test(text) ? 'menu options' : 'recorded announcement', text);
    }
    return null;
  }

  /** The line's utterance has ended (no new words for a moment). A short greeting or question after a menu or queue,
   *  with no menu or recording wording, is a person; before any menu, words with nothing automated about them are too. */
  pause(nowMs: number): LineChange | null {
    const u = this.utterance;
    if (!u || u.judged || nowMs - u.lastAtMs <= UTTERANCE_GAP_MS) return null;
    u.judged = true;
    const text = u.text.replace(/\s+/g, ' ').trim();
    // A voice bot that ends on a question or a greeting ("How can I help you today?") is asking for a spoken answer.
    const last = text.split(/(?<=[.!?])\s+/).pop() ?? '';
    if (this.bot && last && !MENU.test(last) && (GREETING.test(last) || /\?\s*$/.test(last) || /\b(?:help|assist|aider|ayudar)\b/i.test(last))) return this.speechPrompt(text);
    if (!text || automatedText(text) || SPEECH_PROMPT.test(text) || this.bot) return null;
    if (this.current === 'talking') this.unsure = false;
    this.systemLast = false;
    const words = text.split(' ').length;
    if (MUSIC.test(text)) return null;
    if (this.current === 'connected') { this.unsure = true; return this.set('talking', 'a person spoke', text); }
    // A recorded sentence between two prompts is as short as a person's hello; only a greeting or a question is a person.
    if (this.automated && this.wasAutomated && words <= PERSON_MAX_WORDS && (GREETING.test(text) || /\?\s*$/.test(text))) {
      
      return this.set('talking', 'a person answered', text);
    }
    return null;
  }

  /** Once per utterance: GPT is told each time a prompt asks, even when the line is already known to be a menu. */
  private speechPrompt(text: string): LineChange | null {
    const u = this.utterance!;
    if (u.prompted) return null;
    u.prompted = true;
    this.wasAutomated = true;
    return this.set(this.current === 'hold' ? 'hold' : 'menu', 'the system asks for a spoken answer', text) ?? { state: this.current, why: 'the system asks for a spoken answer', heard: text };
  }

  private set(state: LineState, why: string, heard: string): LineChange | null {
    if (state === this.current) return null;
    this.current = state;
    return { state, why, heard };
  }
}

/** What GPT Live is told when the line changes: facts about the line, added with session.thinking.append. GPT Live hears
 *  the line itself and decides what to say and when; the phone prompt says how to treat menus, queues and bots. */
export function lineNote(change: LineChange): string | null {
  if (change.why === 'the system asks for a spoken answer') return `Fact about the line: a recording, not a person, is asking for a spoken answer ("${change.heard.slice(-200)}"). ${MENU_SPEECH_RULE}`;
  if (change.why === 'a voice bot') return `Fact about the line: this is an automated voice assistant (a bot), not a person. ${MENU_SPEECH_RULE}`;
  if (change.state === 'menu') return 'Fact about the line: this is an automated phone system (recorded announcements and a menu), not a person. Keys are pressed for you.';
  if (change.state === 'hold') return 'Fact about the line: you are on hold in a queue; music and announcements are recordings, not a person.';
  if (change.state === 'talking' && change.why === 'a person answered') return `Fact about the line: a person seems to have picked up (they said: "${change.heard.slice(-160)}").`;
  return null;
}

/** Two-way silence ends a call only after this long. Hold music or announcements on the line are not silence. */
export const SILENCE_LIMIT_MS = 10 * 60_000;
/** On a menu the line may stay silent this long. In a queue silence never ends the call: TuGo's queue (call e559897f,
 *  2026-10-28) played nothing for 20 minutes and the old 20-minute limit hung up while it still held our place; the call's
 *  maximum length bounds a queue instead. */
export const QUEUE_SILENCE_LIMIT_MS = 20 * 60_000;
export function silentTooLong(s: { nowMs: number; lastWordsMs: number; lastLineSoundMs: number; state: CallState }): boolean {
  if (s.state === 'hold') return false;
  const quietSince = Math.max(s.lastWordsMs, s.lastLineSoundMs);
  return s.nowMs - quietSince > (s.state === 'menu' ? QUEUE_SILENCE_LIMIT_MS : SILENCE_LIMIT_MS);
}

// Distinguish carrier digital silence from line audio. Audio may be ringing, not an answered call.
export const DIGITAL_SILENCE_DB = -100;

/** What the bridge saw of a call whose phone line closed, on one clock (ms). */
export type LineEnd = {
  direction: 'inbound' | 'outbound';
  /** The carrier's hangup cause as Asterisk gave it, e.g. "Normal Clearing (SIP cause 16)". */
  gatewayReason: string | null;
  dialledAt: number;
  /** When the carrier answered the call (SIP), which for an outbound call is not when the number picked up. */
  answeredAt: number;
  /** When the line first carried audio, including ringback; null if it never did. */
  pickedUpAt: number | null;
  closedAt: number;
  lastLineSoundAt: number | null;
  lastKenanAt: number | null;
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** The call's end reason, from what was observed on the line only: the call agent and its worker act on it. */
export function lineEndReason(e: LineEnd): string {
  const cause = e.gatewayReason ?? 'no hangup cause given';
  const kenan = e.lastKenanAt === null ? 'Kenan never spoke' : `Kenan last spoke ${seconds(e.closedAt - e.lastKenanAt)} before it closed`;
  if (e.direction === 'outbound' && e.pickedUpAt === null) return `no callee answer was established: the carrier answered ${seconds(e.answeredAt - e.dialledAt)} after dialling, but the line never carried any sound, not even line noise, and it closed ${seconds(e.closedAt - e.answeredAt)} after that answer (${cause}). Silence does not establish whether the destination rang, rejected the call or answered silently; the carrier gave no further explanation. ${kenan}`;
  const heard = e.lastLineSoundAt === null ? 'never carried sound' : `last carried sound ${seconds(e.closedAt - e.lastLineSoundAt)} before it closed`;
  const picked = e.direction === 'outbound' && e.pickedUpAt !== null ? `first carried audio ${seconds(e.pickedUpAt - e.dialledAt)} after dialling (audio alone does not establish pickup) and ` : '';
  return `the phone network ended the call: ${cause} (the line ${picked}${heard}; ${kenan})`;
}
