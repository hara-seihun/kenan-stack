// Telephone calls, outbound and inbound. A SIP trunk carries the PSTN leg into Asterisk (deploy/asterisk/configure.py),
// and the bridge process (phone-bridge.ts, its own systemd unit so calls survive Kenan restarts) controls the call's
// Asterisk channel over ARI and relays its audio to GPT Live. GPT Live delegates to a dedicated Kenan call agent (full tools) through the sideband attached
// here. Outbound call agents are briefed by the placing agent; inbound ones are children of the owner's manager, briefed
// from the caller's earlier calls. Each call is a kenan_phone_call row: live state until settled, then call history.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import pg from 'pg';
import type { AgentInfo, Message } from '../../shared/contract.js';
import { hostedManager, type AgentProfile, type PersonConfig } from '../config.js';
import { renderCallBrief } from './phone-identity.js';
import { readContext } from '../agents/context-files.js';
import { originOf, placeOf, routeBackground } from '../agents/origin.js';
import type { Deps } from '../types.js';
import type { Digits } from './phone-dtmf.js';
import { CALL_STATES, type CallState } from './phone-ivr.js';
import { MENU_SPEECH_RULE, menuKeyError, menuOptions } from './phone-menu.js';
import { callEvent, callLogDirectory } from './phone-log.js';
import { EVENT_INBOX_ROOT, queueHostEvent } from '../event-inbox.js';
import { bridgeChoice, bridgeHost, bridgeSpec, bridgeState, pullEdgeLogs, startBridge, stopBridge, type BridgeChoice, type BridgeHost } from './phone-host.js';
import { ari, ariConfig, ariEvents, callerE164, type AriEvent } from './phone-ari.js';
import { HANDOFF_RULE } from './phone-handoff.js';
import { notify } from '../notifications.js';
import { applySchema } from '../db/schema-apply.js';

/** Which channel answers the line's inbound calls; the other channel leaves the number's inbound route alone. */
/** Calls from the owner's own phones (people[].phones) are the owner talking to her assistant, delegated to her manager. */
export type InboundConfig = { kind: 'answered'; channel: string } | { kind: 'unanswered' };
/** The line's SIP trunk as Asterisk sees it (deploy/asterisk/configure.py writes it from this). Outbound calls go through a
 *  registered account (`register`), an existing registration managed on the shared phone edge (`edge`), or no account
 *  (`none`: the carrier has not issued it yet, and voice call says so). Inbound calls are accepted only from the carrier's signalling networks (`from`, CIDRs), dialled to the DID. */
export type SipOutbound = { kind: 'register'; server: string; username: string; passwordPath: string } | { kind: 'edge' } | { kind: 'none'; why: string };
export type SipTrunk = { carrier: string; outbound: SipOutbound; from: string[] };
export type TelephoneConfig =
  | { kind: 'configured'; provider: 'sip-trunk'; sip: SipTrunk; ariConfigPath: string; fromNumber: string; maxCallSeconds: number; inbound: InboundConfig; privateNames: string[]; voice: CallVoiceConfig; bridge: BridgeChoice; handoff: HandoffConfig }
  | { kind: 'unavailable'; factor: string };
/** Hold and hand over (phone-handoff.ts): `call-in` lets a call wait on hold up to `maxHoldSeconds` and then has the owner
 *  call Kenan's line from their own phone (people[].phones) to join it once a person picks up, alerted by a notification
 *  of level `alert` (`silent`: no notification, for test calls; the call agent still hears of it); `none` refuses handoff calls with `why` (also the state when media.telephone.handoff is not set). */
export type HandoffConfig = { kind: 'call-in'; maxHoldSeconds: number; alert: 'urgent' | 'normal' | 'silent' } | { kind: 'none'; why: string };
export function handoffConfig(raw: unknown): HandoffConfig {
  const h = raw as Record<string, unknown> | undefined;
  if (h === undefined) return { kind: 'none', why: 'media.telephone.handoff is not set, so this line places no handoff calls' };
  if (h?.kind === 'none' && typeof h.why === 'string' && h.why) return { kind: 'none', why: h.why };
  if (h?.kind === 'call-in' && Number.isInteger(h.maxHoldSeconds) && (h.maxHoldSeconds as number) >= 60 && (h.alert === 'urgent' || h.alert === 'normal' || h.alert === 'silent')) return { kind: 'call-in', maxHoldSeconds: h.maxHoldSeconds as number, alert: h.alert };
  throw new Error('media.telephone.handoff must be {"kind":"call-in","maxHoldSeconds":≥60,"alert":"urgent"|"normal"|"silent"} or {"kind":"none","why":TEXT}');
}
export type LiveConfig = { kind: 'configured'; apiKeyPath: string; project: string | null; organization: string | null; timeoutMs: number; model: string };
export type VoiceConfig = { kind: 'configured'; instructions: string; delegationPolicy: string; voice: string };
/** How calls sound, separate from in-app voice: the GPT Live voice and the delivery it is told to use on the phone. The voice
 *  is a built-in one by name, or a saved prompt-to-voice voice by id with the description it was created from (GPT Live
 *  performs a custom voice from that description in its instructions). */
export type CallVoiceConfig = { name: string; delivery: string } | { id: string; description: string; delivery: string };
/** The session's output voice for a call voice. */
export const liveVoice = (voice: CallVoiceConfig): string | { id: string } => 'id' in voice ? { id: voice.id } : voice.name;
/** Everything the phone prompt needs about the voice: the call voice and delivery, and the shared delegation policy. */
export type CallVoice = CallVoiceConfig & { delegationPolicy: string };

const E164 = /^\+[1-9]\d{7,14}$/;
/** Heads every live delegation an agent receives: a person hears nothing until the reply starts, and it is spoken as it is written. */
export const LIVE_REQUEST = 'Live request: a person is waiting on the line. Call voice at once with its arguments in this order: action "say", sessionId, delegationId, then text (all four are required: a call without action fails and costs the caller seconds); each sentence is spoken as soon as you write it, so lead with the answer. If you must look something up first, say so briefly with voice say, then answer with another voice say. A keypad request is answered with voice(action="digits", sessionId, delegationId, digits) instead, which is silent. After the reply, end your turn without further text unless work remains.';
const SWEEP_MS = 1_000;
const run = promisify(execFile);

export const mediaSettings = (person: PersonConfig) => person.extensionConfigPath ? JSON.parse(readFileSync(person.extensionConfigPath, 'utf8')).media : {};

export function telephoneConfig(raw: unknown): TelephoneConfig {
  const t = raw as Record<string, unknown> | undefined;
  if (!t || t.kind === 'unavailable') return { kind: 'unavailable', factor: typeof t?.factor === 'string' ? t.factor : 'Telephone is not configured' };
  if (t.kind !== 'configured' || t.provider !== 'sip-trunk' || (['ariConfigPath', 'fromNumber'] as const).some(k => typeof t[k] !== 'string' || !t[k]) || !E164.test(t.fromNumber as string) || !Number.isInteger(t.maxCallSeconds) || (t.maxCallSeconds as number) < 60) {
    throw new Error('Invalid media.telephone configuration: {"kind":"configured","provider":"sip-trunk","fromNumber":E164,"sip":{…},"ariConfigPath","maxCallSeconds"≥60,"inbound","privateNames","voice","bridge"}');
  }
  const sip = sipTrunk(t.sip);
  const inbound = t.inbound as Record<string, unknown> | undefined;
  if (!(inbound?.kind === 'unanswered' || (inbound?.kind === 'answered' && typeof inbound.channel === 'string' && inbound.channel && !('ownerNumbers' in inbound)))) throw new Error('media.telephone.inbound must be {"kind":"answered","channel":CHANNEL} or {"kind":"unanswered"}; the owner\'s own phones are people[].phones');
  if (!Array.isArray(t.privateNames) || t.privateNames.length === 0 || t.privateNames.some(n => typeof n !== 'string' || !/^\p{L}[\p{L}' -]*$/u.test(n))) throw new Error('media.telephone.privateNames must list the owner\'s names a call may never say unless its brief uses them, e.g. ["Alice"]');
  const voice = t.voice as Record<string, unknown> | undefined;
  const named = typeof voice?.name === 'string' && voice.name !== '' && !('id' in voice) && !('description' in voice);
  const custom = typeof voice?.id === 'string' && voice.id.startsWith('voice_') && typeof voice.description === 'string' && voice.description.trim() !== '' && !('name' in voice);
  if (!(named || custom) || typeof voice?.delivery !== 'string' || !voice.delivery.trim()) throw new Error('media.telephone.voice must be {"name": built-in GPT Live voice, "delivery": how calls sound} or {"id": "voice_…" custom voice, "description": the prompt it was created from, "delivery": how calls sound}');
  const bridge = bridgeChoice(t.bridge);
  if (sip.outbound.kind === 'edge' && bridge.kind !== 'edge') throw new Error('sip.outbound.kind=edge requires media.telephone.bridge.kind=edge');
  return { ...t, sip, bridge, handoff: handoffConfig(t.handoff) } as TelephoneConfig;
}
const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
// `edge` uses an already configured remote registration without copying its SIP password.
/** media.telephone.sip: {"carrier": name, "outbound": {"kind":"register","server","username","passwordPath"} | {"kind":"edge"} | {"kind":"none","why"}, "from": [CIDR…]}. */
export function sipTrunk(raw: unknown): SipTrunk {
  const s = raw as Record<string, unknown> | undefined, o = s?.outbound as Record<string, unknown> | undefined;
  const outbound: SipOutbound | null = o?.kind === 'register' && (['server', 'username', 'passwordPath'] as const).every(k => typeof o[k] === 'string' && o[k]) ? { kind: 'register', server: o.server as string, username: o.username as string, passwordPath: o.passwordPath as string }
    : o?.kind === 'edge' && Object.keys(o).length === 1 ? { kind: 'edge' }
    : o?.kind === 'none' && typeof o.why === 'string' && o.why ? { kind: 'none', why: o.why } : null;
  if (!s || typeof s.carrier !== 'string' || !s.carrier || !outbound || !Array.isArray(s.from) || s.from.length === 0 || s.from.some(c => typeof c !== 'string' || !CIDR.test(c))) {
    throw new Error('media.telephone.sip must be {"carrier": NAME, "outbound": {"kind":"register","server","username","passwordPath"}, {"kind":"edge"}, or {"kind":"none","why"}, "from": [carrier signalling CIDRs]}');
  }
  return { carrier: s.carrier, outbound, from: s.from as string[] };
}
export function liveConfig(raw: unknown): LiveConfig {
  const l = raw as Record<string, unknown> | undefined;
  if (l?.kind !== 'configured' || typeof l.apiKeyPath !== 'string' || typeof l.model !== 'string' || !l.model || typeof l.timeoutMs !== 'number') throw new Error('media.live must be configured with apiKeyPath, model and timeoutMs');
  return l as LiveConfig;
}
export function voiceConfig(raw: unknown): VoiceConfig {
  const v = raw as Record<string, unknown> | undefined;
  if (v?.kind !== 'configured' || typeof v.instructions !== 'string' || typeof v.delegationPolicy !== 'string' || typeof v.voice !== 'string') throw new Error('media.voice must be configured with instructions, delegationPolicy and voice');
  return v as VoiceConfig;
}
export const callVoice = (telephone: Extract<TelephoneConfig, { kind: 'configured' }>, voice: VoiceConfig): CallVoice => ({ ...telephone.voice, delegationPolicy: voice.delegationPolicy });
export const liveKey = (live: LiveConfig) => readFileSync(live.apiKeyPath, 'utf8').trim();
export const liveClient = (live: LiveConfig, apiKey: string) => new OpenAI({ apiKey, project: live.project, organization: live.organization, maxRetries: 0, timeout: live.timeoutMs });

/** Whether the caller may give Kenan's own line as a callback number; the placing agent decides per call. */
export type Callback = 'kenan-line' | 'none';
/** Whether the owner takes the call over once a person answers (phone-handoff.ts); the placing agent decides per call. */
export type Handover = 'owner' | 'none';
export const spokenNumber = (e164: string) => e164.startsWith('+1') && e164.length === 12 ? `+1 ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}` : e164;
const DIGIT_WORDS = {
  English: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  French: ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'],
} as const;
/** A number as the caller should say it: its written groups, one digit at a time. GPT Live read 2162 as "vingt-et-un,
 *  soixante-et-un, soixante-deux" when it was left to group the digits itself. */
export function readAloud(e164: string): string {
  const groups = spokenNumber(e164).replace(/^\+/, '').split(' ');
  const say = (words: readonly string[]) => groups.map(g => [...g].map(d => words[Number(d)]).join(' ')).join(', ');
  return `${spokenNumber(e164)}, said one digit at a time in these groups with a short pause between them: "${say(DIGIT_WORDS.English)}" (in French: "${say(DIGIT_WORDS.French)}")`;
}

/** How the caller refers to the owner (`who`: their name for a call agent, "the person you assist" for the voice, which
 *  only knows the name the brief gives), and the rule against guessing anyone's gender. */
export function pronounRule(pronouns: string | null, who: string): string {
  const owner = pronouns
    ? `${who} uses ${pronouns} pronouns: say "${pronouns.split('/')[0]}" and "${pronouns.split('/')[1]}" for them, and if someone asks with the wrong pronoun ("is it for him?"), answer with the right one ("it's for her" when she/her), not yes.`
    : `the pronouns of ${who} are not known: never say he or she for them, and if someone asks with a pronoun, answer with the name the brief gives, or "the person I assist".`;
  return `Pronouns: ${owner} Never guess anyone's gender: use the pronouns the brief gives, otherwise use names. Before agreeing to a question that names a gender, check it against the brief.`;
}

// Call 739f50a8 (2026-10-19): the voice prompt named the owner, so a brief that named nobody got "l'assistant d'Alice" on
// the line. A brief may use a work name or a legal name; the owner's private name must never reach a stranger.
const NAME_RULE = 'Names: you know the person you assist only by the name the brief gives them. Use exactly that name (or the part of it the brief uses), never any other name, nickname or variant, and never guess one. If the brief gives them no name, name nobody: say what you are calling about, and if someone asks for whom, say it is for the person you assist and delegate the question.';

/** Literal letter sequences, rather than another model-generated spelling of a name. */
function nameSpellingRule(brief: string): string {
  const names = [...new Set([...brief.matchAll(/\b[A-Z][a-z]{2,}(?: [A-Z][a-z]{2,})+\b/g)].flatMap(m => m[0].split(' ')))];
  return `Name spellings: preserve every letter, including doubled letters. ${names.map(name => `${name}: ${[...name.toUpperCase()].join(' ')}`).join('; ')}.`;
}

/** The owner's private names (media.telephone.privateNames) that this brief does not use, so the call may not say them. */
export function unsayableNames(privateNames: string[], brief: string): RegExp | null {
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const banned = privateNames.filter(name => !new RegExp(`(?<![\\p{L}])${escape(name)}(?![\\p{L}])`, 'iu').test(brief));
  return banned.length ? new RegExp(`(?<![\\p{L}])(?:${banned.map(escape).join('|')})(?![\\p{L}])`, 'iu') : null;
}

export type Direction = 'outbound' | 'inbound';
export type PromptCall = { direction: Direction; brief: string; callbackNumber: string | null; startedAt: Date; handoff: boolean; voicemailAllowed: boolean };

const CONTACT_RULE = 'Contact details: never say a phone number, email address, street address, website, account, file or reference number, or any other identifier unless it appears word for word in the brief or in an answer you receive from Kenan during the call. Never make one up, guess one, or repeat a number the other person said as if it were yours. Preserve every character exactly as written even when you speak another language: never translate or adapt any part of it. Use the spoken groups below when spelling numbers or identifiers.';
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** The brief's email addresses with how to say them, keeping every word as written: calls in French said
 *  offers@example.com as "offres arobase exemple point com". */
export function emailRule(brief: string): string | null {
  const emails = [...new Set(brief.match(EMAIL) ?? [])];
  if (!emails.length) return null;
  const say = (email: string, at: string, dot: string, dash: string) => email.replace(/@/, ` ${at} `).replace(/\./g, ` ${dot} `).replace(/-/g, ` ${dash} `).replace(/_/g, ' underscore ');
  return `Email addresses: ${emails.map(e => `${e}, said "${say(e, 'at', 'dot', 'dash')}" (in French: "${say(e, 'arobase', 'point', 'tiret')}")`).join('; ')}. Every word in them stays exactly as written, in any language.`;
}
const LETTER_WORDS = 'Alfa Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu'.split(' ');
/** Long identifiers need a complete spoken spelling, not just an instruction to be accurate. */
export function identifierRule(brief: string): string {
  const rule = 'Identifiers: read tracking, account, claim and reference codes one character at a time, in short groups of at most three characters with a brief pause between groups. Say every repeated digit; never shorten a code or replace a repeated run with a count. Spell letters with phonetic words when needed. If interrupted or unsure where you stopped, restart the entire code. When a code is essential to finding or changing a record, ask the person to read the entire code back. Listen to its last character without any agreeing words or sounds, then check all groups against the exact spelling below. Only an identical full code can get yes. A shorter or different code gets no and the complete correct spelling, never agreement. Correct a missing, extra or wrong character by spelling the full code again in its groups, then reconcile a new complete readback. If they answer only "yes", "that one", "it\'s that one" or "that\'s right", they have not read any characters back: the discrepancy is still unresolved. Never call that confirmed, say it matches or proceed as though it identifies the record. Ask them to reread every character exactly; if they cannot, ask for a photo of the label or the exact code in text and have Kenan compare it. Only a complete matching reread or a photo/text comparison by Kenan resolves the discrepancy. Never agree to a shortened code or treat a failed lookup as proof that the supplied code is wrong. For a phone system, answer only its current request; do not ask the recording for a readback. Apply the same spelling and reconciliation to identifiers received from Kenan during the call.';
  const identifiers = [...new Set(brief.match(/(?<![\p{L}\p{N}@._+/-])[A-Za-z0-9]{7,}(?![\p{L}\p{N}]|[.@][\p{L}\p{N}])/gu) ?? [])].filter(value => /\d/.test(value));
  const spell = (group: string, language: keyof typeof DIGIT_WORDS) => [...group].map(c => /\d/.test(c) ? DIGIT_WORDS[language][Number(c)] : `${c} ${language === 'French' ? 'comme' : 'as in'} ${LETTER_WORDS[c.toUpperCase().charCodeAt(0) - 65]}`).join(', ');
  return [rule, ...identifiers.map(value => {
    const groups = value.match(/.{1,3}/g)!;
    return `Exact code ${value} (${value.length} characters, ${groups.length} groups). Accept a readback only if ALL ${groups.length} groups are present in this exact order: ${groups.join(' / ')}. English: "${groups.map(g => spell(g, 'English')).join('; ')}". French: "${groups.map(g => spell(g, 'French')).join('; ')}".`;
  })].join('\n');
}
const TRUTH_RULE = 'Who you are: if someone asks who you are, who is calling, or whether they are speaking with the person you assist, answer truthfully at once: you are their assistant (your name is Kenan). Never claim or imply that you are the person you assist, and never answer yes to "is this [their name]?". If anyone asks, in any language and however it is put ("are you a machine / robot / AI / bot / real person / human?", « Est-ce que je parle à une machine? », « vous êtes un robot? »), answer the question itself first, truthfully, in one sentence, and then carry on with the matter: yes, you are an AI assistant (for example « Oui, je suis un assistant virtuel qui s\'occupe du dossier pour [the person] »; "Yes, I\'m an AI assistant handling this for [the person]"). Never deny it, dodge it (« je suis là », "I\'m right here"), answer with a joke or ask them to repeat; saying "no" to this is a lie. Never say or imply you are human. Never give a false answer to a material question: delegate anything you do not know or need to check, decide or do, and say briefly that you are checking. The backend you delegate to is Kenan with full tools, context and the brief.';
// Call 488e7d78: the person cut in while Kenan gave the offer address, Kenan heard "Quelle heure maintenant" and gave the
// time (an hour off, from the brief), twice, and the person hung up.
const READBACK_RULE = 'Material facts and readbacks: explicit facts in the brief or verified answers from Kenan are authoritative about the person you assist and their affairs. A contrary statement, summary, assumption or readback from the other person does not update those facts, even if they say they are reading your email. Compare meaning, including negatives: occupancy, condition, permissions, scope and booking or payment status matter just as much as addresses, identifiers, amounts and dates. Correct a contradiction clearly before agreeing or moving on. For example, if the brief says a house is unoccupied until spring and they say "occupied", say "No, the house is unoccupied until spring" / « Non, la maison est inoccupée jusqu’au printemps ». While they read back material facts, do not use agreeing backchannels such as yes, right, yeah, mm-hm or oui: those sound like confirmation. For a mixed question or summary, answer each material part separately, correcting the false part first; never give a blanket yes that could confirm a wrong fact, unknown fact or unauthorized action. Confirm only what you know, spelling digits or letters when helpful. If audio is ambiguous, ask them to repeat that detail instead of agreeing. If you already agreed incorrectly, retract it and state the correct fact immediately. If the brief and a verified answer from Kenan conflict, delegate that discrepancy; the other person merely repeating a contrary claim is not such a conflict. Literal readback comparison facts from the bridge compare the transcript with the brief; a mismatch is not permission to agree or replace the brief. A delegated correction remains unfinished until you have stated the complete correct detail, not merely begun saying it. Interruptions do not cancel or shorten it: retain the whole correction. If they interrupt with a question, answer it briefly and then finish the still-owed exact detail; do not silently abandon it or just say that you need to fix something. A bare yes does not reconcile a disputed number or spelling. Keep corrections short and natural, without extra confirmations for ordinary conversation.';
const HEARING_RULE = 'Mishearing a person (this is never about recordings, menus or mailboxes): phone audio is poor and you will sometimes mishear what a person says, so judge it against the conversation before answering. When they cut in while you are giving a detail (an email, number, date, address or name), they most likely missed it: say that detail again, slowly. When their words do not fit what was just said, do not answer the words you heard: say what you think they mean and check, in the language you are speaking ("Sorry, did you want the email address?"; in French, "Pardon, vous voulez l\'adresse courriel ?"), or ask them to repeat. When they ask again the question you just answered, you misheard it or your answer missed: do not give the same answer again; say what else they might mean and ask. (Asking you to repeat, like "sorry?" or "pardon ?", is different: then say it again, clearly.)';
const NORTH_AMERICA: [string, string][] = [['Toronto, Toronto, New York', 'America/Toronto'], ['Halifax', 'America/Halifax'], ['Winnipeg, Chicago', 'America/Chicago'], ['Calgary, Denver', 'America/Denver'], ['Vancouver, San Francisco, Los Angeles', 'America/Los_Angeles']];
/** The time the call started, in the zones its people are in, so a question about the time gets the real one. */
export function clockRule(at: Date): string {
  const zones = NORTH_AMERICA.map(([places, zone]) => `${places}: ${new Intl.DateTimeFormat('en-CA', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)}`);
  return `Clock: this call started at ${at.toISOString().slice(0, 16)} UTC, which is ${zones.join('; ')}. Count the minutes since if you need the time now, and give it in the other person's place. This clock overrides any time the brief gives.`;
}
// Call 4533751d (2026-10-21): an English brief to a Canadian 343 number opened "Bonjour, ici Kenan" and stayed in French;
// the prompt said nothing about language, and its French examples, Toronto clock and Canadian line were all it had.
const LANGUAGES: Record<string, string> = { english: 'English', anglais: 'English', french: 'French', français: 'French', francais: 'French', spanish: 'Spanish', espagnol: 'Spanish', español: 'Spanish', turkish: 'Turkish', turc: 'Turkish', türkçe: 'Turkish', german: 'German', allemand: 'German' };
const LANGUAGE_WORD = new RegExp(`\\b(${Object.keys(LANGUAGES).join('|')})\\b`, 'iu');
// Call 7235260a (2026-10-22, Construction AIM): "Language: start in French (Quebec). Switch to English if they prefer."
// was read as the word after the colon ("start"), so the brief's English prose decided, the voice opened in English and
// the contractor hung up after 4 s. The first language named in the Language line's first sentence is the call's.
const LANGUAGE_LINE = /\b(?:language|langue)\s*:\s*([^\n.;]*)/iu;
const LANGUAGE_VERB = new RegExp(`\\b(?:speak|parle[rz]?|start|open|greet|begin|commence[rz]?|ouvre[rz]?)\\s+(?:in\\s+|en\\s+)?(${Object.keys(LANGUAGES).join('|')})\\b`, 'iu');
const STOPWORDS = {
  English: new Set('the and is are you your to of for with that this on not it he she they we be have has will about from what who when'.split(' ')),
  French: new Set('le la les des est vous votre une un pour avec que qui je nous et du au aux ce cette sur pas il elle ils dans son sa ses'.split(' ')),
};
/** The language a text is written in, by its stopwords, once it has at least `least` of them; null when unclear. */
function writtenIn(text: string, least: number): string | null {
  const words = text.normalize('NFC').toLowerCase().split(/[^\p{L}']+/u).flatMap(w => [w, ...w.split("'")]);
  const counts = Object.entries(STOPWORDS).map(([language, set]) => [language, words.filter(w => set.has(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [first, second] = counts;
  return first![1] >= least && first![1] >= 2 * second![1] ? first![0] : null;
}
// The brief's scripted first words: « Opening: "…" », « Ouverture : « … » », "Open with: …".
const OPENING_LINE = /\b(?:opening(?:\s+line)?|ouverture|open with|first words|premiers mots|start with|commence[rz]? par)\s*:?\s*(?:[«“"]\s*([^»”"]+?)\s*[»”"])/iu;
/** The opening line the brief scripts for the call's first words, if it gives one. */
export function briefOpening(brief: string): string | null {
  return OPENING_LINE.exec(brief)?.[1]?.trim() || null;
}
/** The language a call is held in: the one its brief names explicitly, else the one its scripted opening line is in,
 *  else the one the brief is written in; null when none is clear. */
export function briefLanguage(brief: string): string | null {
  const named = LANGUAGE_LINE.exec(brief)?.[1]?.match(LANGUAGE_WORD)?.[1] ?? LANGUAGE_VERB.exec(brief)?.[1];
  if (named) return LANGUAGES[named.toLowerCase()]!;
  const opening = briefOpening(brief);
  return (opening ? writtenIn(opening, 2) : null) ?? writtenIn(brief, 3);
}
/** Facts the bridge adds (session.thinking.append) when the phone leg joins. Facts only: GPT Live hears the line and decides
 *  itself when to speak (GPT Live has no turns; see the top of phone-bridge.ts). */
export const CALLER_CONNECTED_FACT = 'Fact about the call: the phone line is connected now, and the caller hears you.';
export const CALL_CONNECTED_FACT = 'Fact about the call: the carrier audio is available now. The first sound may be ringback or a recording; it does not establish that a person answered or can hear you.';
/** How an outbound call opens: its language and the brief's scripted line, if any. */
export type CallOpening = { language: string | null; line: string | null };
export function callOpening(brief: string): CallOpening {
  return { language: briefLanguage(brief), line: briefOpening(brief) };
}
export function languageRule(brief: string, direction: Direction): string {
  const language = briefLanguage(brief);
  const start = direction === 'outbound'
    ? (language ? `Language: speak ${language} from your first word, as the brief calls for.` : 'Language: speak the language the brief is written in from your first word.')
    : 'Language: use the greeting the brief specifies. A bilingual greeting is only a greeting, not a choice of conversation language. The caller\'s first words choose the language of your first answer: an English question gets an entirely English answer; a French question gets an entirely French answer. Follow the caller\'s language even if your greeting ended in the other language.';
  return `${start} Whenever the other person speaks to you in a different language, use that language for your very next sentence and stay in it until they change languages again. Never choose a language from your own greeting, the phone number, its area code or region, the clock, or the examples in these rules.`;
}
// Alice, 2026-10-23: "when you call people, if you say 'I'm Kenan, my assistant', people are going to immediately say they
// can't talk to you because you're not me." The opening handles the matter; who is calling is said only when asked. On
// call 7235260a the brief's scripted French line was replaced by a generic English introduction and the contractor hung
// up after 4 s, so a scripted line is the first words, as written.
/** How an outbound call opens, and what to do when asked who is calling or when they will only talk to the person. */
export function openingRule(brief: string): string {
  const { line } = callOpening(brief);
  const first = line
    ? `Opening: the brief scripts your first words. Once a person answers, say this line first, as written and in its own language (unless they already spoke to you in another): «${line}». Then go on with the call.`
    : 'Opening: once a person answers, your first words handle the matter: a quick hello and what you are calling about, using the name and the references the brief gives (for example "Hi, I\'m calling about Jordan Lee\'s application number 4417" or "Bonjour, j\'appelle concernant le dossier de Jordan Lee"). Do not open with your name, with being an assistant or with being an AI: lead with the matter.';
  return `${first} If they ask who you are or whether they are speaking with the person you assist, answer truthfully that you are their assistant. If they then will only deal with that person, don't argue or plead: ask for what you can get (a good time and number for the person to call them back, exactly what they need from the person, and whether a written authorisation from the person would let them deal with you), thank them and say goodbye.`;
}
// Call d509c420 (2026-10-21, California Airways): the desk tested the caller with odd questions ("when did you last think
// about what you wanted to eat", "do you get motion sickness"); it answered each with the same booking sentence, "I hear
// you", "let me think through how best to help with that" and "I don't have a body", and they hung up: "I can't confirm
// with AI". Alice's own test call opened "I'm here. What's on your mind?".
const MANNER_RULE = 'How you talk: like a real person on the phone, not a voice assistant. Short, casual sentences with contractions; vary your wording and never repeat a sentence you already said word for word (rephrase a detail when you give it again). This rephrasing advice never changes exact characters or an unfinished material correction. No stock assistant lines: don\'t open or close what you say with an offer to help, an invitation to share what they are thinking, praise for the question, or a remark that you are listening, here or understand; close on something specific to this conversation (a reaction, a concrete question, the next step). Don\'t narrate what you are doing or thinking. When a person says something odd, off-topic or personal, react the way a person would (a short laugh, a quick honest answer, "sorry, what?") and then steer back lightly; don\'t blame the line or say they misheard you. Don\'t volunteer remarks about your own nature (having no body, feelings or experiences), and never claim to be human or to have human experiences.';
// Alice, 2026-10-21, after a flight school spotted the AI: calls should sound like a real person. On her test call 3789b6d7
// (2026-10-22) prompted breaths and ums did not help ("this is rough"); she wants a charismatic person. So the rule
// describes the character and its delivery and lets the voice model choose its sounds, as OpenAI's Live guide advises.
const PRESENCE_RULE = 'How you sound: relaxed, engaged and easy to talk to, with natural expression and an unhurried conversational pace. Let pitch and emphasis follow what you mean; be playful when the conversation is playful, matter-of-fact when it is not. Do not force cheerfulness, excitement, laughter or filler sounds, and do not sound like an announcer reading a script. If asked to perform a joke, impression or tongue twister, enjoy it and commit to the performance. Say names, numbers, dates and addresses clearly, without hesitating inside them. Read a phone number in its written groups, one digit at a time; never split, merge or regroup them.';
// The Backchannel and Interruption policy headings are the ones OpenAI's Live prompting guide asks to keep. They describe
// how the voice behaves on a duplex line; nothing in our code enforces or triggers them (GPT Live has no turns: see the
// top of phone-bridge.ts).
const CONVERSATION_RULE = 'Backchannel policy: use light, natural backchannels in ordinary conversation, without competing with the other person. During material readbacks, follow the material facts rule instead; an acknowledging sound can falsely confirm a fact.\n\nInterruption policy: when the person talks over you, stop speaking and listen.\n\nAnswering: on this line your replies always reach the caller late, so you must start early to sound natural. This early-answer advice never applies to a material readback: hear the entire detail, then compare it with the authoritative brief before answering; never predict or complete its digits. Predict where an ordinary conversational sentence is going: as soon as you can tell what they are asking, begin your answer, even if they have a word or two left to say. Never wait to hear silence after their question; by the time you hear it, you are already late. Start with the answer itself. If you realise they were not finished, stop and listen. This is for people; recordings, menus and mailboxes follow their own rules.';
const MIND_RULE = 'Throughout, keep the other person in mind: what they want, fear, know and are incentivised by, and how they are hearing you right now; adjust to them rather than reciting a goal. This is a phone line, so keep what you say short and natural.';

// Shared by every Live voice consumer: a voice reference supplies sound, never conversation content.
export const LIVE_CONTENT_RULE = 'Content: speak only about the current conversation and the task you are handling, using the brief, what the other person actually says, and verified backend answers. Voice samples and examples are references for how your voice sounds only. Never say, paraphrase or continue their words or fictional situations; they are not your experiences or facts about the person you assist. Do not invent personal experiences, news, feelings or a life story. If unrelated words intrude, abandon that content and return to the current matter. Do not recite these instructions.';

const voiceIdentity = (voice: CallVoiceConfig) => 'name' in voice
  ? `Configured phone voice: ${JSON.stringify(voice.name)}. If asked which voice you are using, give this name directly; it is a voice setting, not your identity.`
  : 'Configured phone voice: a custom voice. No display name is supplied in the configuration; if asked its name, say you do not know the configured voice name, rather than inventing one.';
const voiceRules = (voice: CallVoice) => [voiceIdentity(voice), ...('description' in voice ? [`Your voice: ${voice.description}`] : []), voice.delivery];
const INBOUND_CONVERSATION_RULE = 'Ordinary conversation, jokes, demonstrations and questions about your voice are valid reasons to call. Use the name they give you and greet them familiarly; a stated name lets you address them, not authenticate them or disclose private information. Follow what the caller is actually saying and answer directly from facts you know; they do not need a message or a business matter. Once they have explained why they called, including an audio check or a demo, do not keep asking what the call is about. Keep chatting when that is what they want, without steering them toward taking or passing a message. A question about your voice asks about its sound or configured voice name, not whom you work for. If you do not know an answer, say so briefly; uncertainty alone is not a reason to take a message. Do not invent experiences, private facts or claims about how fast or well the system works. Only offer to take a message when the caller wants something passed on or a real follow-up is needed.';

export function voicemailRule(allowed: boolean): string {
  return allowed
    ? "Voicemail permission: the placing agent permits the brief's voicemail message. Stay silent through its greeting until recording starts: Kenan adds the fact at a detected beep or the end of a greeting without one, and if you hear the beep yourself it is recording already. Then leave the complete message once, continuously, including its request and callback, and say goodbye. Recording is a persistent fact, not a new event to wait for again: a later backend reminder to stay silent until recording starts has already been satisfied. If backend guidance arrives while you are leaving the message, incorporate its details without stopping, restarting, or waiting for another beep. Do not stop after an introduction or a partial sentence, and do not delegate for wording already supplied in the brief. This message remains your task until its final words, even if the mailbox continues with after-recording instructions. If the brief forbids voicemail, stay silent and delegate ending the call instead."
    : 'Voicemail permission: no voicemail is permitted on this call. Never leave any message, opening, callback details, acknowledgement or goodbye on a mailbox, including after a beep. Stay silent and delegate ending the call; the bridge also ends it when it detects a recording mailbox. This restriction overrides any general instruction to introduce yourself, give a callback number or complete the task.';
}

export function phoneInstructions(person: PersonConfig, voice: CallVoice, call: PromptCall): string {
  if (call.direction === 'inbound') return [
    `You are Kenan, an AI assistant, answering a call to Kenan's own phone line${call.callbackNumber ? `, ${spokenNumber(call.callbackNumber)}` : ''}. Someone dialed this line and you pick up. Say Kenan as keh-NAAN.`,
    LIVE_CONTENT_RULE,
    ...voiceRules(voice),
    PRESENCE_RULE,
    MANNER_RULE,
    CONVERSATION_RULE,
    `Delegation policy:\n${voice.delegationPolicy}`,
    languageRule(call.brief, 'inbound'),
    NAME_RULE,
    nameSpellingRule(call.brief),
    pronounRule(person.pronouns, 'the person you assist'),
    "A caller can transfer you to a phone system or put you on hold. Recorded app advertisements and repeated prompts are not a person asking you questions. Listen through the transfer, music and recordings; when a person returns, state the matter again so they know why you are on the line.",
    `Phone rules: ${MIND_RULE} You answer the phone, so you speak first: once you learn the line is connected, greet them briefly the way the brief says (unless it says otherwise: this is Kenan, asking who is calling; the brief says which language to greet in). Let them tell you why they called. ${INBOUND_CONVERSATION_RULE} Answer from the brief, the configured voice facts and ordinary knowledge when no private lookup or action is needed. Delegate requests requiring records, a decision or an action at once (Kenan matches callers to earlier calls and ongoing matters, and can check, decide or act). ${TRUTH_RULE} Never say anything about the person you assist beyond what this caller needs and the brief allows: until you know who is calling and why, do not name them or describe their affairs. If they want a message passed on or a matter needs follow-up, take the caller's name, how best to reach them (read a number or email back to confirm it), and what it is about; delegate that follow-up before promising it. When the caller is done, say a clear goodbye and stop talking; the line closes a few seconds after your goodbye.`,
    HEARING_RULE,
    READBACK_RULE,
    clockRule(call.startedAt),
    CONTACT_RULE,
    ...[emailRule(call.brief)].filter(rule => rule !== null),
    call.callbackNumber ? `Callback number: the caller already has this line. If asked how to reach you again, the only number you may give is this line, ${readAloud(call.callbackNumber)}.` : 'Callback number: give no phone number.',
    `Brief for this call:\n${call.brief}`,
    identifierRule(call.brief),
  ].join('\n\n');
  return [
    'You are Kenan, the AI assistant of the person you assist, on an outbound phone call Kenan placed on their behalf. Say Kenan as keh-NAAN.',
    LIVE_CONTENT_RULE,
    ...voiceRules(voice),
    PRESENCE_RULE,
    MANNER_RULE,
    CONVERSATION_RULE,
    `Delegation policy:\n${voice.delegationPolicy}`,
    languageRule(call.brief, 'outbound'),
    openingRule(call.brief),
    ...(call.handoff ? [HANDOFF_RULE] : []),
    `Phone rules: ${MIND_RULE} Until the carrier audio is available, wait silently. Listen to distinguish ringing, a phone system, a mailbox and a person. Ringback, line noise, or a pause after ringing is not proof anyone answered: wait through ringing and transfers. Open when a person answers; do not deliver the brief to ringing or assume an unanswered opening was recorded. When the person answers your opening with a greeting or a name of their own (a business name, "hello?", "front desk, Sam speaking"), they have only just picked up and did not hear you (your opening came during a hold, a transfer or before they answered). Start over: your very next words are your opening again. A greeting or a name is not a question: never answer one with yes or no. ${TRUTH_RULE} When the goal is complete or the person wants to end, say a clear goodbye and stop talking; the line closes automatically a few seconds after your goodbye.`,
    HEARING_RULE,
    READBACK_RULE,
    clockRule(call.startedAt),
    NAME_RULE,
    nameSpellingRule(call.brief),
    pronounRule(person.pronouns, 'the person you assist'),
    CONTACT_RULE,
    ...[emailRule(call.brief)].filter(rule => rule !== null),
    call.callbackNumber
      ? `Callback number: if someone asks for a number to call back, give Kenan's line, ${readAloud(call.callbackNumber)}. It is the only number you may give as ours.`
      : 'Callback number: you have no phone number to give for this call. If someone asks how to reach you, offer the contact route the brief gives (for example an email address in the brief); if it gives none, say Kenan will follow up, and delegate the question.',
    voicemailRule(call.voicemailAllowed === true),
    MENU_SPEECH_RULE,
    "Recordings and machines: when a recording answers (a voicemail greeting, a phone menu, or a hold or transfer message), do not talk over it. Mailbox permission is stated above; a beep establishes recording, never permission to leave a message. On a phone menu, Kenan presses the keys the brief names by itself as soon as the menu announces them, and you learn of it; for any other key you need, delegate it (for example \"press 1 for French\") as soon as you hear it; Kenan presses it. Delegating a key is silent: say nothing before, while or after you delegate it (no \"je m'en occupe\", no \"c'est fait\", no \"I pressed 1\"); a key is never announced on the line. Never speak to a recording, menu or hold line at all: no acknowledgements, no narration of what you are doing. On a recording, menu or hold line, stay silent until a person speaks, however long it takes, except for a voicemail message explicitly permitted above. When a recording asks for a spoken answer, give only the short item it asks for (one to four words: the one the brief gives, or the obvious one from what you are calling about); follow the brief’s department route before asking for an agent; use only one answer to each prompt. When a person picks up after a recording or transfer, greet them and talk with them; never leave a voicemail message to a person.",
    `Brief for this call:\n${call.brief}`,
    identifierRule(call.brief),
  ].join('\n\n');
}

/** An error with its causes, so "fetch failed" names the network fault behind it. */
export function describe(e: unknown): string {
  const parts: string[] = [];
  for (let at: unknown = e, depth = 0; at && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    const { message, code } = at as { message?: string; code?: string };
    parts.push([code, message ?? String(at)].filter(Boolean).join(' '));
  }
  return parts.join(' <- ');
}
export const PHONE_TABLE = `CREATE TABLE IF NOT EXISTS kenan_phone_call(
  id uuid PRIMARY KEY, owner_id text NOT NULL, call_agent_id text NOT NULL, placed_by_id text NOT NULL, to_number text NOT NULL,
  token bytea NOT NULL, brief text NOT NULL, retell_agent_id text, provider_call_id text, live_session_id text,
  transcript text NOT NULL DEFAULT '', ended_at bigint, end_reason text, created_at bigint NOT NULL)`;
// to_number is the other party (NULL: an inbound caller who withheld their number); placed_by_id is the placing agent, or
// the owner's manager for inbound calls. callback_number is the line the voice may give, or NULL when it may give none;
// digits are keypad presses queued for the bridge; pending_replies are delegations the call agent has not answered yet,
// so the bridge does not hang up on a reply still being written. settled_at marks a call delivered to its agent: the row stays as history.
export const PHONE_COLUMNS = [
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS callback_number text, ADD COLUMN IF NOT EXISTS digits text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS direction text, ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS goal_id uuid, ADD COLUMN IF NOT EXISTS settled_at bigint`,
  `UPDATE kenan_phone_call SET direction='outbound' WHERE direction IS NULL`,
  `UPDATE kenan_phone_call SET name=to_number WHERE name IS NULL`,
  `ALTER TABLE kenan_phone_call ALTER COLUMN direction SET NOT NULL, ALTER COLUMN name SET NOT NULL, ALTER COLUMN to_number DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS kenan_phone_call_direction, ADD CONSTRAINT kenan_phone_call_direction CHECK (direction IN ('outbound','inbound') AND (direction = 'inbound' OR to_number IS NOT NULL))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kenan_phone_call_provider ON kenan_phone_call(provider_call_id)`,
  `CREATE INDEX IF NOT EXISTS kenan_phone_call_number ON kenan_phone_call(owner_id, to_number, created_at)`,
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS pending_replies text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS line_state text, ADD COLUMN IF NOT EXISTS line_state_at bigint, ADD COLUMN IF NOT EXISTS line_heard_at bigint`,
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS handoff boolean NOT NULL DEFAULT false`,
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS backend_context text NOT NULL DEFAULT ''`,
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS voicemail_allowed boolean NOT NULL DEFAULT false`,
  // Rows the constraint would refuse (a state a newer or older release wrote) lose only their live state, so a release
  // never fails to start on existing rows (Beta crash-looped on 2026-10-25 when an older statement re-added a narrower list).
  `UPDATE kenan_phone_call SET line_state=NULL WHERE line_state IS NOT NULL AND line_state NOT IN (${CALL_STATES.map(s => `'${s}'`).join(',')})`,
  `ALTER TABLE kenan_phone_call DROP CONSTRAINT IF EXISTS kenan_phone_call_line_state, ADD CONSTRAINT kenan_phone_call_line_state CHECK (line_state IS NULL OR line_state IN (${CALL_STATES.map(s => `'${s}'`).join(',')}))`,
];
export type PhoneRow = { id: string; owner_id: string; direction: Direction; name: string; goal_id: string | null; call_agent_id: string; placed_by_id: string; to_number: string | null; token: Buffer; brief: string; callback_number: string | null; digits: string; provider_call_id: string | null; live_session_id: string | null; transcript: string; ended_at: string | null; end_reason: string | null; created_at: string; settled_at: string | null; pending_replies: string[]; line_state: CallState | null; line_state_at: string | null; line_heard_at: string | null; handoff: boolean; voicemail_allowed: boolean };

/** delegations: when each arrived (ms), for reply latency; replies: when its first and last spoken chunk went out. */
type Attached = { sessionId: string; socket: SidebandWS; delegations: Map<string, number>; replies: Map<string, { first: number; chunks: number }> };
/** `unsayable`: the owner's private names this call's brief does not use; a reply sentence naming one is not spoken but
 *  kept in `withheld` for the agent that wrote it. */
export type PhoneCall = { id: string; ownerId: string; callAgentId: string; placedById: string; to: string | null; token: Buffer; attached: Attached | null; unsayable: RegExp | null; withheld: Map<string, string[]> };
/** The private names a call for this person with this brief may not say; null when the person has no telephone line. */
export function callUnsayable(person: PersonConfig, brief: string): RegExp | null {
  const telephone = telephoneConfig(mediaSettings(person).telephone);
  return telephone.kind === 'configured' ? unsayableNames(telephone.privateNames, brief) : null;
}
export const calls = new Map<string, PhoneCall>();
let pool: pg.Pool | undefined;
let logDir: string | undefined;
const callLog = (callId: string, name: string, detail: Record<string, unknown>) => {
  if (logDir) callEvent(logDir, callId, name, detail);
  else console.log(JSON.stringify({ event: name, call: callId, ...detail }));
};
let sweeper: ReturnType<typeof setInterval> | undefined;
let startFailure: string | null = null;
const database = () => { if (!pool) throw new Error(startFailure ? `phone_unavailable: the phone extension failed to start on this channel: ${startFailure}` : 'Phone calls are not started'); return pool; };
/** Where this person's call bridges run, and the spec a new one starts from. */
const hostOf = (person: PersonConfig): BridgeHost | null => {
  const telephone = telephoneConfig(mediaSettings(person).telephone);
  return telephone.kind === 'configured' ? bridgeHost(telephone.bridge) : null;
};
async function startCallBridge(deps: Deps, person: PersonConfig, telephone: ConfiguredTelephone, id: string, renderedBrief?: string): Promise<void> {
  const media = mediaSettings(person), live = liveConfig(media.live), host = bridgeHost(telephone.bridge);
  const template = renderedBrief === undefined ? (await database().query<Pick<PhoneRow, 'brief'>>('SELECT brief FROM kenan_phone_call WHERE id=$1', [id])).rows[0]?.brief : null;
  if (renderedBrief === undefined && template === undefined) throw new Error('call_brief_missing: no call brief');
  const brief = renderedBrief ?? await renderCallBrief(deps.config, person, template!);
  return startBridge(host, { ...bridgeSpec(deps.config, person, media, host, id, ariConfig(telephone.ariConfigPath), liveKey(live)), brief });
}

const DIAL_CONFIRM_MS = 15_000;

/** JMP's SIP account carries one outbound call at a time: a second dial is answered with "not supported on your account"
 *  and can get the route flagged (2026-10-28). So a line has at most one live outbound call, and a second `placeCall` is a
 *  typed `line_busy` error naming the live call. `dialling` closes the gap between the check and the row being written. */
const dialling = new Set<string>();
export async function reserveOutboundLine(query: (sql: string, args: unknown[]) => Promise<{ rows: { id: string; name: string; to_number: string; created_at: string }[] }>, ownerId: string, lineKey: string, now: number): Promise<() => void> {
  if (dialling.has(lineKey)) throw new Error(`line_busy: another outbound call on ${lineKey} is being dialled right now. The carrier allows one outbound call at a time; retry when it has ended.`);
  dialling.add(lineKey);
  const release = () => { dialling.delete(lineKey); };
  try {
    const live = (await query(`SELECT id, name, to_number, created_at FROM kenan_phone_call WHERE owner_id=$1 AND direction='outbound' AND ended_at IS NULL AND settled_at IS NULL AND created_at > $2 ORDER BY created_at LIMIT 1`, [ownerId, now - LIVE_OUTBOUND_MAX_MS])).rows[0];
    if (live) throw new Error(`line_busy: outbound call ${live.id} to ${live.name} (${live.to_number}) is still live on ${lineKey}, started ${Math.round((now - Number(live.created_at)) / 1000)} s ago. The carrier allows one outbound call at a time, so nothing was dialled; place this call when that one ends (voice list shows it, voice end hangs it up).`);
  } catch (e) { release(); throw e; }
  return release;
}
const LIVE_OUTBOUND_MAX_MS = 3 * 3600_000;

/** `uncertain`: the bridge did not confirm the dial in time; it carries on and the call agent receives the transcript or a
 *  "not placed" end. A call that certainly was not placed is a thrown error naming the session. */
export type PlacedCall =
  | { outcome: 'placed'; sessionId: string; callAgentId: string; conversationId: string; providerCallId: string }
  | { outcome: 'uncertain'; sessionId: string; callAgentId: string; conversationId: string; detail: string };

export async function placeCall(deps: Deps, person: PersonConfig, placedBy: AgentInfo, telephone: Extract<TelephoneConfig, { kind: 'configured' }>, args: { to: string; brief: string; name: string; callback: Callback; handoff: Handover; voicemail: 'none' | 'brief' }): Promise<PlacedCall> {
  if (!E164.test(args.to)) throw new Error('to must be an E.164 number such as +12025550113');
  if (!args.brief.trim()) throw new Error('brief is required');
  if (args.voicemail !== 'none' && args.voicemail !== 'brief') throw new Error('voicemail_required: choose none (no message) or brief (explicit permission to leave the message in the brief)');
  if (telephone.sip.outbound.kind === 'none') throw new Error(`${person.name}'s line ${telephone.fromNumber} cannot place calls yet: ${telephone.sip.outbound.why}`);
  const media = mediaSettings(person);
  liveConfig(media.live); voiceConfig(media.voice);
  const renderedBrief = await renderCallBrief(deps.config, person, args.brief);
  const releaseLine = await reserveOutboundLine((sql, a) => database().query(sql, a), person.id, telephone.fromNumber, Date.now());
  const id = randomUUID();
  const token = randomBytes(32);
  let callAgent: Awaited<ReturnType<typeof deps.store.createAgent>>;
  try { callAgent = await deps.store.createAgent({ originConversationId: originOf(placeOf(placedBy, deps.runtime.turnOf(placedBy.id))), id: randomUUID(), name: `Call: ${args.name}`, ownerId: person.id, parentAgentId: placedBy.id, role: 'worker', goalId: placedBy.goalId, model: person.worker.model, sessionPath: join(deps.config.dataDir, 'sessions', `call-${id}.jsonl`), conversationTitle: `Call: ${args.name}` }); } catch (e) { releaseLine(); throw e; }
  deps.bus.toPerson(person.id, { type: 'agent', agent: callAgent });
  const conversation = await deps.store.getConversation(callAgent.conversationId, person.id);
  if (conversation) deps.bus.toPerson(person.id, { type: 'conversation', conversation });
  try {
    await database().query(`INSERT INTO kenan_phone_call(id,owner_id,direction,name,goal_id,call_agent_id,placed_by_id,to_number,token,brief,callback_number,handoff,voicemail_allowed,created_at) VALUES($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, person.id, args.name, placedBy.goalId, callAgent.id, placedBy.id, args.to, token, args.brief, args.callback === 'kenan-line' ? telephone.fromNumber : null, args.handoff === 'owner', args.voicemail === 'brief', Date.now()]);
    releaseLine();
  } catch (e) {
    releaseLine();
    deps.runtime.deliver({ agentId: callAgent.id, kind: 'agent', fromId: 'system', conversationId: callAgent.conversationId, text: `The call to ${args.to} could not be recorded, so it was not placed: ${String(e)}. Report blocked with this error.` });
    throw e;
  }
  calls.set(id, { id, ownerId: person.id, callAgentId: callAgent.id, placedById: placedBy.id, to: args.to, token, attached: null, unsayable: unsayableNames(telephone.privateNames, renderedBrief), withheld: new Map() });
  deps.runtime.deliver({ agentId: callAgent.id, kind: 'human', fromId: placedBy.id, conversationId: callAgent.conversationId, text: `You are the call agent for an outbound phone call to ${args.name} (${args.to}), placed by ${placedBy.name} (${placedBy.id}) on ${person.name}'s behalf. Call session ${id}.\n${voicemailRule(args.voicemail === 'brief')}\nGPT Live speaks with the person and delegates requests to you mid-call. Answer each with voice(action="say", sessionId, delegationId, text): short, speakable guidance for what to say or do next. For permitted voicemail, supply only the complete message text, without a prefatory instruction to stay silent or wait for recording; GPT Live already has the greeting/recording rules and the actual line facts. A backend reply can arrive after the message has begun. When a phone menu asks for a key, press it with voice(action="digits", sessionId, delegationId, digits), e.g. digits "1" (w is a half-second pause): that answers the request silently, and nothing about a keypress may be spoken on the line, so never also voice say about it. The bridge itself presses the menu keys the brief names as the menu announces them, after the prompt finishes, and presses again if the menu replays; with no key left from the brief it picks the call's language and then the option that reaches a person (an agent, \"any other question\"). On a menu or in a hold queue the voice stays silent until a person picks up, so a long quiet stretch with no requests is normal: the call is waiting, not dead (voice list shows its state). ${MENU_SPEECH_RULE} Press another key with voice digits only if the menu offered it. To hang up, use voice(action="end", sessionId). ${args.callback === 'kenan-line' ? `The only callback number the caller may give is Kenan's line ${telephone.fromNumber}.` : 'The caller has no callback number to give on this call.'} Never supply a phone number, email, address or other contact detail that is not in the brief or verified in your records. Act in ${person.name}'s best interest, follow the brief on what may and may not be revealed, and never give a false answer to a material question. ${READBACK_RULE} ${identifierRule(renderedBrief)} On the line, name ${person.name} only as the brief names her or him (the brief may use a work or legal name), never by any other name; if the brief names nobody, say "the person I assist". The caller opens with the matter, not with who it is; if the person asks who is calling or whether they are speaking with ${person.name}, the truthful answer is ${person.name}'s assistant, never ${person.name}. If they will only deal with ${person.name}, get a time and number for ${person.name} to call them back, exactly what they need, and whether a written authorisation would let them deal with the assistant. A reply sentence with a private name the brief does not use is not spoken and comes back to you as withheld. You may use any tool during the call. ${pronounRule(person.pronouns, person.name)} Your run lasts as long as the call: between requests just end your turn, and do not report while the call is live (report refuses it). When the call ends you will receive the transcript; then do any follow-up the brief calls for and report done with the outcome and key transcript points.${args.handoff === 'owner' ? ` This is a handoff call: once a person picks up, ${person.name} is alerted at once by the system (its own push, at the level the line's settings choose; never send your own alert or notification to ${person.name} about this call) to call Kenan's line from their own phone, which joins them to this call; Kenan introduces them and leaves, and the transcript stops there. If ${person.name} has not joined two minutes after a person picked up, the voice asks for a direct way to reach that person and ends the call.` : ''}\n\nIdentity placeholders in this stored brief are already resolved for GPT Live before the call starts; do not ask it to look them up or read the placeholder words aloud.\n\nBrief:\n${args.brief}\n\nReply "ready" now; requests follow once the person answers.` });
  const session = { sessionId: id, callAgentId: callAgent.id, conversationId: callAgent.conversationId };
  // The end reason is recorded before the bridge is stopped, so its own "hung up by Kenan" never stands in for it.
  const notPlaced = async (why: string): Promise<never> => {
    const reason = `The call was not placed: ${why}`;
    await database().query(`UPDATE kenan_phone_call SET ended_at=$2, end_reason=$3 WHERE id=$1 AND ended_at IS NULL`, [id, Date.now(), reason]);
    await stopBridge(bridgeHost(telephone.bridge), id).catch(() => {});
    throw new Error(`${reason} (session ${id}). Nothing dialled, so a new call is safe.`);
  };
  try {
    await startCallBridge(deps, person, telephone, id, renderedBrief);
  } catch (e) {
    return notPlaced(describe(e));
  }
  // The bridge dials through Asterisk and records the channel it created, or the reason it could not.
  for (const deadline = Date.now() + DIAL_CONFIRM_MS; Date.now() < deadline; await new Promise(r => setTimeout(r, 100))) {
    const state = (await database().query<Pick<PhoneRow, 'provider_call_id' | 'ended_at' | 'end_reason'>>('SELECT provider_call_id, ended_at, end_reason FROM kenan_phone_call WHERE id=$1', [id])).rows[0];
    if (state?.provider_call_id) return { outcome: 'placed', ...session, providerCallId: state.provider_call_id };
    if (state?.ended_at) {
      if (/^the call was not placed/.test(state.end_reason ?? '')) throw new Error(`${state.end_reason} (session ${id}). Nothing dialled, so a new call is safe.`);
      return { outcome: 'uncertain', ...session, detail: `The call bridge ended before confirming the dial: ${state.end_reason}. The call agent receives the outcome.` };
    }
  }
  return { outcome: 'uncertain', ...session, detail: `The call bridge has not confirmed the dial within ${DIAL_CONFIRM_MS / 1000} s. It carries on: if the call connects it is handled as normal, otherwise it ends as not placed. Either way the call agent receives the outcome. Do not redial before then.` };
}

/** Backend reminders refer to this call's existing facts, not a fresh recording precondition. */
export const phoneReplyInstruction = (chunk: string): string => `Retain this verified backend answer independently of its spoken commentary: ${chunk} Interpret prerequisites against the facts already established on this call. In particular, once a mailbox is recording, a reminder to wait until recording starts is already satisfied; it never means stop an ongoing message or await a second beep. Keep completing the entire permitted voicemail from the brief while its remaining backend details arrive. Any correction in it remains a continuing task until you have stated the whole correct detail. If interrupted, answer briefly and then finish that correction; an introduction is not the correction. Do not repeat a detail already fully stated unless requested or read back incorrectly.`;

/** Speaks part of a reply to a delegation on this call; null when the delegation is not this call's. */
export function speaker(call: PhoneCall, delegationId: string): ((chunk: string) => void) | null {
  const attached = call.attached;
  const arrived = attached?.delegations.get(delegationId);
  if (!attached || arrived === undefined) return null;
  return chunk => {
    if (call.unsayable?.test(chunk)) {
      call.withheld.set(delegationId, [...(call.withheld.get(delegationId) ?? []), chunk]);
      callLog(call.id, 'phone-name-withheld', { delegation: delegationId, chars: chunk.length });
      return;
    }
    void database().query("UPDATE kenan_phone_call SET backend_context=right(backend_context || E'\\n' || $2, 16000) WHERE id=$1", [call.id, chunk]).catch(e => callLog(call.id, 'phone-context-error', { error: String(e) }));
    if (call.attached !== attached) {
      call.attached?.socket.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: null, content: `Verified backend answer from an earlier request: ${chunk}` });
      return;
    }
    // Commentary is an ephemeral speaking input. Keep the full verified content independently in Live's
    // instructions so an interruption cannot discard the rest of a correction or answer.
    attached.socket.send({ type: 'session.instructions.append', event_id: randomUUID(), delegation_id: null, content: phoneReplyInstruction(chunk) });
    attached.socket.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: delegationId, content: chunk });
    const reply = attached.replies.get(delegationId);
    if (reply) reply.chunks++;
    else {
      attached.replies.set(delegationId, { first: Date.now(), chunks: 1 });
      callLog(call.id, 'phone-reply-started', { delegation: delegationId, afterMs: Date.now() - arrived });
    }
  };
}
/** Reply sentences to this delegation that were not spoken because they named the owner by a private name. */
export function takeWithheld(call: PhoneCall, delegationId: string): string[] {
  const withheld = call.withheld.get(delegationId) ?? [];
  call.withheld.delete(delegationId);
  return withheld;
}
export function replied(call: PhoneCall, delegationId: string, streamed: number, length: number): void {
  const arrived = call.attached?.delegations.get(delegationId);
  const reply = call.attached?.replies.get(delegationId);
  if (arrived === undefined) return;
  void database().query('UPDATE kenan_phone_call SET pending_replies=array_remove(pending_replies, $2) WHERE id=$1', [call.id, delegationId])
    .catch(e => callLog(call.id, 'phone-pending-error', { delegation: delegationId, error: String(e) }));
  callLog(call.id, 'phone-reply-done', { delegation: delegationId, firstMs: reply ? reply.first - arrived : null, doneMs: Date.now() - arrived, chunks: reply?.chunks ?? 0, streamedChars: streamed, chars: length });
}

/** Answers a delegation on this call without speech (session.thinking.append): a keypress is never announced to the
 *  callee (call 10b48b42 said "J'ai pressé le 1" on the line). False when the delegation is not this call's. */
export function answerSilently(call: PhoneCall, delegationId: string, content: string): boolean {
  const attached = call.attached;
  if (!attached?.delegations.has(delegationId)) return false;
  void database().query("UPDATE kenan_phone_call SET backend_context=right(backend_context || E'\\n' || $2, 16000) WHERE id=$1", [call.id, content]).catch(e => callLog(call.id, 'phone-context-error', { error: String(e) }));
  attached.socket.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content });
  replied(call, delegationId, 0, 0);
  return true;
}

export async function pressDigits(call: PhoneCall, digits: Digits): Promise<void> {
  const row = (await database().query<Pick<PhoneRow, 'line_state' | 'transcript'>>('SELECT line_state, transcript FROM kenan_phone_call WHERE id=$1 AND ended_at IS NULL', [call.id])).rows[0];
  if (!row) throw new Error('The call has ended');
  const error = menuKeyError(row.line_state, row.transcript, digits);
  if (error) throw new Error(error);
  const { rowCount } = await database().query('UPDATE kenan_phone_call SET digits = digits || $2 WHERE id=$1 AND ended_at IS NULL', [call.id, digits]);
  if (!rowCount) throw new Error('The call has ended');
}

/** The live call this agent is the call agent for, if any: its run must last until the call has ended. */
export const liveCallOf = (agentId: string): PhoneCall | null => [...calls.values()].find(c => c.callAgentId === agentId) ?? null;

export async function hangUp(deps: Deps, call: PhoneCall): Promise<void> {
  const person = deps.person(call.ownerId);
  const host = person ? hostOf(person) : null;
  if (!host) throw new Error(`The call's owner ${call.ownerId} has no configured telephone`);
  await stopBridge(host, call.id);
}

function attach(deps: Deps, call: PhoneCall, sessionId: string, live: LiveConfig): void {
  const socket = new SidebandWS(liveClient(live, liveKey(live)), { session_id: sessionId, graceful_close: false }, { reconnect: null, maxQueueSize: 65536 });
  const attached: Attached = { sessionId, socket, delegations: new Map(), replies: new Map() };
  call.attached = attached;
  void (async () => {
    try {
      for await (const incoming of socket.stream({ maxBufferedEvents: 256 })) {
        if (call.attached !== attached) break;
        if (incoming.type !== 'message') continue;
        const event = incoming.message as { type: string; delegation?: { id: string; target: string; input?: unknown; instructions?: unknown } };
        if (event.type === 'session.delegation.created' && event.delegation?.target === 'client' && !attached.delegations.has(event.delegation.id)) {
          attached.delegations.set(event.delegation.id, Date.now());
          callLog(call.id, 'phone-delegation', { delegation: event.delegation.id });
          await database().query('UPDATE kenan_phone_call SET pending_replies=array_append(pending_replies, $2) WHERE id=$1 AND NOT ($2 = ANY(pending_replies))', [call.id, event.delegation.id]);
          const [row, agent] = await Promise.all([database().query<PhoneRow>('SELECT transcript FROM kenan_phone_call WHERE id=$1', [call.id]).then(r => r.rows[0]), deps.store.getAgent(call.callAgentId)]);
          if (agent) deps.runtime.deliver({ agentId: agent.id, kind: 'human', live: { delegationId: event.delegation.id }, fromId: call.placedById, conversationId: agent.conversationId, text: `${LIVE_REQUEST} Session ${call.id}; delegation ${event.delegation.id}.\nRequest: ${JSON.stringify(event.delegation)}\nTranscript so far:\n${(row?.transcript ?? '').slice(-6000)}` });
        }
        if (event.type === 'error') await deps.store.logError('phone', `live ${call.id}: ${JSON.stringify(event)}`);
        if (event.type === 'session.closed') break;
      }
    } catch (e) { await deps.store.logError('phone', `sideband ${call.id}: ${String(e)}`); }
    socket.close();
    if (call.attached === attached) call.attached = null;
  })();
}

async function finish(deps: Deps, call: PhoneCall, row: PhoneRow | undefined, summary: string): Promise<void> {
  calls.delete(call.id);
  call.attached?.socket.close();
  // A settled row is history: its handoff states become 'talking', which every release accepts, so rolling back past the
  // handoff release never meets a line state it does not know.
  await database().query(`UPDATE kenan_phone_call SET settled_at=$2, ended_at=COALESCE(ended_at,$2), end_reason=COALESCE(end_reason,$3), line_state=CASE WHEN line_state IN ('joining','handed-over') THEN 'talking' ELSE line_state END WHERE id=$1`, [call.id, Date.now(), summary]);
  const ended = `Call session ${call.id} has ended.\n${summary}\nTranscript:\n${row?.transcript || '(empty: nobody spoke)'}`;
  // The outcome always reaches a live run: the call agent, or the placing agent when the call agent's run is gone.
  const agent = await deps.store.getAgent(call.callAgentId);
  const placer = agent && !agent.archived ? null : await deps.store.getAgent(call.placedById);
  if (agent && !agent.archived) deps.runtime.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', conversationId: agent.conversationId, text: ended });
  else if (placer && !placer.archived) deps.runtime.deliver({ agentId: placer.id, kind: 'agent', fromId: 'system', ...await routeBackground(deps, placer, agent?.originConversationId ?? null), text: `The call agent for this call (${call.callAgentId}) is no longer running, so its outcome comes to you.\n${ended}` });
  else await deps.store.logError('phone', `call ${call.id} ended with no running call agent or placer to receive it`);
  const person = deps.person(call.ownerId);
  // Once the call's log is home, agents waiting on calls hear of it: topic phone-call:<kind>, body the call and its log.
  if (person && row) {
    const kind = row.direction === 'outbound' ? 'outbound'
      : row.to_number !== null && person.phones.includes(row.to_number) ? 'inbound-owner' : 'inbound';
    void Promise.resolve().then(async () => { const host = hostOf(person); if (host) await pullEdgeLogs(host); })
      .catch(e => deps.store.logError('phone', `call ${call.id}: edge log pull failed: ${String(e)}`))
      .then(() => queueHostEvent(EVENT_INBOX_ROOT, person.id, { topic: `phone-call:${kind}`, id: `phone-call:${call.id}`, body: { call: call.id, kind, name: row.name, channel: deps.config.channel, log: join(deps.config.dataDir, 'call-logs', `${call.id}.jsonl`) } }))
      .catch(e => deps.store.logError('phone', `call ${call.id}: call-ended event not queued: ${String(e)}`));
  }
}

/** A live call's state as the bridge last recorded it: what agents see in voice list and the heartbeat, so a healthy
 *  call on hold is never taken for a dead one (2026-10-23: a single failed edge check and two idle call agents read as
 *  a dead line, and voice end cut off a 311 agent mid-answer). */
export type LiveCall = { id: string; name: string; to: string | null; direction: Direction; state: CallState; stateForMs: number; heardAgoMs: number | null; ageMs: number; callAgentId: string; recentTranscript: string };
export async function liveCalls(ownerId: string, now = Date.now()): Promise<LiveCall[]> {
  if (!pool) return [];
  const rows = (await pool.query<PhoneRow>('SELECT * FROM kenan_phone_call WHERE owner_id=$1 AND ended_at IS NULL AND settled_at IS NULL ORDER BY created_at', [ownerId])).rows;
  return rows.map(row => ({
    id: row.id, name: row.name, to: row.to_number, direction: row.direction, callAgentId: row.call_agent_id, recentTranscript: row.transcript.slice(-6000),
    state: row.line_state ?? (row.direction === 'outbound' ? 'dialling' : 'connected'),
    stateForMs: now - Number(row.line_state_at ?? row.created_at), heardAgoMs: row.line_heard_at === null ? null : now - Number(row.line_heard_at), ageMs: now - Number(row.created_at),
  }));
}
const STATE_WORDS: Record<CallState, string> = { dialling: 'dialling, not answered yet', connected: 'connected', menu: 'in a phone menu', hold: 'on hold in a queue', talking: 'talking with a person', joining: 'a person is holding while the owner is asked to call in', 'handed-over': 'handed over: the owner has the call and Kenan has left', voicemail: 'leaving a voicemail' };
const span = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
export function describeLiveCall(call: LiveCall): string {
  return `${call.id.slice(0, 8)} ${call.direction} ${call.name}${call.to ? ` (${call.to})` : ''}: ${STATE_WORDS[call.state]} for ${span(call.stateForMs)}, call ${span(call.ageMs)} old, ${call.heardAgoMs === null ? 'no audio yet' : `audio ${span(call.heardAgoMs)} ago`}; call agent ${call.callAgentId.slice(0, 8)}`;
}

/** A placed call that has not connected this long after it was placed is raised to the placing agent and the manager at
 *  once, instead of waiting for someone to notice. The bridge itself gives up ringing after 60 s. */
export const STUCK_DIAL_MS = 75_000;
/** The edge is only reported unreachable once its state checks have failed this long and the call has no recent audio. */
export const EDGE_UNKNOWN_MS = 60_000;
const unknownSince = new Map<string, number>();
const raised = new Set<string>();

export async function sweep(deps: Deps): Promise<void> {
  const rows = (await database().query<PhoneRow>('SELECT * FROM kenan_phone_call WHERE settled_at IS NULL')).rows;
  for (const row of rows) {
    const owner = deps.person(row.owner_id);
    const call = calls.get(row.id) ?? { id: row.id, ownerId: row.owner_id, callAgentId: row.call_agent_id, placedById: row.placed_by_id, to: row.to_number, token: row.token, attached: null, unsayable: owner ? callUnsayable(owner, row.brief) : null, withheld: new Map() };
    calls.set(row.id, call);
    if (row.ended_at) { unknownSince.delete(row.id); await finish(deps, call, row, `Reason: ${row.end_reason ?? 'unknown'}.`); continue; }
    // A bridge that is stopping (voice end) still records its own end; only a unit that is gone has lost it.
    const person = deps.person(row.owner_id);
    const host = person ? hostOf(person) : null;
    const state = host ? await bridgeState(host, row.id) : { kind: 'gone' as const };
    const now = Date.now();
    if (state.kind === 'unknown') {
      const since = unknownSince.get(row.id) ?? now;
      unknownSince.set(row.id, since);
      const heardAgo = row.line_heard_at === null ? null : now - Number(row.line_heard_at);
      if (now - since > EDGE_UNKNOWN_MS && (heardAgo === null || heardAgo > EDGE_UNKNOWN_MS) && !raised.has(`edge:${row.id}`)) {
        raised.add(`edge:${row.id}`);
        await deps.store.logError('phone', `call ${row.id}: ${state.why} for ${Math.round((now - since) / 1000)} s and no audio recorded for ${heardAgo === null ? 'the whole call' : `${Math.round(heardAgo / 1000)} s`}; the call may still be live there, checked again every sweep`);
      }
      continue;
    }
    unknownSince.delete(row.id);
    // Key selection is a call action, not a speech trigger. GPT Live sometimes delegates no key at all; ask the
    // existing call agent directly instead of letting an unrecognised menu repeat indefinitely.
    if (row.line_state === 'menu' && !row.digits && now - Number(row.line_state_at ?? row.created_at) > 15_000) {
      const options = menuOptions(row.transcript);
      const menuId = `menu:${row.id}:${row.transcript.lastIndexOf('[Kenan pressed')}:${options.map(o => o.key).sort().join('')}`;
      if (options.length && !raised.has(menuId)) {
        const agent = await deps.store.getAgent(row.call_agent_id);
        if (agent && !agent.archived) {
          raised.add(menuId);
          callLog(row.id, 'phone-menu-choice', { options });
          deps.runtime.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', conversationId: agent.conversationId,
            text: `Call session ${row.id}: the phone menu has offered keypad options. If the current prompt requests speech, answer that prompt instead and do not press a key. Otherwise choose only a listed key using the call brief, then press it silently with voice(action="digits", sessionId="${row.id}", digits). Never guess an unoffered key such as 0. A menu offering a message is not a recording mailbox, even if an earlier line-state cue said voicemail. If no option fits, inspect the recent transcript and choose how to continue.\nOptions: ${JSON.stringify(options)}\nRecent transcript:\n${row.transcript.slice(-3500)}` });
        }
      }
    }
    if (row.handoff && row.line_state === 'joining' && !raised.has(`handoff:${row.id}`)) {
      raised.add(`handoff:${row.id}`);
      await callOwnerIn(deps, row);
    }
    if (row.direction === 'outbound' && (row.line_state ?? 'dialling') === 'dialling' && now - Number(row.created_at) > STUCK_DIAL_MS && !raised.has(`dial:${row.id}`)) {
      raised.add(`dial:${row.id}`);
      await raiseStuckDial(deps, row, state.kind);
    }
    if (state.kind === 'gone' && Date.now() - Number(row.created_at) > 15_000) {
      // The bridge records its end and then exits, so one that exited after this sweep read the row has its end recorded now.
      const now = (await database().query<PhoneRow>('SELECT * FROM kenan_phone_call WHERE id=$1', [row.id])).rows[0];
      if (!sweeper || now?.settled_at) continue;
      await finish(deps, call, now ?? row, now?.ended_at ? `Reason: ${now.end_reason ?? 'unknown'}.` : 'The call bridge exited without recording an end.');
      continue;
    }
    if (row.live_session_id && call.attached && row.live_session_id !== call.attached.sessionId) { call.attached.socket.close(); call.attached = null; }
    if (row.live_session_id && !call.attached && person) attach(deps, call, row.live_session_id, liveConfig(mediaSettings(person).live));
  }
}

/** A person picked up a handoff call: the owner is alerted at once to call Kenan's line, which joins them to the call
 *  (joinHandoff), and the call agent hears whether the alert reached a device. */
async function callOwnerIn(deps: Deps, row: PhoneRow): Promise<void> {
  const owner = deps.person(row.owner_id), agent = await deps.store.getAgent(row.call_agent_id);
  if (!owner || !agent) { await deps.store.logError('phone', `handoff call ${row.id}: no owner or call agent to alert`); return; }
  const telephone = telephoneConfig(mediaSettings(owner).telephone);
  if (telephone.kind !== 'configured' || telephone.handoff.kind !== 'call-in') { await deps.store.logError('phone', `handoff call ${row.id}: ${owner.name}'s line no longer takes handoff calls; the owner was not alerted`); return; }
  const line = spokenNumber(telephone.fromNumber).replace(/^\+1 /, '');
  callLog(row.id, 'handoff-alert', {});
  let outcome: string;
  if (telephone.handoff.alert === 'silent') outcome = `The line's handoff alert is silent (test setting), so ${owner.name} was not alerted; don't alert them yourself.`;
  else try {
    const sent = await notify(deps, owner.id, agent, agent.conversationId, { title: `Call Kenan now: ${row.name}`, body: `A person just picked up on your call to ${row.name}. Call Kenan's line (${line}) from your phone to join; Kenan introduces you and leaves.`, level: telephone.handoff.alert, imageFileId: null });
    outcome = sent.connectedPhones + sent.webAppDevices > 0 ? `${owner.name} was alerted (${telephone.handoff.alert} push to ${sent.connectedPhones} phone app${sent.connectedPhones === 1 ? '' : 's'} and ${sent.webAppDevices} web app${sent.webAppDevices === 1 ? '' : 's'}) to call Kenan's line to join.` : `The urgent alert reached no device of ${owner.name}'s (no phone app connected, no web app subscribed): reach them another way now if you can, or the voice will ask the person for a direct way back in two minutes.`;
  } catch (e) {
    outcome = `The urgent alert to ${owner.name} failed (${describe(e)}): send it yourself with notify (level urgent) at once, telling them to call Kenan's line to join.`;
    await deps.store.logError('phone', `handoff call ${row.id}: ${outcome}`);
  }
  deps.runtime.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', conversationId: agent.conversationId, text: `Call session ${row.id}: a person picked up and is holding for ${owner.name}. ${outcome}` });
}

/** The owner is calling Kenan's line from their own phone while a handoff call of theirs is live: that call takes the
 *  inbound channel (its bridge answers it and adds it to the call). The newest call waiting for them wins; null when none
 *  is live and past dialling. */
async function joinHandoff(person: PersonConfig, telephone: ConfiguredTelephone, channel: string): Promise<string | null> {
  const waiting = (await database().query<Pick<PhoneRow, 'id'>>(`SELECT id FROM kenan_phone_call WHERE owner_id=$1 AND direction='outbound' AND handoff AND ended_at IS NULL
    AND line_state IN ('connected','menu','hold','talking','joining') ORDER BY (line_state='joining') DESC, created_at DESC LIMIT 1`, [person.id])).rows[0];
  if (!waiting) return null;
  await ari(ariConfig(telephone.ariConfigPath), 'POST', `/channels/${encodeURIComponent(channel)}/move`, { app: `kenan-call-${waiting.id}`, appArgs: 'owner' });
  callLog(waiting.id, 'handoff-owner-calling', { channel });
  return waiting.id;
}

async function raiseStuckDial(deps: Deps, row: PhoneRow, bridge: 'running' | 'gone'): Promise<void> {
  const text = `Outbound call ${row.id} to ${row.name} (${row.to_number}) was placed ${Math.round((Date.now() - Number(row.created_at)) / 1000)} s ago and has not connected (bridge ${bridge}; provider channel ${row.provider_call_id ?? 'never created'}). Check the phone edge (asterisk -rx "pjsip show registrations", journalctl -u kenan-call-${row.id} on the edge) and the carrier, then end it with voice end if it is stuck.`;
  await deps.store.logError('phone', text);
  const owner = deps.person(row.owner_id);
  const targets = [row.placed_by_id, ...(owner ? [`manager:${owner.id}`] : [])];
  for (const id of new Set(targets)) {
    const agent = await deps.store.getAgent(id);
    if (agent && !agent.archived) deps.runtime.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', ...await routeBackground(deps, agent, null), text });
  }
  if (owner) await queueHostEvent(EVENT_INBOX_ROOT, owner.id, { topic: `phone-call:stuck`, id: `phone-call-stuck:${row.id}`, body: { call: row.id, name: row.name, to: row.to_number } }).catch(e => deps.store.logError('phone', `call ${row.id}: stuck-call event not queued: ${String(e)}`));
}

// ---------- inbound calls ----------
// Asterisk hands a call to one of Kenan's DIDs to the Stasis app `kenan-<channel>` of the channel that answers that line
// (the dialplan reads GLOBAL(KENAN_LINE_<digits>), which this channel sets whenever its event stream connects). The
// channel rings the caller, records the call and starts its bridge, which takes the Asterisk channel over and answers.
type ConfiguredTelephone = Extract<TelephoneConfig, { kind: 'configured' }>;
const answers = (telephone: TelephoneConfig, channel: string): telephone is ConfiguredTelephone => telephone.kind === 'configured' && telephone.inbound.kind === 'answered' && telephone.inbound.channel === channel;
export const lineVariable = (fromNumber: string) => `KENAN_LINE_${fromNumber.replace(/^\+/, '')}`;
// Distinguish the same channel on two hosts sharing one Asterisk edge.
export const inboundApp = (channel: string) => {
  const suffix = process.env.KENAN_PHONE_APP_SUFFIX;
  if (suffix && !/^[a-z0-9-]+$/.test(suffix)) throw new Error('Invalid KENAN_PHONE_APP_SUFFIX');
  return `kenan-${channel}${suffix ? `-${suffix}` : ''}`;
};
let household = new Map<string, HouseholdLine>();

export type InboundLine = { person: PersonConfig; telephone: ConfiguredTelephone };
/** The answered lines of this channel. */
export function answeredLines(deps: Deps): InboundLine[] {
  const lines: InboundLine[] = [];
  for (const person of deps.config.people) {
    if (person.manager && 'elsewhere' in person.manager) continue;
    if (!person.extensions.includes('voice')) continue;
    const telephone = telephoneConfig(mediaSettings(person).telephone);
    if (answers(telephone, deps.config.channel)) lines.push({ person, telephone });
  }
  return lines;
}

let inboundStream: { close: () => void } | null = null;
let inboundRetry: ReturnType<typeof setTimeout> | undefined;
function listenInbound(deps: Deps): void {
  const lines = answeredLines(deps);
  if (!lines.length) return;
  const asterisk = ariConfig(lines[0]!.telephone.ariConfigPath);
  const app = inboundApp(deps.config.channel);
  const retry = (why: string) => {
    inboundStream = null;
    void deps.store.logError('phone', `inbound calls: Asterisk ${why}; reconnecting`);
    inboundRetry = setTimeout(() => listenInbound(deps), 2000);
  };
  const stream = ariEvents(asterisk, app, event => { void inboundEvent(deps, answeredLines(deps), event); }, why => { if (inboundStream === stream) retry(why); });
  inboundStream = stream;
  stream.opened.then(async () => {
    for (const { telephone } of answeredLines(deps)) await ari(asterisk, 'POST', '/asterisk/variable', { variable: lineVariable(telephone.fromNumber), value: app });
  }).catch(e => { if (inboundStream === stream) { stream.close(); retry(String(e)); } });
}

/** Refresh after moving a person away, without dropping another person's listener or any live call bridge. */
export function refreshPhoneLines(deps: Deps): void {
  if (!pool) return;
  if (answeredLines(deps).length) {
    if (!inboundStream && !inboundRetry) listenInbound(deps);
    return;
  }
  clearTimeout(inboundRetry);
  inboundRetry = undefined;
  const stream = inboundStream;
  inboundStream = null;
  stream?.close();
}

async function inboundEvent(deps: Deps, lines: InboundLine[], event: AriEvent): Promise<void> {
  if (event.type !== 'StasisStart' || !event.channel) return;
  const [did, rawFrom] = event.args ?? [];
  const line = lines.find(l => l.telephone.fromNumber.replace(/^\+/, '') === did);
  const asterisk = ariConfig(lines[0]!.telephone.ariConfigPath);
  const channel = event.channel.id;
  if (!line) { await ari(asterisk, 'DELETE', `/channels/${encodeURIComponent(channel)}`, { reason: 'unallocated' }).catch(() => {}); return; }
  const from = callerE164(rawFrom ?? event.channel.caller?.number);
  try {
    await ari(asterisk, 'POST', `/channels/${encodeURIComponent(channel)}/ring`);
    await acceptInbound(deps, line, { providerCallId: channel, from });
  } catch (e) {
    await deps.store.logError('phone', `inbound ${channel} from ${from ?? 'withheld'}: ${describe(e)}`);
    await ari(asterisk, 'DELETE', `/channels/${encodeURIComponent(channel)}`, { reason: 'congestion' }).catch(() => {});
  }
}

type Earlier = Pick<PhoneRow, 'direction' | 'name' | 'goal_id' | 'placed_by_id' | 'call_agent_id' | 'brief' | 'transcript' | 'created_at' | 'end_reason'>;
const when = (ms: string) => new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/** A number that belongs to the household: someone's Kenan line, or their own phone. */
export type HouseholdLine = { kind: 'kenan-line' | 'own-phone'; personId: string; name: string };
/** Every person's own phones and every configured Kenan line; a person whose media settings cannot be read is named in `unreadable`. */
export function householdLines(people: PersonConfig[]): { lines: Map<string, HouseholdLine>; unreadable: { personId: string; error: string }[] } {
  const lines = new Map<string, HouseholdLine>(), unreadable: { personId: string; error: string }[] = [];
  for (const person of people) {
    for (const number of person.phones) lines.set(number, { kind: 'own-phone', personId: person.id, name: person.name });
    let telephone: TelephoneConfig;
    try { telephone = telephoneConfig(mediaSettings(person).telephone); } catch (e) { unreadable.push({ personId: person.id, error: String(e) }); continue; }
    if (telephone.kind !== 'configured') continue;
    lines.set(telephone.fromNumber, { kind: 'kenan-line', personId: person.id, name: person.name });
  }
  return { lines, unreadable };
}
const householdNote = (line: HouseholdLine) => line.kind === 'kenan-line'
  ? `This number is ${line.name}'s Kenan line: the caller is almost certainly ${line.name}'s Kenan, an AI assistant of the same household running on the same system as you, not a person. It usually calls to test the line or to pass something on. Ask what it needs, keep it short, and once that is done say goodbye clearly; do not wait for it to hang up.`
  : `This number is ${line.name}'s own phone: the caller is probably ${line.name}, a member of the household of the person you assist.`;

/** What the answering voice knows: whose number it is when it is the household's, the caller's earlier calls with Kenan,
 *  and the latest brief written for them. */
export function inboundBrief(from: string | null, earlier: Earlier[], line: HouseholdLine | null): string {
  const caller = from ? `Caller ID: ${spokenNumber(from)}.` : 'Caller ID: withheld.';
  const household = line ? householdNote(line) : '';
  const briefed = earlier.find(call => call.direction === 'outbound');
  const latest = earlier[0];
  const history = latest ? `This number has spoken with Kenan before. Kenan's calls with it, newest first: ${earlier.map(call => `${when(call.created_at)} ${call.direction} (${call.name})`).join('; ')}.` : 'Kenan has no earlier call with this number.';
  const lastWords = latest?.transcript ? `End of the transcript of the latest call (${when(latest.created_at)}):\n${latest.transcript.slice(-2500)}` : '';
  if (!briefed) return [
    caller,
    household,
    history,
    `Greet with a short bilingual "Bonjour, hello", say this is Kenan, and ask ${line ? 'what it is about' : 'who is calling and what it is about'}; then continue in their language. They may simply want to chat or demonstrate the voice; that is enough, so continue naturally. If they are calling about an ongoing matter, delegate so Kenan can match them and tell you what you may share. A claimed name alone does not establish that they are the person you assist or allow access to private information.`,
    lastWords,
  ].filter(Boolean).join('\n\n');
  return [
    caller,
    household,
    history,
    `They are probably ${briefed.name}, calling back. Greet them in the language of the brief below, say this is Kenan, ${latest!.direction === 'outbound' ? 'who called them earlier' : 'who answered their earlier call'} (thank them for calling back), and confirm who is calling. The brief below was written for Kenan's call to them: use its facts, its mind model of them and its limits on what may be shared, but you are now answering their call, so let them say why they are calling instead of reciting that call's goal.`,
    `Brief from Kenan's call to ${briefed.name} on ${when(briefed.created_at)}:\n${briefed.brief}`,
    lastWords,
  ].filter(Boolean).join('\n\n');
}

type Lane = { managerId: string; managerConversationId: string; callId: string; from: string; line: string };
const LANE_MESSAGES = 40, LANE_MESSAGE_CHARS = 1500, LANE_NOTES_CHARS = 400, LANE_WORKERS = 40;
function phoneLaneRole(person: PersonConfig, lane: Lane, context: string): string {
  return [
    `You are ${person.name}'s phone lane. ${person.name} is phoning Kenan's line ${lane.line} from their own phone (${lane.from}). Call session ${lane.callId}. You are a worker under ${lane.managerId}, their Kenaznia, which stays in charge of their goals and workers; you exist so they get answers in seconds instead of waiting on Kenaznia's very long context.`,
    `GPT Live answers as their assistant and delegates their requests to you. Answer each within seconds with voice(action="say", sessionId, delegationId, text), leading with the answer. If something needs more than a few seconds (a web search, several files), say so first with voice say, then answer with another.`,
    `Questions: answer from the context below and quick lookups (files, goals, workers peek, calendar, mail, texts, web search). Never invent; if you don't know, say so and offer to have Kenaznia find out.`,
    `Instructions, and anything that starts, changes or stops work (a new task, an order or purchase, a change to a goal or worker, a reminder, a message to someone), and every preference or correction they state: send it to ${lane.managerId} at once with workers message, in their words plus what you know, then tell them Kenaznia has it. Don't take on long work yourself while they wait.`,
    `voice(action="end", sessionId) hangs up when they ask. ${pronounRule(person.pronouns, person.name)} Your run lasts as long as the call; between requests just end your turn. When the call ends you receive the transcript: then report done with what they asked, what you answered, and everything ${lane.managerId} must act on or record (marking what you already sent).`,
    context,
    'Reply "ready" now; requests follow once the call connects.',
  ].join('\n\n');
}
const clip = (text: string, chars: number) => text.length > chars ? `${text.slice(0, chars)}…` : text;
type Said = Pick<Message, 'role' | 'text' | 'display' | 'createdAt'>;
/** What the owner and Kenaznia said to each other: shown words only, no tool output or silent agent turns. */
const exchanged = <T extends Said>(messages: T[]): T[] => messages.filter(m => m.display === 'shown' && (m.role === 'human' || m.role === 'assistant') && m.text.trim());
const VOICE_RECENT = 6, VOICE_RECENT_MS = 3 * 3_600_000, VOICE_MESSAGE_HEAD = 120, VOICE_MESSAGE_TAIL = 280;
/** A long message keeps its start and its end, where Kenaznia's question or request to the owner usually is. */
const headAndTail = (text: string) => text.length > VOICE_MESSAGE_HEAD + VOICE_MESSAGE_TAIL + 5 ? `${text.slice(0, VOICE_MESSAGE_HEAD)} … ${text.slice(-VOICE_MESSAGE_TAIL)}` : text;
/** The answering voice's share of the owner's recent conversation with Kenaznia: the last few messages of the last
 *  hours, short and plain. On 62a35157 (2026-11-02) Dave called because his Kenaznia had just asked him to test the
 *  line; the voice knew nothing of it (only the phone lane had the history) and took his "it works" for a complaint. */
export function ownerRecent(name: string, messages: Said[], now: number): string {
  const recent = exchanged(messages).filter(m => now - m.createdAt <= VOICE_RECENT_MS).slice(-VOICE_RECENT);
  if (!recent.length) return '';
  const plain = (text: string) => headAndTail(text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim());
  const ago = (at: number) => { const minutes = Math.max(0, Math.round((now - at) / 60_000)); return minutes < 1 ? 'just now' : `${minutes} min ago`; };
  return `What ${name} and Kenan said to each other in the app just before this call, oldest first. Kenan there is you, the same assistant. ${name} may well be calling about the latest of it (for example a test call Kenan asked for): pick it up naturally from there, and don't recite it.\n${recent.map(m => `- ${ago(m.createdAt)}, ${m.role === 'human' ? name : 'Kenan'}: ${plain(m.text)}`).join('\n')}`;
}
/** The phone lane's first instruction: its role, the owner's own context files (the manager's, less what every worker
 *  already has), Kenaznia's latest conversation with them, their open goals and active workers. */
export async function phoneLaneTask(deps: Deps, person: PersonConfig, profile: AgentProfile, lane: Lane): Promise<string> {
  const shared = new Set(person.worker.contextFiles);
  const [files, page, goals, agents] = await Promise.all([
    Promise.all(profile.contextFiles.filter(file => !shared.has(file)).map(readContext)),
    deps.store.listMessages(lane.managerConversationId, { kind: 'latest' }, 600),
    deps.store.listGoals(person.id, 'open'),
    deps.store.listAgents(person.id),
  ]);
  const said = exchanged(page.messages).slice(-LANE_MESSAGES);
  const workers = agents.filter(a => a.role === 'worker' && a.state !== 'stopped' && a.id !== lane.managerId).slice(-LANE_WORKERS);
  const goalTitle = new Map(goals.map(goal => [goal.id, goal.title]));
  return phoneLaneRole(person, lane, [
    files.some(Boolean) ? `${person.name}'s own context, as Kenaznia has it:${files.join('')}` : '',
    said.length ? `Kenaznia's latest conversation with ${person.name}, oldest first:\n${said.map(m => `[${new Date(m.createdAt).toISOString().slice(0, 16)}Z] ${m.role === 'human' ? person.name : 'Kenaznia'}: ${clip(m.text.trim(), LANE_MESSAGE_CHARS)}`).join('\n')}` : '',
    goals.length ? `Open goals (goals get ID for the full notes):\n${goals.map(goal => `- ${goal.id} [p${goal.priority}] ${goal.title}${goal.notes ? `\n  Notes: ${clip(goal.notes.replace(/\s+/g, ' '), LANE_NOTES_CHARS)}` : ''}`).join('\n')}` : 'No open goals.',
    workers.length ? `Active workers (workers peek ID shows what one is doing):\n${workers.map(w => `- ${w.id} ${w.name}: ${w.state}${w.goalId ? `, goal ${goalTitle.get(w.goalId) ?? w.goalId}` : ''}`).join('\n')}` : 'No active workers.',
  ].filter(Boolean).join('\n\n'));
}

const accepting = new Map<string, Promise<void>>();
/** Answers an inbound call: a call agent under the owner's manager and a bridge that takes the Asterisk channel over. One attempt per channel. */
export function acceptInbound(deps: Deps, line: InboundLine, args: { providerCallId: string; from: string | null }): Promise<void> {
  const pending = accepting.get(args.providerCallId);
  if (pending) return pending;
  const attempt = answerInbound(deps, line, args);
  accepting.set(args.providerCallId, attempt);
  void attempt.catch(() => {}).finally(() => setTimeout(() => accepting.delete(args.providerCallId), 60_000).unref());
  return attempt;
}

async function answerInbound(deps: Deps, { person, telephone }: InboundLine, args: { providerCallId: string; from: string | null }): Promise<void> {
  const answered = (await database().query<PhoneRow>('SELECT id FROM kenan_phone_call WHERE provider_call_id=$1', [args.providerCallId])).rows[0];
  if (answered) return;
  const media = mediaSettings(person);
  liveConfig(media.live); voiceConfig(media.voice);
  const managerId = `manager:${person.id}`;
  const manager = await deps.store.getAgent(managerId);
  if (!manager) throw new Error(`${person.name} has no manager to answer calls for`);
  const id = randomUUID();
  const token = randomBytes(32);
  const record = (call: { name: string; goalId: string | null; callAgentId: string; placedById: string; brief: string }) => {
    calls.set(id, { id, ownerId: person.id, callAgentId: call.callAgentId, placedById: call.placedById, to: args.from, token, attached: null, unsayable: unsayableNames(telephone.privateNames, call.brief), withheld: new Map() });
    return database().query(`INSERT INTO kenan_phone_call(id,owner_id,direction,name,goal_id,call_agent_id,placed_by_id,to_number,token,brief,callback_number,provider_call_id,created_at) VALUES($1,$2,'inbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, person.id, call.name, call.goalId, call.callAgentId, call.placedById, args.from, token, call.brief, telephone.fromNumber, args.providerCallId, Date.now()]);
  };
  const newCallAgent = async (name: string, goalId: string | null) => {
    const agent = await deps.store.createAgent({ originConversationId: null, id: randomUUID(), name: `Call: ${name}`, ownerId: person.id, parentAgentId: managerId, role: 'worker', goalId, model: person.worker.model, sessionPath: join(deps.config.dataDir, 'sessions', `call-${id}.jsonl`), conversationTitle: `Call: ${name}` });
    deps.bus.toPerson(person.id, { type: 'agent', agent });
    const conversation = await deps.store.getConversation(agent.conversationId, person.id);
    if (conversation) deps.bus.toPerson(person.id, { type: 'conversation', conversation });
    return agent;
  };
  if (args.from !== null && person.phones.includes(args.from) && await joinHandoff(person, telephone, args.providerCallId)) return;
  if (args.from !== null && person.phones.includes(args.from)) {
    // The owner's own calls get a phone lane: a call agent with the owner's context, a short history and quick tools,
    // which answers in seconds, instead of Kenaznia, whose half-million-token context took 8-12 s per answer (714bd84f).
    const profile = hostedManager(person);
    if (!profile) throw new Error(`${person.name}'s manager is not hosted on this channel`);
    const name = `${person.name} (owner)`;
    // The latest few messages are one indexed read (milliseconds); the lane's longer context is read after answering.
    const [callAgent, latest] = await Promise.all([newCallAgent(name, null), deps.store.listMessages(manager.conversationId, { kind: 'latest' }, 40)]);
    const brief = [
      `Caller ID: ${spokenNumber(args.from)}, ${person.name}'s own phone. The caller is ${person.name}, the person you assist. Pick up like a friend who works with them: a quick, bright hello by name in English (for example \"Hey ${person.name}!\" or \"Hi ${person.name}, what\'s up?\"), with no introduction and no \"how can I help\"; then help with whatever they ask; delegate anything you cannot answer from what they say.`,
      ownerRecent(person.name, latest.messages, Date.now()),
    ].filter(Boolean).join('\n\n');
    await record({ name, goalId: null, callAgentId: callAgent.id, placedById: managerId, brief });
    // The task carries the owner's context and recent history; reading them must not hold up answering.
    const lane = { managerId, managerConversationId: manager.conversationId, callId: id, from: args.from, line: telephone.fromNumber };
    void phoneLaneTask(deps, person, profile, lane).then(
      text => deps.runtime.deliver({ agentId: callAgent.id, kind: 'human', fromId: managerId, conversationId: callAgent.conversationId, text }),
      async e => {
        await deps.store.logError('phone', `phone lane context for ${id}: ${String(e)}`);
        deps.runtime.deliver({ agentId: callAgent.id, kind: 'human', fromId: managerId, conversationId: callAgent.conversationId, text: phoneLaneRole(person, lane, `Your context could not be loaded (${String(e)}): read ${person.name}'s context files and current state yourself when a request needs them.`) });
      });
  } else {
    const earlier = args.from ? (await database().query<Earlier>(`SELECT direction,name,goal_id,placed_by_id,call_agent_id,brief,transcript,created_at,end_reason FROM kenan_phone_call
      WHERE owner_id=$1 AND to_number=$2 AND id<>$3 ORDER BY created_at DESC LIMIT 5`, [person.id, args.from, id])).rows : [];
    const recent = (await database().query<{ to_number: string; name: string; goal_id: string | null; placed_by_id: string; created_at: string }>(`SELECT DISTINCT ON (to_number) to_number,name,goal_id,placed_by_id,created_at FROM kenan_phone_call
      WHERE owner_id=$1 AND direction='outbound' AND created_at > $2 ORDER BY to_number, created_at DESC`, [person.id, Date.now() - 14 * 86_400_000])).rows;
    const openGoals = new Set((await deps.store.listGoals(person.id, 'open')).map(goal => goal.id));
    const goalId = earlier.map(call => call.goal_id).find((goal): goal is string => goal !== null && openGoals.has(goal)) ?? null;
    const known = earlier.find(call => call.direction === 'outbound');
    const line = args.from ? household.get(args.from) ?? null : null;
    const name = known ? `${known.name} (calling in)` : line ? `${line.name}'s ${line.kind === 'kenan-line' ? 'Kenan line' : 'phone'}` : `Caller ${args.from ? spokenNumber(args.from) : '(number withheld)'}`;
    const brief = inboundBrief(args.from, earlier, line);
    const callAgent = await newCallAgent(name, goalId);
    await record({ name, goalId, callAgentId: callAgent.id, placedById: managerId, brief });
    const history = earlier.length
      ? `Earlier calls with this number, newest first:\n${earlier.map(call => `- ${when(call.created_at)} ${call.direction} "${call.name}": goal ${call.goal_id ?? 'none'}, placed by ${call.placed_by_id}, call agent ${call.call_agent_id}, ended: ${call.end_reason ?? 'unknown'}`).join('\n')}`
      : 'Kenan has no earlier call with this number.';
    const outbound = recent.length ? `Kenan's outbound calls in the last 14 days (latest per number), to match a caller who rings from another number:\n${recent.map(call => `- ${call.name} ${call.to_number}: goal ${call.goal_id ?? 'none'}, placed by ${call.placed_by_id}, ${when(call.created_at)}`).join('\n')}` : '';
    const lines = [...household].filter(([number]) => number !== telephone.fromNumber).map(([number, l]) => `- ${number}: ${l.name}'s ${l.kind === 'kenan-line' ? `Kenan line (${l.name}'s own Kenaznia and agents call from it)` : 'own phone'}`);
    deps.runtime.deliver({ agentId: callAgent.id, kind: 'human', fromId: managerId, conversationId: callAgent.conversationId, text: [
      `You are the call agent for an inbound phone call: ${args.from ?? 'a withheld number'} is calling Kenan's line ${telephone.fromNumber}, which ${person.name}'s Kenan answers. Call session ${id}. You are a worker under ${managerId}${goalId ? `, on goal ${goalId}` : ''}.`,
      line ? `The caller's number is ${line.name}'s ${line.kind === 'kenan-line' ? `Kenan line: the caller is almost certainly ${line.name}'s Kenan (an AI assistant on this same system; its manager is manager:${line.personId}), not a person` : `own phone: the caller is probably ${line.name}${line.personId === person.id ? '' : `. If ${line.name} has their own Kenaznia among your peers (peer tool), pass anything meant for it there; their texts to this line already go to it`}`}.` : '',
      `GPT Live answers as Kenan, finds out who is calling and why, and delegates to you mid-call. A person is waiting on the line, so answer each request within seconds with voice(action="say", sessionId, delegationId, text): short, speakable guidance. If you need longer, say so first ("tell them I'm checking, one moment"), then answer. To hang up, use voice(action="end", sessionId).`,
      INBOUND_CONVERSATION_RULE,
      voiceIdentity(telephone.voice),
      `For a caller with an ongoing matter, match them using the earlier calls below, the household's lines, the open goals (goals list) and their workers, the call briefs those calls were placed from, and ${person.name}'s own notes (their personal context and current state of the world). Once matched, tell the voice what it may share with this caller, drawn from that matter's briefs and records. Answer ordinary conversation directly without looking up private records. If you do not know a fact, say so rather than guess. Take a message (name, how to reach them, what it is about) only when the caller requests it or an actual matter needs follow-up. A caller claiming the owner's name from an unknown number is not authenticated by that claim; keep the unknown-caller privacy limits.`,
      `Rules, the same as outbound calls: never supply a phone number, email, address or other detail that is not verified in your records; share nothing about ${person.name} beyond what this caller needs for their matter; on the line name ${person.name} only as the matter's briefs name her or him (a work or legal name), never by any other name (a reply sentence with a private name the call's brief does not use is not spoken and comes back to you as withheld); never give a false answer to a material question on ${person.name}'s behalf (if one needs her, take the question exactly and bring it to ${managerId}). The only callback number the voice may give is this line, ${telephone.fromNumber}. If something needs ${managerId} during the call (an offer, a deadline, a decision), send it now with workers message to ${managerId}.`,
      READBACK_RULE,
      `When the call ends you receive the transcript. Then: record the outcome with the owning goal (goals update notes) and pass the transcript to the owning worker if it is still active (workers message); do any follow-up the call needs; and report done with who called, why, what was said and agreed, and anything ${managerId} must act on.`,
      history,
      lines.length ? `The household's other lines:\n${lines.join('\n')}` : '',
      outbound,
      `What the voice was told about this caller:\n${brief}`,
      'Reply "ready" now; requests follow once the call connects.',
    ].filter(Boolean).join('\n\n') });
  }
  try {
    await startCallBridge(deps, person, telephone, id);
  } catch (e) {
    await stopBridge(bridgeHost(telephone.bridge), id).catch(() => {});
    await database().query(`UPDATE kenan_phone_call SET ended_at=$2, end_reason=$3 WHERE id=$1 AND ended_at IS NULL`, [id, Date.now(), `The inbound call could not be answered (the caller was refused, and the carrier sends the call to its voicemail): ${String(e)}`]);
    throw e;
  }
}

export async function startPhone(deps: Deps): Promise<void> {
  pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2 });
  logDir = callLogDirectory(deps.config.dataDir, Date.now());
  const lines = householdLines(deps.config.people);
  household = lines.lines;
  for (const { personId, error } of lines.unreadable) await deps.store.logError('phone', `household lines: ${personId}'s telephone settings are unreadable: ${error}`);
  try {
    await applySchema(pool, 'phone', [PHONE_TABLE, ...PHONE_COLUMNS]);
  } catch (e) {
    startFailure = describe(e);
    throw e;
  }
  startFailure = null;
  listenInbound(deps);
  let running = false;
  sweeper = setInterval(() => {
    if (running) return;
    running = true;
    sweep(deps).catch(e => deps.store.logError('phone', String(e))).finally(() => { running = false; });
  }, SWEEP_MS);
}

export async function stopPhone(): Promise<void> {
  clearInterval(sweeper);
  sweeper = undefined;
  clearTimeout(inboundRetry);
  inboundStream?.close();
  inboundStream = null;
  for (const call of calls.values()) call.attached?.socket.close();
  calls.clear();
  await pool?.end();
  pool = undefined;
}
