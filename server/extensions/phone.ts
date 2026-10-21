// Telephone calls, outbound and inbound. Retell carries the PSTN leg only: a silent per-call Retell agent holds the line
// until the bridge process (phone-bridge.ts, its own systemd unit so calls survive Kenan restarts) takes the call over and
// relays audio to GPT Live. GPT Live delegates to a dedicated Kenan call agent (full tools) through the sideband attached
// here. Outbound call agents are briefed by the placing agent; inbound ones are children of the owner's manager, briefed
// from the caller's earlier calls. Each call is a kenan_phone_call row: live state until settled, then call history.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import type { AgentInfo } from '../../shared/contract.js';
import { hostedManager, type AgentProfile, type PersonConfig } from '../config.js';
import { readContext } from '../agents/context-files.js';
import type { Deps } from '../types.js';
import type { Digits } from './phone-dtmf.js';
import { callEvent, callLogDirectory } from './phone-log.js';

/** Which channel answers the line's inbound calls; the other channel leaves the number's inbound route alone. */
/** ownerNumbers are the owner's own phones: their calls are the owner talking to her assistant, delegated to her manager. */
export type InboundConfig = { kind: 'answered'; channel: string; ownerNumbers: string[] } | { kind: 'unanswered' };
export type TelephoneConfig =
  | { kind: 'configured'; provider: 'retell-live'; apiKeyPath: string; fromNumber: string; publicBaseUrl: string; maxCallSeconds: number; inbound: InboundConfig; privateNames: string[] }
  | { kind: 'unavailable'; factor: string };
export type LiveConfig = { kind: 'configured'; apiKeyPath: string; project: string | null; organization: string | null; timeoutMs: number; model: string };
export type VoiceConfig = { kind: 'configured'; instructions: string; delegationPolicy: string; voice: string };

const E164 = /^\+[1-9]\d{7,14}$/;
/** Heads every live delegation an agent receives: a person hears nothing until the reply starts, and it is spoken as it is written. */
export const LIVE_REQUEST = 'Live request: a person is waiting on the line. Call voice at once with its arguments in this order: action "say", sessionId, delegationId, then text (all four are required: a call without action fails and costs the caller seconds); each sentence is spoken as soon as you write it, so lead with the answer. If you must look something up first, say so briefly with voice say, then answer with another voice say. A keypad request is answered with voice(action="digits", sessionId, delegationId, digits) instead, which is silent. After the reply, end your turn without further text unless work remains.';
const SWEEP_MS = 1_000;
const run = promisify(execFile);

export const mediaSettings = (person: PersonConfig) => person.extensionConfigPath ? JSON.parse(readFileSync(person.extensionConfigPath, 'utf8')).media : {};

export function telephoneConfig(raw: unknown): TelephoneConfig {
  const t = raw as Record<string, unknown> | undefined;
  if (!t || t.kind === 'unavailable') return { kind: 'unavailable', factor: typeof t?.factor === 'string' ? t.factor : 'Telephone is not configured' };
  if (t.kind !== 'configured' || t.provider !== 'retell-live' || (['apiKeyPath', 'fromNumber', 'publicBaseUrl'] as const).some(k => typeof t[k] !== 'string' || !t[k]) || !E164.test(t.fromNumber as string) || !Number.isInteger(t.maxCallSeconds) || (t.maxCallSeconds as number) < 60) {
    throw new Error('Invalid media.telephone configuration');
  }
  const inbound = t.inbound as Record<string, unknown> | undefined;
  if (!(inbound?.kind === 'unanswered' || (inbound?.kind === 'answered' && typeof inbound.channel === 'string' && inbound.channel && Array.isArray(inbound.ownerNumbers) && inbound.ownerNumbers.every(n => typeof n === 'string' && E164.test(n))))) throw new Error('media.telephone.inbound must be {"kind":"answered","channel":CHANNEL,"ownerNumbers":[E164...]} or {"kind":"unanswered"}');
  if (!Array.isArray(t.privateNames) || t.privateNames.length === 0 || t.privateNames.some(n => typeof n !== 'string' || !/^\p{L}[\p{L}' -]*$/u.test(n))) throw new Error('media.telephone.privateNames must list the owner\'s names a call may never say unless its brief uses them, e.g. ["Alice"]');
  return t as TelephoneConfig;
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
export const liveClient = (live: LiveConfig) => new OpenAI({ apiKey: readFileSync(live.apiKeyPath, 'utf8').trim(), project: live.project, organization: live.organization, maxRetries: 0, timeout: live.timeoutMs });

/** Whether the caller may give Kenan's own line as a callback number; the placing agent decides per call. */
export type Callback = 'kenan-line' | 'none';
export const spokenNumber = (e164: string) => e164.startsWith('+1') && e164.length === 12 ? `+1 ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}` : e164;

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
const NAME_RULE = 'Names: you know the person you assist only by the name the brief gives them. Use exactly that name (or the part of it the brief uses), never any other name, nickname or variant, and never guess one. If the brief gives them no name, name nobody: say you are Kenan, an AI assistant, calling for the person you assist, and delegate if someone asks who that is.';

/** The owner's private names (media.telephone.privateNames) that this brief does not use, so the call may not say them. */
export function unsayableNames(privateNames: string[], brief: string): RegExp | null {
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const banned = privateNames.filter(name => !new RegExp(`(?<![\\p{L}])${escape(name)}(?![\\p{L}])`, 'iu').test(brief));
  return banned.length ? new RegExp(`(?<![\\p{L}])(?:${banned.map(escape).join('|')})(?![\\p{L}])`, 'iu') : null;
}

export type Direction = 'outbound' | 'inbound';
export type PromptCall = { direction: Direction; brief: string; callbackNumber: string | null; startedAt: Date };

const CONTACT_RULE = 'Contact details: never say a phone number, email address, street address, website, account, file or reference number, or any other identifier unless it appears word for word in the brief or in an answer you receive from Kenan during the call. Never make one up, guess one, or repeat a number the other person said as if it were yours.';
const TRUTH_RULE = 'If asked whether you are an AI, say yes. Never give a false answer to a material question: delegate anything you do not know or need to check, decide or do, and say briefly that you are checking. The backend you delegate to is Kenan with full tools, context and the brief.';
// Call 488e7d78: the person cut in while Kenan gave the offer address, Kenan heard "Quelle heure maintenant" and gave the
// time (an hour off, from the brief), twice, and the person hung up.
const HEARING_RULE = 'Mishearing a person (this is never about recordings, menus or mailboxes): phone audio is poor and you will sometimes mishear what a person says, so judge it against the conversation before answering. When they cut in while you are giving a detail (an email, number, date, address or name), they most likely missed it: say that detail again, slowly. When their words do not fit what was just said, do not answer the words you heard: say what you think they mean and check ("Pardon, vous voulez l\'adresse courriel ?"), or ask them to repeat. When they ask again the question you just answered, you misheard it or your answer missed: do not give the same answer again; say what else they might mean and ask. (Asking you to repeat, like « pardon ? », is different: then say it again, clearly.)';
const NORTH_AMERICA: [string, string][] = [['Montréal, Toronto, New York', 'America/Toronto'], ['Halifax', 'America/Halifax'], ['Winnipeg, Chicago', 'America/Chicago'], ['Calgary, Denver', 'America/Denver'], ['Vancouver, San Francisco, Los Angeles', 'America/Los_Angeles']];
/** The time the call started, in the zones its people are in, so a question about the time gets the real one. */
export function clockRule(at: Date): string {
  const zones = NORTH_AMERICA.map(([places, zone]) => `${places}: ${new Intl.DateTimeFormat('en-CA', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)}`);
  return `Clock: this call started at ${at.toISOString().slice(0, 16)} UTC, which is ${zones.join('; ')}. Count the minutes since if you need the time now, and give it in the other person's place. This clock overrides any time the brief gives.`;
}
// Call 4533751d (2026-10-21): an English brief to a Canadian 343 number opened "Bonjour, ici Kenan" and stayed in French;
// the prompt said nothing about language, and its French examples, Montréal clock and Canadian line were all it had.
const LANGUAGES: Record<string, string> = { english: 'English', anglais: 'English', french: 'French', français: 'French', francais: 'French', spanish: 'Spanish', espagnol: 'Spanish', español: 'Spanish', turkish: 'Turkish', turc: 'Turkish', türkçe: 'Turkish', german: 'German', allemand: 'German' };
const EXPLICIT_LANGUAGE = /\b(?:language|langue)\s*:\s*(\p{L}+)|\b(?:speak|parle[rz]?)\s+(?:in\s+|en\s+)?(english|french|spanish|turkish|german|anglais|français|francais|espagnol|turc|allemand)\b/iu;
const STOPWORDS = {
  English: new Set('the and is are you your to of for with that this on not it he she they we be have has will about from what who when'.split(' ')),
  French: new Set('le la les des est vous votre une un pour avec que qui je nous et du au aux ce cette sur pas il elle ils dans son sa ses'.split(' ')),
};
/** The language a call is held in: the one its brief names explicitly, else the one it is written in; null when neither is clear. */
export function briefLanguage(brief: string): string | null {
  const named = EXPLICIT_LANGUAGE.exec(brief);
  const word = (named?.[1] ?? named?.[2])?.toLowerCase();
  if (word && LANGUAGES[word]) return LANGUAGES[word]!;
  const words = brief.normalize('NFC').toLowerCase().split(/[^\p{L}']+/u);
  const counts = Object.entries(STOPWORDS).map(([language, set]) => [language, words.filter(w => set.has(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [first, second] = counts;
  return first![1] >= 3 && first![1] >= 2 * second![1] ? first![0] : null;
}
export function languageRule(brief: string, direction: Direction): string {
  const language = briefLanguage(brief);
  const start = direction === 'outbound'
    ? (language ? `Language: speak ${language} from your first word, because the brief is in ${language}.` : 'Language: speak the language the brief is written in from your first word.')
    : 'Language: greet in the language the brief says to greet in.';
  return `${start} The moment the other person speaks to you in another language (they answer in French, for example), switch to their language for your very next sentence and stay in it; that is the only reason to switch. Never choose a language from the phone number, its area code or region, the clock, or the examples in these rules.`;
}
const MIND_RULE = 'Before you speak and throughout, simulate the other person: what they want, fear, know and are incentivised by, and how they are hearing you right now; adjust to them rather than reciting a goal. This is a phone line, so keep turns short and natural.';

export function phoneInstructions(person: PersonConfig, voice: VoiceConfig, call: PromptCall): string {
  if (call.direction === 'inbound') return [
    `You are Kenan, an AI assistant, answering a call to Kenan's own phone line${call.callbackNumber ? `, ${spokenNumber(call.callbackNumber)}` : ''}. Someone dialed this line and you pick up. Say Kenan as keh-NAAN.`,
    voice.instructions,
    `Delegation policy:\n${voice.delegationPolicy}`,
    languageRule(call.brief, 'inbound'),
    NAME_RULE,
    pronounRule(person.pronouns, 'the person you assist'),
    `Phone rules: ${MIND_RULE} You speak first: as soon as you are told the caller is connected, greet them briefly as Kenan, an AI assistant, and ask who is calling (the brief says which language to greet in). Find out who they are and why they are calling, then help them: answer from the brief, and delegate everything else at once (Kenan matches callers to earlier calls and ongoing matters, and can check, decide or act). ${TRUTH_RULE} Never say anything about the person you assist beyond what this caller needs and the brief allows: until you know who is calling and why, do not name them or describe their affairs. If a question cannot be answered now, take a message: the caller's name, how best to reach them (read a number or email back to confirm it), and what it is about; say Kenan will pass it on and follow up. When the caller is done, say a clear goodbye and stop talking; the line closes a few seconds after your goodbye.`,
    HEARING_RULE,
    clockRule(call.startedAt),
    CONTACT_RULE,
    call.callbackNumber ? `Callback number: the caller already has this line. If asked how to reach you again, the only number you may give is this line, ${spokenNumber(call.callbackNumber)}.` : 'Callback number: give no phone number.',
    `Brief for this call:\n${call.brief}`,
  ].join('\n\n');
  return [
    'You are Kenan, an AI assistant, on an outbound phone call Kenan placed on behalf of the person you assist. Say Kenan as keh-NAAN.',
    voice.instructions,
    `Delegation policy:\n${voice.delegationPolicy}`,
    languageRule(call.brief, 'outbound'),
    `Phone rules: ${MIND_RULE} Wait for the person to answer and greet you, then introduce yourself. Their hello often comes before you join the line, so you may not hear it: when Kenan tells you the person is waiting for you to speak, greet them at once. ${TRUTH_RULE} When the goal is complete or the person wants to end, say a clear goodbye and stop talking; the line closes automatically a few seconds after your goodbye.`,
    HEARING_RULE,
    clockRule(call.startedAt),
    NAME_RULE,
    pronounRule(person.pronouns, 'the person you assist'),
    CONTACT_RULE,
    call.callbackNumber
      ? `Callback number: if someone needs a number to call back, the only one you may give is Kenan's line, ${spokenNumber(call.callbackNumber)}. Give no other phone number as ours.`
      : 'Callback number: you have no phone number to give for this call. If someone asks how to reach you, offer the contact route the brief gives (for example an email address in the brief); if it gives none, say Kenan will follow up, and delegate the question.',
    "Recordings and machines: when a recording answers (a voicemail greeting, a phone menu, or a hold or transfer message), do not talk over it. After a voicemail greeting, stay silent until the mailbox is recording: Kenan listens to the line for the beep and tells you the moment it is recording (at the beep, or when a greeting without one has ended), and if you hear the beep yourself, it is recording already. Then leave the brief's voicemail message once, clearly and briefly, and say goodbye, even if the mailbox plays more instructions after its beep (such as how to re-record or press a key): those are part of the mailbox, not a person. On a phone menu, Kenan presses the keys the brief names by itself as soon as the menu announces them, and tells you; for any other key you need, delegate it (for example \"press 1 for French\") as soon as you hear it; Kenan presses it. Delegating a key is silent: say nothing before, while or after you delegate it (no \"je m'en occupe\", no \"c'est fait\", no \"I pressed 1\"); a key is never announced on the line. Never speak to a recording, menu or hold line at all: no acknowledgements, no narration of what you are doing. On a recording, menu or hold line, stay silent until a person speaks, however long it takes, except to leave a voicemail message. When a person picks up after a recording or transfer, greet them and talk with them; never leave a voicemail message to a person.",
    `Brief for this call:\n${call.brief}`,
  ].join('\n\n');
}

/** A failed Retell request. `unsent`: it never reached Retell (no connection was made), so it had no effect.
 *  `unknown`: it may have reached Retell (lost response, timeout, server error), so its effect must be looked up. */
export class RetellError extends Error {
  constructor(message: string, readonly reach: 'rejected' | 'unsent' | 'unknown', readonly status: number | null) { super(message); }
}
const UNSENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** An error with its causes, so "fetch failed" names the network fault behind it. */
export function describe(e: unknown): string {
  const parts: string[] = [];
  for (let at: unknown = e, depth = 0; at && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    const { message, code } = at as { message?: string; code?: string };
    parts.push([code, message ?? String(at)].filter(Boolean).join(' '));
  }
  return parts.join(' <- ');
}
function causeCode(e: unknown): string | undefined {
  for (let at: unknown = e, depth = 0; at && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export async function retell<T>(apiKey: string, path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  let response: Response, text: string;
  try {
    response = await fetch(`https://api.retellai.com${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    text = await response.text();
  } catch (e) {
    throw new RetellError(`Retell ${method} ${path}: ${describe(e)}`, UNSENT.has(causeCode(e) ?? '') ? 'unsent' : 'unknown', null);
  }
  if (!response.ok) throw new RetellError(`Retell ${method} ${path} HTTP ${response.status}: ${text.slice(0, 500)}`, response.status >= 500 ? 'unknown' : 'rejected', response.status);
  return (text ? JSON.parse(text) : null) as T;
}

/** The call Retell placed with this session's own carrier agent, or null when it has none. */
export async function findProviderCall(apiKey: string, agentId: string): Promise<string | null> {
  const found = await retell<{ call_id: string }[]>(apiKey, '/v2/list-calls', 'POST', { filter_criteria: { agent_id: [agentId] }, limit: 5 });
  if (!Array.isArray(found)) throw new Error('Retell list-calls returned no list');
  return found[0]?.call_id ?? null;
}

export const PHONE_TABLE = `CREATE TABLE IF NOT EXISTS kenan_phone_call(
  id uuid PRIMARY KEY, owner_id text NOT NULL, call_agent_id text NOT NULL, placed_by_id text NOT NULL, to_number text NOT NULL,
  token bytea NOT NULL, brief text NOT NULL, retell_agent_id text, provider_call_id text, live_session_id text,
  transcript text NOT NULL DEFAULT '', ended_at bigint, end_reason text, created_at bigint NOT NULL)`;
// to_number is the other party (NULL: an inbound caller who withheld their number); placed_by_id is the placing agent, or
// the owner's manager for inbound calls. callback_number is the line the voice may give, or NULL when it may give none;
// digits are keypad presses queued for the bridge; pending_replies are delegations the call agent has not answered yet,
// so the bridge does not hang up on a reply still being written. settled_at marks a call delivered to its agent: the row stays as history.
const PHONE_COLUMNS = [
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS callback_number text, ADD COLUMN IF NOT EXISTS digits text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS direction text, ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS goal_id uuid, ADD COLUMN IF NOT EXISTS settled_at bigint`,
  `UPDATE kenan_phone_call SET direction='outbound' WHERE direction IS NULL`,
  `UPDATE kenan_phone_call SET name=to_number WHERE name IS NULL`,
  `ALTER TABLE kenan_phone_call ALTER COLUMN direction SET NOT NULL, ALTER COLUMN name SET NOT NULL, ALTER COLUMN to_number DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS kenan_phone_call_direction, ADD CONSTRAINT kenan_phone_call_direction CHECK (direction IN ('outbound','inbound') AND (direction = 'inbound' OR to_number IS NOT NULL))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kenan_phone_call_provider ON kenan_phone_call(provider_call_id)`,
  `CREATE INDEX IF NOT EXISTS kenan_phone_call_number ON kenan_phone_call(owner_id, to_number, created_at)`,
  `ALTER TABLE kenan_phone_call ADD COLUMN IF NOT EXISTS pending_replies text[] NOT NULL DEFAULT '{}'`,
];
export type PhoneRow = { id: string; owner_id: string; direction: Direction; name: string; goal_id: string | null; call_agent_id: string; placed_by_id: string; to_number: string | null; token: Buffer; brief: string; callback_number: string | null; digits: string; retell_agent_id: string | null; provider_call_id: string | null; live_session_id: string | null; transcript: string; ended_at: string | null; end_reason: string | null; created_at: string; settled_at: string | null; pending_replies: string[] };

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
const database = () => { if (!pool) throw new Error('Phone calls are not started'); return pool; };
const unit = (id: string) => `kenan-call-${id}`;

export type Placement = { kind: 'placed'; callId: string } | { kind: 'not-placed'; why: string } | { kind: 'uncertain'; why: string };
/** Asks Retell to dial with this session's own carrier agent. A request that may have reached Retell is settled by
 *  looking the call up by that agent, so a lost response never reads as "not placed". */
export async function dial(apiKey: string, agentId: string, request: Record<string, unknown>, pauseMs = 1500): Promise<Placement> {
  try {
    return { kind: 'placed', callId: (await retell<{ call_id: string }>(apiKey, '/v2/create-phone-call', 'POST', request)).call_id };
  } catch (e) {
    if (!(e instanceof RetellError) || e.reach !== 'unknown') return { kind: 'not-placed', why: describe(e) };
    let lookup: { kind: 'found'; callId: string } | { kind: 'none' } | { kind: 'failed' } = { kind: 'failed' };
    for (let attempt = 0; attempt < 3 && lookup.kind !== 'found'; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, pauseMs));
      lookup = await findProviderCall(apiKey, agentId).then(callId => callId ? { kind: 'found' as const, callId } : { kind: 'none' as const }, () => ({ kind: 'failed' as const }));
    }
    if (lookup.kind === 'found') return { kind: 'placed', callId: lookup.callId };
    return { kind: 'uncertain', why: 'Placing the call failed in a way that may still have dialled (' + e.message + '); ' + (lookup.kind === 'none' ? 'Retell lists no call for it yet.' : 'Retell could not be asked whether it dialled.') };
  }
}

/** `uncertain`: Retell may have dialled; the bridge keeps looking for the call and the call agent receives the transcript
 *  or a "not placed" end. A call that certainly was not placed is a thrown error naming the session. */
export type PlacedCall =
  | { outcome: 'placed'; sessionId: string; callAgentId: string; conversationId: string; providerCallId: string }
  | { outcome: 'uncertain'; sessionId: string; callAgentId: string; conversationId: string; detail: string };

export async function placeCall(deps: Deps, person: PersonConfig, placedBy: AgentInfo, telephone: Extract<TelephoneConfig, { kind: 'configured' }>, args: { to: string; brief: string; name: string; callback: Callback }): Promise<PlacedCall> {
  if (!E164.test(args.to)) throw new Error('to must be an E.164 number such as +15105550100');
  if (!args.brief.trim()) throw new Error('brief is required');
  const media = mediaSettings(person);
  liveConfig(media.live); voiceConfig(media.voice);
  const apiKey = readFileSync(telephone.apiKeyPath, 'utf8').trim();
  const id = randomUUID();
  const token = randomBytes(32);
  const callAgent = await deps.store.createAgent({ id: randomUUID(), name: `Call: ${args.name}`, ownerId: person.id, parentAgentId: placedBy.id, role: 'worker', goalId: placedBy.goalId, model: person.worker.model, sessionPath: join(deps.config.dataDir, 'sessions', `call-${id}.jsonl`), conversationTitle: `Call: ${args.name}` });
  deps.bus.toPerson(person.id, { type: 'agent', agent: callAgent });
  const conversation = await deps.store.getConversation(callAgent.conversationId, person.id);
  if (conversation) deps.bus.toPerson(person.id, { type: 'conversation', conversation });
  try {
    await database().query(`INSERT INTO kenan_phone_call(id,owner_id,direction,name,goal_id,call_agent_id,placed_by_id,to_number,token,brief,callback_number,created_at) VALUES($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, person.id, args.name, placedBy.goalId, callAgent.id, placedBy.id, args.to, token, args.brief, args.callback === 'kenan-line' ? telephone.fromNumber : null, Date.now()]);
  } catch (e) {
    deps.runtime.deliver({ agentId: callAgent.id, kind: 'agent', fromId: 'system', conversationId: callAgent.conversationId, text: `The call to ${args.to} could not be recorded, so it was not placed: ${String(e)}. Report blocked with this error.` });
    throw e;
  }
  calls.set(id, { id, ownerId: person.id, callAgentId: callAgent.id, placedById: placedBy.id, to: args.to, token, attached: null, unsayable: unsayableNames(telephone.privateNames, args.brief), withheld: new Map() });
  deps.runtime.deliver({ agentId: callAgent.id, kind: 'human', fromId: placedBy.id, conversationId: callAgent.conversationId, text: `You are the call agent for an outbound phone call to ${args.name} (${args.to}), placed by ${placedBy.name} (${placedBy.id}) on ${person.name}'s behalf. Call session ${id}.\nGPT Live speaks with the person and delegates requests to you mid-call. Answer each with voice(action="say", sessionId, delegationId, text): short, speakable guidance for what to say or do next. When a phone menu asks for a key, press it with voice(action="digits", sessionId, delegationId, digits), e.g. digits "1" (w is a half-second pause): that answers the request silently, and nothing about a keypress may be spoken on the line, so never also voice say about it. The bridge itself presses the menu keys the brief names as the menu announces them, after the prompt finishes, and presses again if the menu replays. To hang up, use voice(action="end", sessionId). ${args.callback === 'kenan-line' ? `The only callback number the caller may give is Kenan's line ${telephone.fromNumber}.` : 'The caller has no callback number to give on this call.'} Never supply a phone number, email, address or other contact detail that is not in the brief or verified in your records. Act in ${person.name}'s best interest, follow the brief on what may and may not be revealed, and never give a false answer to a material question. On the line, name ${person.name} only as the brief names her or him (the brief may use a work or legal name), never by any other name; if the brief names nobody, say "the person I assist". A reply sentence with a private name the brief does not use is not spoken and comes back to you as withheld. You may use any tool during the call. ${pronounRule(person.pronouns, person.name)} Your run lasts as long as the call: between requests just end your turn, and do not report while the call is live (report refuses it). When the call ends you will receive the transcript; then do any follow-up the brief calls for and report done with the outcome and key transcript points.\n\nBrief:\n${args.brief}\n\nReply "ready" now; requests follow once the person answers.` });
  const session = { sessionId: id, callAgentId: callAgent.id, conversationId: callAgent.conversationId };
  // The end reason is recorded before the bridge is stopped, so its own "hung up by Kenan" never stands in for it.
  const notPlaced = async (why: string): Promise<never> => {
    const reason = `The call was not placed: ${why}`;
    await database().query(`UPDATE kenan_phone_call SET ended_at=$2, end_reason=$3 WHERE id=$1 AND ended_at IS NULL`, [id, Date.now(), reason]);
    await run('systemctl', ['stop', unit(id)]).catch(() => {});
    throw new Error(`${reason} (session ${id}). Nothing dialled, so a new call is safe.`);
  };
  let agentId: string;
  try {
    const [, agent] = await Promise.all([
      run('systemd-run', ['--expand-environment=no', '--unit', unit(id), '--collect', '--quiet', '--property=KillMode=mixed', '--property=TimeoutStopSec=15', process.execPath, fileURLToPath(new URL('./phone-bridge.js', import.meta.url)), process.argv[2]!, id]),
      retell<{ agent_id: string }>(apiKey, '/create-agent', 'POST', carrierAgent(`Kenan silent carrier ${id}`, `${telephone.publicBaseUrl.replace(/^http/, 'ws')}/kenan/${deps.config.channel}/hooks/voice/phone/${id}/${token.toString('hex')}/silent`, telephone)),
    ]);
    agentId = agent.agent_id;
    await database().query('UPDATE kenan_phone_call SET retell_agent_id=$2 WHERE id=$1', [id, agentId]);
  } catch (e) {
    return notPlaced(describe(e));
  }
  const placement = await dial(apiKey, agentId, { from_number: telephone.fromNumber, to_number: args.to, override_agent_id: agentId, metadata: { kenan_session: id, channel: deps.config.channel, owner: person.id } });
  if (placement.kind === 'not-placed') return notPlaced(placement.why);
  if (placement.kind === 'uncertain') return { outcome: 'uncertain', ...session, detail: placement.why + ' The call bridge keeps looking for 90 seconds: if the call exists it is handled as normal, otherwise it ends as not placed. Either way the call agent receives the outcome. Do not redial before then.' };
  const providerCallId = placement.callId;
  await database().query('UPDATE kenan_phone_call SET provider_call_id=$2 WHERE id=$1', [id, providerCallId]);
  return { outcome: 'placed', ...session, providerCallId };
}

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
  attached.socket.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content });
  replied(call, delegationId, 0, 0);
  return true;
}

export async function pressDigits(call: PhoneCall, digits: Digits): Promise<void> {
  const { rowCount } = await database().query('UPDATE kenan_phone_call SET digits = digits || $2 WHERE id=$1 AND ended_at IS NULL', [call.id, digits]);
  if (!rowCount) throw new Error('The call has ended');
}

/** The live call this agent is the call agent for, if any: its run must last until the call has ended. */
export const liveCallOf = (agentId: string): PhoneCall | null => [...calls.values()].find(c => c.callAgentId === agentId) ?? null;

export async function hangUp(call: PhoneCall): Promise<void> {
  await run('systemctl', ['stop', unit(call.id)]);
}

function attach(deps: Deps, call: PhoneCall, sessionId: string, live: LiveConfig): void {
  const socket = new SidebandWS(liveClient(live), { session_id: sessionId, graceful_close: false }, { reconnect: null, maxQueueSize: 65536 });
  const attached: Attached = { sessionId, socket, delegations: new Map(), replies: new Map() };
  call.attached = attached;
  void (async () => {
    try {
      for await (const incoming of socket.stream({ maxBufferedEvents: 256 })) {
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
  await database().query('UPDATE kenan_phone_call SET settled_at=$2, ended_at=COALESCE(ended_at,$2), end_reason=COALESCE(end_reason,$3) WHERE id=$1', [call.id, Date.now(), summary]);
  const ended = `Call session ${call.id} has ended.\n${summary}\nTranscript:\n${row?.transcript || '(empty: nobody spoke)'}`;
  // The outcome always reaches a live run: the call agent, or the placing agent when the call agent's run is gone.
  const agent = await deps.store.getAgent(call.callAgentId);
  const placer = agent && !agent.archived ? null : await deps.store.getAgent(call.placedById);
  if (agent && !agent.archived) deps.runtime.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', conversationId: agent.conversationId, text: ended });
  else if (placer && !placer.archived) deps.runtime.deliver({ agentId: placer.id, kind: 'agent', fromId: 'system', conversationId: placer.conversationId, text: `The call agent for this call (${call.callAgentId}) is no longer running, so its outcome comes to you.\n${ended}` });
  else await deps.store.logError('phone', `call ${call.id} ended with no running call agent or placer to receive it`);
  const person = deps.person(call.ownerId);
  const telephone = person ? telephoneConfig(mediaSettings(person).telephone) : null;
  if (row?.retell_agent_id && telephone?.kind === 'configured') await retell(readFileSync(telephone.apiKeyPath, 'utf8').trim(), `/delete-agent/${row.retell_agent_id}`, 'DELETE').catch(() => {});
}

export async function sweep(deps: Deps): Promise<void> {
  const rows = (await database().query<PhoneRow>('SELECT * FROM kenan_phone_call WHERE settled_at IS NULL')).rows;
  for (const row of rows) {
    const owner = deps.person(row.owner_id);
    const call = calls.get(row.id) ?? { id: row.id, ownerId: row.owner_id, callAgentId: row.call_agent_id, placedById: row.placed_by_id, to: row.to_number, token: row.token, attached: null, unsayable: owner ? callUnsayable(owner, row.brief) : null, withheld: new Map() };
    calls.set(row.id, call);
    if (row.ended_at) { await finish(deps, call, row, `Reason: ${row.end_reason ?? 'unknown'}.`); continue; }
    // A bridge that is stopping (voice end) still records its own end; only a unit that is gone has lost it.
    const state = await run('systemctl', ['is-active', unit(row.id)]).then(r => r.stdout.trim(), (e: { stdout?: string }) => String(e.stdout ?? '').trim());
    const active = state === 'active' || state === 'activating' || state === 'deactivating' || state === 'reloading';
    if (!active && Date.now() - Number(row.created_at) > 15_000) { await finish(deps, call, row, 'The call bridge exited without recording an end.'); continue; }
    const person = deps.person(row.owner_id);
    if (row.live_session_id && !call.attached && person) attach(deps, call, row.live_session_id, liveConfig(mediaSettings(person).live));
  }
}

// ---------- inbound calls ----------
// Retell asks the number's inbound webhook which agent should answer, before connecting the call (10 s per attempt, up
// to three attempts, then the number's fallback inbound agent). The webhook path carries a capability derived from the
// Retell key, so no other secret is stored; the reply names a fresh silent carrier agent, exactly as outbound calls use.
export const inboundCapability = (apiKey: string, channel: string, personId: string) => createHmac('sha256', apiKey).update(`kenan-inbound:${channel}:${personId}`).digest('hex');
const inboundUrl = (telephone: ConfiguredTelephone, channel: string, capability: string) => `${telephone.publicBaseUrl}/kenan/${channel}/hooks/voice/phone/inbound/${capability}`;
type ConfiguredTelephone = Extract<TelephoneConfig, { kind: 'configured' }>;
const answers = (telephone: TelephoneConfig, channel: string): telephone is ConfiguredTelephone => telephone.kind === 'configured' && telephone.inbound.kind === 'answered' && telephone.inbound.channel === channel;

// Inbound calls are answered by one standing silent carrier agent per answered line, so the webhook replies without
// creating a Retell agent first. Its socket path carries a capability like the webhook's; it serves every inbound call.
const carrierCapability = (apiKey: string, channel: string, personId: string) => createHmac('sha256', apiKey).update(`kenan-carrier:${channel}:${personId}`).digest('hex');
const carriers = new Map<string, string>();
let household = new Map<string, HouseholdLine>();
const carrierTokens: Buffer[] = [];
let inboundReady: Promise<void> = Promise.resolve();
type RetellAgent = { agent_id: string; agent_name?: string | null; post_call_analysis_model?: string | null; response_engine?: { type?: string; llm_websocket_url?: string } };
// A silent carrier's own call is only its seconds before take-over; Retell's default analysis model billed US$2.08 per call to summarise it.
const CARRIER_ANALYSIS_MODEL = 'gpt-4.1-mini';
const carrierAgent = (name: string, url: string, telephone: ConfiguredTelephone) => ({
  agent_name: name, response_engine: { type: 'custom-llm', llm_websocket_url: url }, post_call_analysis_model: CARRIER_ANALYSIS_MODEL,
  voice_id: 'retell-Cimo', language: 'en-US', max_call_duration_ms: telephone.maxCallSeconds * 1000, data_storage_setting: 'everything', data_storage_retention_days: 1,
});

/** Points each answered line's inbound webhook at this channel and ensures its standing carrier agent; idempotent, run at startup. */
async function reconcileInboundRoute(deps: Deps): Promise<void> {
  for (const person of deps.config.people) {
    if (!person.extensions.includes('voice')) continue;
    const telephone = telephoneConfig(mediaSettings(person).telephone);
    if (!answers(telephone, deps.config.channel)) continue;
    const apiKey = readFileSync(telephone.apiKeyPath, 'utf8').trim();
    const capability = carrierCapability(apiKey, deps.config.channel, person.id);
    const name = `Kenan inbound carrier ${deps.config.channel} ${person.id}`;
    const socket = `${telephone.publicBaseUrl.replace(/^http/, 'ws')}/kenan/${deps.config.channel}/hooks/voice/phone/carrier/${capability}/silent`;
    const named = (await retell<RetellAgent[]>(apiKey, '/list-agents', 'GET')).filter(agent => agent.agent_name === name);
    const current = named.find(agent => agent.response_engine?.llm_websocket_url === socket) ?? await retell<RetellAgent>(apiKey, '/create-agent', 'POST', carrierAgent(name, socket, telephone));
    for (const stale of named) if (stale.agent_id !== current.agent_id) await retell(apiKey, `/delete-agent/${stale.agent_id}`, 'DELETE').catch(() => {});
    if (current.post_call_analysis_model !== CARRIER_ANALYSIS_MODEL) await retell(apiKey, `/update-agent/${current.agent_id}`, 'PATCH', { post_call_analysis_model: CARRIER_ANALYSIS_MODEL });
    carriers.set(person.id, current.agent_id);
    carrierTokens.push(Buffer.from(capability, 'hex'));
    const url = inboundUrl(telephone, deps.config.channel, inboundCapability(apiKey, deps.config.channel, person.id));
    const number = await retell<{ inbound_webhook_url?: string | null }>(apiKey, `/get-phone-number/${encodeURIComponent(telephone.fromNumber)}`, 'GET');
    if (number.inbound_webhook_url !== url) await retell(apiKey, `/update-phone-number/${encodeURIComponent(telephone.fromNumber)}`, 'PATCH', { inbound_webhook_url: url });
  }
}

export type InboundLine = { person: PersonConfig; telephone: ConfiguredTelephone };
/** The person whose answered line was dialed, when the webhook's capability is theirs; null otherwise. */
export function inboundLine(deps: Deps, toNumber: string, capability: string): InboundLine | null {
  if (!/^[a-f0-9]{64}$/.test(capability)) return null;
  for (const person of deps.config.people) {
    if (!person.extensions.includes('voice')) continue;
    const telephone = telephoneConfig(mediaSettings(person).telephone);
    if (!answers(telephone, deps.config.channel) || telephone.fromNumber !== toNumber) continue;
    const expected = Buffer.from(inboundCapability(readFileSync(telephone.apiKeyPath, 'utf8').trim(), deps.config.channel, person.id), 'hex');
    if (timingSafeEqual(expected, Buffer.from(capability, 'hex'))) return { person, telephone };
  }
  return null;
}

type Earlier = Pick<PhoneRow, 'direction' | 'name' | 'goal_id' | 'placed_by_id' | 'call_agent_id' | 'brief' | 'transcript' | 'created_at' | 'end_reason'>;
const when = (ms: string) => new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/** A number that belongs to the household: someone's Kenan line, or their own phone. */
export type HouseholdLine = { kind: 'kenan-line' | 'own-phone'; personId: string; name: string };
/** Every configured person's Kenan line and own phones; a person whose media settings cannot be read is named in `unreadable`. */
export function householdLines(people: PersonConfig[]): { lines: Map<string, HouseholdLine>; unreadable: { personId: string; error: string }[] } {
  const lines = new Map<string, HouseholdLine>(), unreadable: { personId: string; error: string }[] = [];
  for (const person of people) {
    let telephone: TelephoneConfig;
    try { telephone = telephoneConfig(mediaSettings(person).telephone); } catch (e) { unreadable.push({ personId: person.id, error: String(e) }); continue; }
    if (telephone.kind !== 'configured') continue;
    lines.set(telephone.fromNumber, { kind: 'kenan-line', personId: person.id, name: person.name });
    if (telephone.inbound.kind === 'answered') for (const number of telephone.inbound.ownerNumbers) lines.set(number, { kind: 'own-phone', personId: person.id, name: person.name });
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
    `Greet with a short bilingual "Bonjour, hello", say you are Kenan, an AI assistant, and ask ${line ? 'what it is about' : 'who is calling and what it is about'}; then continue in their language. Many callers on this line are people Kenan contacted about ongoing matters (for example a sale, a permit application or a course enrolment); once they say what it is about, delegate at once so Kenan can match them and tell you what you may share.`,
    lastWords,
  ].filter(Boolean).join('\n\n');
  return [
    caller,
    household,
    history,
    `They are probably ${briefed.name}, calling back. Greet them in the language of the brief below, say you are Kenan, the AI assistant who ${latest!.direction === 'outbound' ? 'called them' : 'answered their earlier call'}, and confirm who is calling. The brief below was written for Kenan's call to them: use its facts, its mind model of them and its limits on what may be shared, but you are now answering their call, so let them say why they are calling instead of reciting that call's goal.`,
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
  const said = page.messages.filter(m => m.display === 'shown' && (m.role === 'human' || m.role === 'assistant') && m.text.trim()).slice(-LANE_MESSAGES);
  const workers = agents.filter(a => a.role === 'worker' && a.state !== 'stopped' && a.id !== lane.managerId).slice(-LANE_WORKERS);
  const goalTitle = new Map(goals.map(goal => [goal.id, goal.title]));
  return phoneLaneRole(person, lane, [
    `${person.name}'s own context, as Kenaznia has it:${files.join('')}`,
    said.length ? `Kenaznia's latest conversation with ${person.name}, oldest first:\n${said.map(m => `[${new Date(m.createdAt).toISOString().slice(0, 16)}Z] ${m.role === 'human' ? person.name : 'Kenaznia'}: ${clip(m.text.trim(), LANE_MESSAGE_CHARS)}`).join('\n')}` : '',
    goals.length ? `Open goals (goals get ID for the full notes):\n${goals.map(goal => `- ${goal.id} [p${goal.priority}] ${goal.title}${goal.notes ? `\n  Notes: ${clip(goal.notes.replace(/\s+/g, ' '), LANE_NOTES_CHARS)}` : ''}`).join('\n')}` : 'No open goals.',
    workers.length ? `Active workers (workers peek ID shows what one is doing):\n${workers.map(w => `- ${w.id} ${w.name}: ${w.state}${w.goalId ? `, goal ${goalTitle.get(w.goalId) ?? w.goalId}` : ''}`).join('\n')}` : 'No active workers.',
  ].filter(Boolean).join('\n\n'));
}

const accepting = new Map<string, Promise<string>>();
/** Answers an inbound call: a call agent under the owner's manager, a bridge, and a silent carrier agent whose id goes back to Retell. Retries of one call share the first attempt. */
export function acceptInbound(deps: Deps, line: InboundLine, args: { providerCallId: string; from: string | null }): Promise<string> {
  const pending = accepting.get(args.providerCallId);
  if (pending) return pending;
  const attempt = answerInbound(deps, line, args);
  accepting.set(args.providerCallId, attempt);
  void attempt.catch(() => {}).finally(() => setTimeout(() => accepting.delete(args.providerCallId), 60_000).unref());
  return attempt;
}

async function answerInbound(deps: Deps, { person, telephone }: InboundLine, args: { providerCallId: string; from: string | null }): Promise<string> {
  await inboundReady;
  const carrier = carriers.get(person.id);
  if (!carrier) throw new Error(`${person.name}'s inbound carrier agent is not set up on this channel`);
  const answered = (await database().query<PhoneRow>('SELECT id FROM kenan_phone_call WHERE provider_call_id=$1', [args.providerCallId])).rows[0];
  if (answered) return carrier;
  const media = mediaSettings(person);
  liveConfig(media.live); voiceConfig(media.voice);
  const apiKey = readFileSync(telephone.apiKeyPath, 'utf8').trim();
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
    const agent = await deps.store.createAgent({ id: randomUUID(), name: `Call: ${name}`, ownerId: person.id, parentAgentId: managerId, role: 'worker', goalId, model: person.worker.model, sessionPath: join(deps.config.dataDir, 'sessions', `call-${id}.jsonl`), conversationTitle: `Call: ${name}` });
    deps.bus.toPerson(person.id, { type: 'agent', agent });
    const conversation = await deps.store.getConversation(agent.conversationId, person.id);
    if (conversation) deps.bus.toPerson(person.id, { type: 'conversation', conversation });
    return agent;
  };
  if (args.from !== null && telephone.inbound.kind === 'answered' && telephone.inbound.ownerNumbers.includes(args.from)) {
    // The owner's own calls get a phone lane: a call agent with the owner's context, a short history and quick tools,
    // which answers in seconds, instead of Kenaznia, whose half-million-token context took 8-12 s per answer (714bd84f).
    const profile = hostedManager(person);
    if (!profile) throw new Error(`${person.name}'s manager is not hosted on this channel`);
    const name = `${person.name} (owner)`;
    const callAgent = await newCallAgent(name, null);
    await record({ name, goalId: null, callAgentId: callAgent.id, placedById: managerId, brief: `Caller ID: ${spokenNumber(args.from)}, ${person.name}'s own phone. The caller is ${person.name}, the person you assist. Greet them by name in English as their assistant, then help with whatever they ask; delegate anything you cannot answer from what they say.` });
    // The task carries the owner's context and recent history; reading them must not hold up Retell's webhook.
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
      line ? `The caller's number is ${line.name}'s ${line.kind === 'kenan-line' ? `Kenan line: the caller is almost certainly ${line.name}'s Kenan (an AI assistant on this same system; its manager is manager:${line.personId}), not a person` : `own phone: the caller is probably ${line.name}`}.` : '',
      `GPT Live answers as Kenan, finds out who is calling and why, and delegates to you mid-call. A person is waiting on the line, so answer each request within seconds with voice(action="say", sessionId, delegationId, text): short, speakable guidance. If you need longer, say so first ("tell them I'm checking, one moment"), then answer. To hang up, use voice(action="end", sessionId).`,
      `Match the caller to their matter: the earlier calls below, the household's lines, the open goals (goals list) and their workers, the call briefs those calls were placed from, and ${person.name}'s own notes (their personal context and current state of the world). Once matched, tell the voice what it may share with this caller, drawn from that matter's briefs and records. For anything you cannot answer truthfully now, have the voice take a message (name, how to reach them, what it is about) rather than guess.`,
      `Rules, the same as outbound calls: never supply a phone number, email, address or other detail that is not verified in your records; share nothing about ${person.name} beyond what this caller needs for their matter; on the line name ${person.name} only as the matter's briefs name her or him (a work or legal name), never by any other name (a reply sentence with a private name the call's brief does not use is not spoken and comes back to you as withheld); never give a false answer to a material question on ${person.name}'s behalf (if one needs her, take the question exactly and bring it to ${managerId}). The only callback number the voice may give is this line, ${telephone.fromNumber}. If something needs ${managerId} during the call (an offer, a deadline, a decision), send it now with workers message to ${managerId}.`,
      `When the call ends you receive the transcript. Then: record the outcome with the owning goal (goals update notes) and pass the transcript to the owning worker if it is still active (workers message); do any follow-up the call needs; and report done with who called, why, what was said and agreed, and anything ${managerId} must act on.`,
      history,
      lines.length ? `The household's other lines:\n${lines.join('\n')}` : '',
      outbound,
      `What the voice was told about this caller:\n${brief}`,
      'Reply "ready" now; requests follow once the call connects.',
    ].filter(Boolean).join('\n\n') });
  }
  try {
    await run('systemd-run', ['--expand-environment=no', '--unit', unit(id), '--collect', '--quiet', '--property=KillMode=mixed', '--property=TimeoutStopSec=15', process.execPath, fileURLToPath(new URL('./phone-bridge.js', import.meta.url)), process.argv[2]!, id]);
    return carrier;
  } catch (e) {
    await run('systemctl', ['stop', unit(id)]).catch(() => {});
    await database().query(`UPDATE kenan_phone_call SET ended_at=$2, end_reason=$3 WHERE id=$1 AND ended_at IS NULL`, [id, Date.now(), `The inbound call could not be answered (the number's fallback agent takes it): ${String(e)}`]);
    throw e;
  }
}

/** Retell's custom-LLM socket for the silent carrier agent: it answers every turn with nothing until the bridge takes over. */
function silentSockets(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/hooks\/voice\/phone\/([0-9a-f-]{36}|carrier)\/([a-f0-9]{64})\/silent\/[A-Za-z0-9_]+$/.exec(request.url ?? '');
    const presented = match ? Buffer.from(match[2]!, 'hex') : null;
    const call = match && match[1] !== 'carrier' ? calls.get(match[1]!) : undefined;
    const allowed = presented && (match![1] === 'carrier' ? carrierTokens.some(token => timingSafeEqual(token, presented)) : call && timingSafeEqual(call.token, presented));
    if (!allowed) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('message', data => {
        const message = JSON.parse(String(data)) as { interaction_type?: string; response_id?: number };
        if (message.interaction_type === 'response_required' || message.interaction_type === 'reminder_required') ws.send(JSON.stringify({ response_type: 'response', response_id: message.response_id, content: '', content_complete: true }));
      });
    });
  });
}

export async function startPhone(deps: Deps): Promise<void> {
  pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2 });
  logDir = callLogDirectory(deps.config.dataDir, Date.now());
  carriers.clear(); carrierTokens.length = 0;
  const lines = householdLines(deps.config.people);
  household = lines.lines;
  for (const { personId, error } of lines.unreadable) await deps.store.logError('phone', `household lines: ${personId}'s telephone settings are unreadable: ${error}`);
  await pool.query(PHONE_TABLE);
  for (const statement of PHONE_COLUMNS) await pool.query(statement);
  inboundReady = reconcileInboundRoute(deps).catch(e => deps.store.logError('phone', `inbound route: ${String(e)}`));
  let running = false;
  sweeper = setInterval(() => {
    if (running) return;
    running = true;
    sweep(deps).catch(e => deps.store.logError('phone', String(e))).finally(() => { running = false; });
  }, SWEEP_MS);
}
export const phoneSockets = silentSockets;

export async function stopPhone(): Promise<void> {
  clearInterval(sweeper);
  sweeper = undefined;
  for (const call of calls.values()) call.attached?.socket.close();
  calls.clear();
  await pool?.end();
  pool = undefined;
}
