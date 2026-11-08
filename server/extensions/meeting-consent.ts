// Consent and addressing rules shared by every notetaker (Kenan's own joiner and the Recall bot) and by the meeting
// voice page. Pure functions only: the camera page embeds `addressed` through Function.prototype.toString, so it must
// stay self-contained (no imports, no closures over module state).

/** What asks the notetaker to go, as one phrase right after the bot is addressed. */
const LEAVE_PHRASE = String.raw`(?:leave(?: (?:the|this) (?:call|meeting))?|go away|get out(?: of (?:here|the call|the meeting))?|drop off|hang up|stop (?:recording|taking notes|the notes))`;
/** Words between the bot's name and the leave phrase that keep it one request: "Kenan, please leave", "Kenan you can leave now". */
const POLITE = String.raw`(?:(?:please|now|just|kindly|you|can|could|would|should|may|need to|have to|must|go ahead and)\s+)*`;
/**
 * Someone asking the notetaker to leave, in chat or aloud. names: what speech recognition makes of "Kenan" (Meet's
 * captions wrote "Canon" and "Cannon" in the October 29 test), which count as naming the bot.
 *
 * A request names the bot and asks it to leave in the same clause, addressed to it: "Kenan, leave", "Kenan please
 * leave", "can Kenan leave?", "please leave, Kenan", "bot, get out", "can the notetaker leave?". The name and a leave word
 * anywhere in the same utterance is not one (2026-11-02, session 5259c94e: "I have no idea how Canon works. The airs are
 * proving themselves Morgan. They're going to get out of control." made the native notetaker leave Alice's meeting).
 */
export function asksToLeave(text: string, names: string[] = []): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  if (/\b(please )?(no|don'?t) (record|recording|notes?|notetaker|bots?)\b/.test(t)) return true;
  if (/\b(opt(?:ing)? out|i don'?t consent|do not consent|no consent)\b/.test(t)) return true;
  if (/\bwe don'?t want (the |an |this )?(ai|bot|notetaker|kenan)\b/.test(t)) return true;
  const spoken = [...new Set(['kenan', ...names.map(n => n.toLowerCase().replace(/[^a-z]/g, ''))].filter(Boolean))];
  const bot = String.raw`(?:${spoken.join('|')}|(?:the |this |our |you )?(?:notetaker|note taker|note-taker|bot|recorder|ai))`;
  const lead = String.raw`(?:(?:hey|hi|ok|okay|so|um|uh|yo|well|oh|alright|sorry|seriously|and|but)[,]?\s+)*`;
  const asks = [
    // "Kenan, leave" / "Kenan please leave" / "bot, get out" / "Kenan you can leave now": the clause starts with the bot.
    new RegExp(String.raw`^${lead}${bot}[,:!]?\s+${POLITE}${LEAVE_PHRASE}\b`),
    // "can Kenan leave?" / "could the notetaker please leave" / "will you leave, Kenan"
    new RegExp(String.raw`^${lead}(?:can|could|would|will)\s+${bot}\s+${POLITE}${LEAVE_PHRASE}\b`),
    // "please leave, Kenan" / "leave Kenan" / "get out, bot": the leave phrase then the bot, ending the clause.
    new RegExp(String.raw`^${lead}${POLITE}${LEAVE_PHRASE}[,]?\s+${bot}$`),
    // "please stop recording": stopping the notes is a request on its own.
    new RegExp(String.raw`^${lead}(?:please\s+)?stop (?:recording|taking notes)\b`),
    // "kick the bot (out)"
    new RegExp(String.raw`^${lead}(?:please\s+)?kick(?: out)? ${bot}\b`),
  ];
  // One clause at a time: sentence ends and semicolons separate them; Meet captions join sentences with periods.
  return t.split(/[.!?;\n]+/).map(c => c.trim().replace(/[,]+$/, '')).filter(Boolean).some(clause => asks.some(re => re.test(clause)));
}

/**
 * Someone taking back a leave request during the notetaker's grace period, addressed to it: "Kenan, stay", "Kenan, don't
 * leave", "stay, Kenan", "never mind Kenan", "Kenan, cancel". A bare "wait" or "stay" is not enough: leaving is the side
 * consent errs on.
 */
export function asksToStay(text: string, names: string[] = []): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  const spoken = [...new Set(['kenan', ...names.map(n => n.toLowerCase().replace(/[^a-z]/g, ''))].filter(Boolean))].join('|');
  const stay = String.raw`(?:(?:please\s+)?stay|(?:please\s+)?(?:don'?t|do not) (?:leave|go)|never ?mind|cancel(?: that)?|wait|no wait)`;
  return t.split(/[.!?;\n]+/).map(c => c.trim().replace(/[,]+$/, '')).filter(Boolean).some(clause =>
    new RegExp(String.raw`^(?:(?:no|hey|oh|sorry|actually|wait)[,]?\s+)*(?:${spoken})[,:!]?\s+${stay}\b`).test(clause) ||
    new RegExp(String.raw`^(?:(?:no|actually)[,]?\s+)*${stay}[,]?\s+(?:${spoken})$`).test(clause));
}

/** Names speech recognition hears for "Kenan". */
export const DEFAULT_WAKE_NAMES = ['Kenan', 'Kennan', 'Keenan', 'Kenon', 'Canaan', 'Kenin', 'Canon', 'Cannon'];

/**
 * Whether an utterance or chat line speaks to Kenan rather than about it: the name as one of the first four words
 * ("Kenan, what…", "Hey Kenan …"), a direct question or call ending in the name ("…, Kenan?"), or "@Kenan" in chat.
 * "Kenan's notes said…" and "I asked Kenan yesterday" are about Kenan, not to it.
 */
export function addressed(text: string, wakeNames: string[]): boolean {
  const names = wakeNames.map(n => n.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
  if (!names.length) return false;
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  const alternation = names.join('|');
  if (new RegExp(`@(${alternation})\\b`).test(t)) return true;
  const words = t.split(/\s+/).map(w => w.replace(/^[^a-z@']+|[^a-z']+$/g, '')).filter(Boolean);
  const isName = (w: string | undefined) => !!w && names.includes(w);
  // The name first, or after only greetings and fillers ("hey", "ok so", "um").
  const fillers = ['hey', 'hi', 'hello', 'ok', 'okay', 'so', 'um', 'uh', 'and', 'yo', 'well', 'oh', 'right', 'alright', 'excuse', 'me', 'sorry'];
  const at = words.findIndex(w => !fillers.includes(w));
  if (at >= 0 && at < 4 && isName(words[at])) {
    // Possessive or "Kenan said/says/was/is" is talk about Kenan.
    const raw = t.split(/\s+/).filter(Boolean)[at] ?? '';
    const next = words[at + 1];
    if (/[,:!?]$/.test(raw)) return true;
    if (!/'s\b/.test(raw) && !['said', 'says', 'was', 'wrote', 'is', 'has', 'had', 'did', 'does', 'will'].includes(next ?? '')) return true;
  }
  // "…, Kenan?" / "…, Kenan." / "thanks Kenan" at the end of the utterance.
  if (new RegExp(`[,!]\\s*(${alternation})\\s*[?.!]*\\s*$`).test(t)) return true;
  if (new RegExp(`\\b(${alternation})\\s*\\?\\s*$`).test(t)) return true;
  return false;
}

/** A person's likely display names from their opt-out record: the recorded name, and "First Last" from the email. */
export function optOutNames(entries: { email: string; displayName: string | null }[]): string[] {
  const names = new Set<string>();
  for (const e of entries) {
    if (e.displayName?.trim()) names.add(e.displayName.trim().toLowerCase());
    const local = e.email.split('@')[0] ?? '';
    const parts = local.split(/[._-]+/).filter(Boolean);
    if (parts.length >= 2) names.add(parts.join(' ').toLowerCase());
  }
  return [...names];
}
/** Whether a participant's display name is one of the opted-out names (whole-name match, case and accents ignored). */
export function isOptedOut(participantName: string, names: string[]): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const p = norm(participantName);
  return !!p && names.some(n => norm(n) === p);
}

/** How long a leave request waits, announced in the chat, before the notetaker leaves. */
export const LEAVE_GRACE_MS = 5000;
/** A leave request's grace period: the first request starts it, a second one or its end leaves, "Kenan, stay" cancels it. */
export class LeaveGrace {
  private at: number | null = null;
  detail: string | null = null;
  constructor(private readonly graceMs: number) {}
  get pending() { return this.at !== null; }
  request(detail: string, now: number): 'wait' | 'leave' {
    if (this.at !== null) { this.detail = `${this.detail}; then ${detail}`; return 'leave'; }
    this.at = now; this.detail = detail; return 'wait';
  }
  cancel() { this.at = null; this.detail = null; }
  due(now: number) { return this.at !== null && now - this.at >= this.graceMs; }
}
