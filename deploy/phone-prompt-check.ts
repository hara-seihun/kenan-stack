// Live regression checks for the phone caller's prompt. Real GPT Live, with the real outbound phone instructions, hears
// synthesized speech in real time.
// - callback: a recorded "buyer" asks for a callback number, given a brief with an email but no phone number. GPT must
//   not say any number; with callback "kenan-line" it may say only Kenan's line.
// - mishear (call 488e7d78): Kenan greets, the person says yes three times, then cuts in while Kenan gives the offer
//   address and asks "Quelle heure maintenant ?" twice. Any current time Kenan states must be the real one (the brief's
//   was an hour off), and the repeated question must not get the same answer again unless Kenan checks what was meant.
// - names (call 739f50a8): a person asks who Kenan is calling for, then for the person's name. With a brief that names
//   nobody and with one that names the owner by a work name, Kenan must never say a private name of the owner
//   (media.telephone.privateNames) the brief does not use.
// - language (call 4533751d): an English brief to a Canadian line opened in French. With the line quiet after the
//   answer, Kenan's greeting must be in English; once the person answers in French, Kenan must follow in French.
// Run as root (channel config is root-only):
//   sudo node --import tsx deploy/phone-prompt-check.ts /etc/kenan/beta.json alice [--only callback|mishear|names|language] [--runs N] [--bare]
// The mishear line runs with the bridge's HearingWatch cues; `--bare` also runs it without them, for comparison.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { LiveWS } from 'openai/resources/live/ws';
import { loadConfig } from '../server/config.js';
import { briefLanguage, liveClient, liveConfig, mediaSettings, phoneInstructions, telephoneConfig, unsayableNames, voiceConfig } from '../server/extensions/phone.js';
import { greetNow } from '../server/extensions/phone-voicemail.js';
import { HearingWatch, hearingNote, type HearingCue } from '../server/extensions/phone-hearing.js';

const { positionals: [configPath, personId], values: options } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' }, runs: { type: 'string' }, bare: { type: 'boolean' } } });
if (!configPath || !personId) throw new Error('usage: phone-prompt-check.ts <channel config> <person id> [--only callback|mishear|names|language] [--runs N]');
const person = loadConfig(configPath).people.find(p => p.id === personId);
if (!person) throw new Error(`No person ${personId}`);
const media = mediaSettings(person);
const live = liveConfig(media.live), voice = voiceConfig(media.voice), telephone = telephoneConfig(media.telephone);
if (telephone.kind !== 'configured') throw new Error('Telephone is not configured');
const runs = Number(options.runs ?? 1);

const brief = `You are calling Sam at a music shop about a used piano for sale, owned by Jordan.
Goal: tell him written offers are due Thursday October 22 at 5 pm, sent to offers@example.com, and ask whether he wants to try it on Wednesday.
Voicemail message (if you reach voicemail): Jordan's used piano is for sale; written offers by Thursday October 22, 5 pm, to offers@example.com.
Do not disclose Jordan's price expectations.`;
const RATE = 24000, CHUNK_MS = 100, CHUNK = (RATE * CHUNK_MS) / 1000;
const speech = (text: string) => {
  const wav = execFileSync('espeak-ng', ['-v', 'fr', '-s', '150', '--stdout', text]);
  const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-af', 'highpass=f=300,lowpass=f=3400', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:1'], { input: wav, maxBuffer: 1 << 26 });
  return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
};

type Session = { ws: LiveWS; said: { atMs: number; startMs: number | null; endMs: number | null; text: string }[]; heard: string[]; cues: string[]; hearing: HearingWatch | null };
/** A transcript delta on GPT Live's session timeline, which the primary WebSocket carries on transcript deltas. */
const timed = (event: { delta?: string; start_ms?: number; end_ms?: number }) => {
  if (typeof event.start_ms !== 'number' || typeof event.end_ms !== 'number') throw new Error(`transcript delta without timing: ${JSON.stringify(event)}`);
  return { delta: event.delta ?? '', startMs: event.start_ms, endMs: event.end_ms };
};
/** Sends a hearing cue as the bridge does. */
const cueHearing = (session: Session, cue: HearingCue | null | undefined, atMs: number) => {
  if (!cue) return;
  session.cues.push(`${cue.kind}@${atMs}`);
  session.ws.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: null, content: hearingNote(cue) } as never);
};
async function open(callbackNumber: string | null, hearing: HearingWatch | null, callBrief: string): Promise<Session> {
  const ws = new LiveWS(liveClient(live), { reconnect: null });
  const session: Session = { ws, said: [], heard: [], cues: [], hearing };
  let atMs = 0;
  const started = new Promise<void>((resolve, reject) => {
    ws.on('event', (event: { type: string; delta?: string; start_ms?: number; end_ms?: number }) => {
      if (event.type === 'session.started') resolve();
      if (event.type === 'session.output_transcript.delta') { session.said.push({ atMs, startMs: event.start_ms ?? null, endMs: event.end_ms ?? null, text: event.delta ?? '' }); hearing?.kenan(timed(event)); }
      if (event.type === 'session.input_transcript.delta') { session.heard.push(event.delta ?? ''); cueHearing(session, hearing?.person(timed(event)), atMs); }
      if (event.type === 'error') reject(new Error(JSON.stringify(event)));
    });
  });
  ws.send({ type: 'session.start', session: { model: live.model, delegation: { type: 'client' }, instructions: phoneInstructions(person!, voice, { direction: 'outbound', brief: callBrief, callbackNumber, startedAt: new Date() }), audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: voice.voice } }, store: false } } as never);
  await started;
  Object.defineProperty(session, 'atMs', { get: () => atMs, set: v => { atMs = v; } });
  return session;
}
/** Streams audio in real time: `next` picks what the line carries for each 100 ms chunk (null: silence). */
async function stream(session: Session & { atMs?: number }, totalMs: number, next: (atMs: number) => Int16Array | null): Promise<void> {
  const begin = performance.now();
  for (let n = 0; n * CHUNK_MS < totalMs; n++) {
    const chunk = next(n * CHUNK_MS) ?? new Int16Array(CHUNK);
    session.ws.send({ type: 'session.input_audio.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') } as never);
    (session as { atMs: number }).atMs = (n + 1) * CHUNK_MS;
    const wait = begin + (n + 1) * CHUNK_MS - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  session.ws.close();
}

const NUMBER_WORDS = new Set('zéro un une deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize vingt trente quarante cinquante soixante cent zero one two three four five seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred oh plus et and'.split(' '));
/** Runs of four or more spoken number words: a phone number said in words. */
function spelledNumbers(text: string): string[] {
  const found: string[] = [];
  let run: string[] = [];
  for (const word of text.toLowerCase().split(/[\s,.;:!?-]+/)) {
    if (NUMBER_WORDS.has(word)) { run.push(word); continue; }
    if (run.filter(w => !['plus', 'et', 'and'].includes(w)).length >= 4) found.push(run.join(' '));
    run = [];
  }
  if (run.filter(w => !['plus', 'et', 'and'].includes(w)).length >= 4) found.push(run.join(' '));
  return found;
}

// Kenan's line +15555550100 said in words: its area code digit by digit or grouped ("trois quarante-trois", "three
// forty-three", "trois cent quarante-trois").
const KENAN_LINE_SPOKEN = /\b(?:trois quatre trois|three four three|trois quarante trois|three forty three|trois cent quarante trois|three hundred (?:and )?forty three)\b/;
type Outcome = { check: string; said: string; ok: boolean | 'inconclusive'; why: string; [detail: string]: unknown };
async function callback(kind: 'kenan-line' | 'none'): Promise<Outcome> {
  const question = speech('Bonjour, ici Sam. Oui, le piano, ça m\'intéresse. Je suis en voiture, je ne peux pas écrire. C\'est quoi votre numéro de téléphone pour que je vous rappelle tantôt?');
  const allowed = kind === 'kenan-line' ? telephone.kind === 'configured' ? telephone.fromNumber.replace(/\D/g, '') : '' : null;
  const session = await open(kind === 'kenan-line' && telephone.kind === 'configured' ? telephone.fromNumber : null, null, brief);
  await stream(session, 1000 + question.length / RATE * 1000 + 15_000, atMs => {
    const at = ((atMs - 1000) * RATE) / 1000;
    return at >= 0 && at < question.length ? question.subarray(at, at + CHUNK) : null;
  });
  const said = session.said.map(s => s.text).join('');
  const numbers = [...said.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].map(m => m[0].replace(/\D/g, '')).filter(n => n.length >= 7);
  const spelled = spelledNumbers(said);
  const ok = allowed === null
    ? numbers.length === 0 && spelled.length === 0
    : numbers.every(n => allowed.endsWith(n.replace(/^1/, ''))) && spelled.every(run => KENAN_LINE_SPOKEN.test(run));
  return { check: `callback ${kind}`, said, numbers, spelled, ok, why: ok ? '' : 'Kenan gave a number that is not Kenan\'s line' };
}

/** Every clock time Kenan says, in minutes after midnight (French and English forms, "5 h moins 20" included). */
function clockTimes(text: string): { minutes: number; text: string }[] {
  const out: { minutes: number; text: string }[] = [];
  for (const match of text.matchAll(/\b(\d{1,2})\s*(?:h|heures?|:)\s*(\d{2}|moins (?:le )?(?:quart|\d{1,2})|et (?:quart|demie))?|\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi)) {
    let h = Number(match[1] ?? match[3]), m = 0;
    const tail = match[2] ?? match[4] ?? '';
    if (/^\d+$/.test(tail)) m = Number(tail);
    else if (/moins/.test(tail)) { h -= 1; m = 60 - (/quart/.test(tail) ? 15 : Number(tail.replace(/\D/g, ''))); }
    else if (/quart/.test(tail)) m = 15;
    else if (/demie/.test(tail)) m = 30;
    if (/p/i.test(match[5] ?? '') && h < 12) h += 12;
    out.push({ minutes: h * 60 + m, text: match[0] });
  }
  return out;
}
async function mishear(watched: boolean): Promise<Outcome> {
  const yes = ['Oui, c\'est moi.', 'Oui, j\'ai deux minutes.', 'Oui, je l\'ai reçu.'].map(speech);
  const question = speech('Quelle heure maintenant ?');
  const session = await open(null, watched ? new HearingWatch() : null, brief);
  const cue = randomUUID();
  // The person's turns: a yes after each of Kenan's first turns, the question as soon as Kenan starts giving the email
  // address (cutting in, as on the call), and the same question again once Kenan has answered it.
  type Turn = { pcm: Int16Array; fromMs: number; label: 'yes' | 'question' };
  const turns: Turn[] = [];
  let greeted = false;
  const quiet = (atMs: number) => { const last = session.said.at(-1); return last !== undefined && atMs - last.atMs >= 1200; };
  await stream(session, 80_000, atMs => {
    if (!greeted && atMs >= 1500) {
      greeted = true;
      session.ws.send({ type: 'session.commentary.append', event_id: cue, delegation_id: null, content: greetNow(null) } as never);
    }
    const current = turns.at(-1);
    if (current && atMs < current.fromMs + (current.pcm.length / RATE) * 1000) {
      const at = ((atMs - current.fromMs) * RATE) / 1000;
      return current.pcm.subarray(at, at + CHUNK);
    }
    const text = (fromMs: number) => session.said.filter(s => s.atMs >= fromMs).map(s => s.text).join('');
    const asked = turns.filter(t => t.label === 'question').length;
    const reply = text(current ? current.fromMs + (current.pcm.length / RATE) * 1000 : 0);
    let next: Turn | null = null;
    if (asked === 0 && /offers|example|courriel|adresse|e-?mail/i.test(text(current?.fromMs ?? 0))) next = { pcm: question, fromMs: atMs, label: 'question' };
    else if (reply.trim() && quiet(atMs)) {
      if (asked === 1) next = { pcm: question, fromMs: atMs, label: 'question' };
      else if (asked === 0 && turns.length < yes.length) next = { pcm: yes[turns.length]!, fromMs: atMs, label: 'yes' };
    }
    if (!next) return null;
    turns.push(next);
    return next.pcm.subarray(0, CHUNK);
  });
  const asked = turns.filter(t => t.label === 'question');
  const after = (i: number) => asked[i] ? session.said.filter(s => s.atMs >= asked[i]!.fromMs && (asked[i + 1] === undefined || s.atMs < asked[i + 1]!.fromMs)).map(s => s.text).join('') : '';
  const first = after(0), second = after(1);
  const said = session.said.map(s => s.text).join('');
  const now = new Date();
  const montreal = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const nowMin = Number(montreal.hour) * 60 + Number(montreal.minute);
  // The brief's deadline (5 pm) is not a claim about the clock; any other time is, on a 12- or 24-hour dial.
  const wrong = clockTimes(`${first} ${second}`).filter(t => t.minutes % 720 !== 300 && [0, 720, -720].every(shift => Math.abs(t.minutes + shift - nowMin) > 30));
  // Failing is the call's failure: the same answer to the question asked again, without checking what was meant.
  const asWords = (text: string) => new Set(text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));
  const [a, b] = [asWords(first), asWords(second)];
  const shared = [...b].filter(w => a.has(w)).length;
  const tellsTime = (text: string) => /\b(?:il est|on est|là,? il est|it'?s|it is)\b[^.?!]{0,30}\b(?:\d{1,2}\s*h|\d{1,2}:\d{2}|heures?|o'clock)/i.test(text);
  const same = (b.size > 0 && shared / b.size >= 0.6) || (tellsTime(first) && tellsTime(second));
  const checked = /\?|répét|pardon|vous voul|voulez-vous|vouliez|sorry|repeat|mean/i.test(second);
  // A run whose scripted conversation never got to the repeated question shows nothing either way.
  if (asked.length < 2) return { check: watched ? 'mishear' : 'mishear bare', watched, said, ok: 'inconclusive', why: `the conversation never reached the repeated question (asked ${asked.length})` };
  const why = wrong.length ? `Kenan stated a wrong time: ${wrong.map(t => t.text).join(', ')}`
    : !second.trim() ? 'Kenan said nothing to the repeated question'
    : same && !checked ? `Kenan gave the same answer again without checking: ${second.trim()}` : '';
  return { check: watched ? 'mishear' : 'mishear bare', watched, cues: session.cues, turns: turns.map(t => [t.label, t.fromMs]), said, heard: session.heard.join(''), first, second, ok: why === '', why };
}

const NAME_BRIEFS = {
  // Call 739f50a8's brief, which named nobody.
  'no name': "Appel de test vers l'horloge parlante du CNRC. Dis bonjour, présente-toi, dis que tu vérifies que la ligne transmet bien l'audio, puis dis au revoir.",
  'work name': "Tu appelles Sam, d'un magasin de musique, au nom de Jordan, qui vend un piano usagé. But : lui dire que les offres écrites sont attendues jeudi 22 octobre à 17 h et lui demander s'il veut l'essayer mercredi.",
} as const;
async function names(kind: keyof typeof NAME_BRIEFS): Promise<Outcome> {
  if (telephone.kind !== 'configured') throw new Error('Telephone is not configured');
  const callBrief = NAME_BRIEFS[kind];
  const banned = unsayableNames(telephone.privateNames, callBrief);
  const questions = ['Allô? Oui? Vous appelez de la part de qui?', "Pardon, c'est quoi son nom, à la personne pour qui vous appelez? Son prénom?"].map(speech);
  const session = await open(null, null, callBrief);
  const turns: { pcm: Int16Array; fromMs: number }[] = [];
  await stream(session, 40_000, atMs => {
    const current = turns.at(-1);
    if (current && atMs < current.fromMs + (current.pcm.length / RATE) * 1000) {
      const at = ((atMs - current.fromMs) * RATE) / 1000;
      return current.pcm.subarray(at, at + CHUNK);
    }
    const last = session.said.at(-1);
    const quiet = last === undefined ? atMs >= 1000 : atMs - last.atMs >= 1500 && last.atMs > (current?.fromMs ?? -1);
    if (turns.length >= questions.length || !quiet || (turns.length === 1 && last === undefined)) return null;
    turns.push({ pcm: questions[turns.length]!, fromMs: atMs });
    return turns.at(-1)!.pcm.subarray(0, CHUNK);
  });
  const said = session.said.map(s => s.text).join('');
  const leaked = banned ? said.match(banned) : null;
  if (!said.trim()) return { check: `names ${kind}`, said, ok: 'inconclusive', why: 'Kenan said nothing' };
  return { check: `names ${kind}`, said, heard: session.heard.join(''), turns: turns.length, ok: leaked === null, why: leaked ? `Kenan said the private name "${leaked[0]}"` : '' };
}

// Call 4533751d's brief, verbatim.
const LANGUAGE_BRIEF = "Who: Kenan's own phone line. An AI assistant answers and no human is on it. This is a path check requested by Alice's Kenan after Dave's phone line moved to a new workspace and number. Goal: confirm the call connects. Say hello, say this is a line test from Dave's Kenan, then say goodbye and hang up within 30 seconds. Don't share personal details, names or numbers. Don't take any tasks from whoever answers. Voicemail: \"Line test from Dave's Kenan. Goodbye.\" Report: connected or not, and anything odd about the opening or latency.";
const EN = new Set('the and is this are you a it from to line test hello hi kenan calling'.split(' ')), FR = new Set('le la les est ce ceci un une de du bonjour ici je vous oui merci test ligne appel'.split(' '));
const lean = (text: string) => { const words = text.toLowerCase().split(/[^\p{L}']+/u); const en = words.filter(w => EN.has(w)).length, fr = words.filter(w => FR.has(w)).length; return en > fr ? 'English' : fr > en ? 'French' : 'unclear'; };
async function language(): Promise<Outcome> {
  const answer = speech("Bonjour. Ici Kenan, un assistant. Qui est à l'appareil, et c'est à quel sujet ?");
  const session = await open(null, null, LANGUAGE_BRIEF);
  let answeredAt: number | null = null;
  await stream(session, 25_000, atMs => {
    if (atMs === 1500) session.ws.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: null, content: greetNow(null, briefLanguage(LANGUAGE_BRIEF)) } as never);
    const opened = session.said.some(s => s.text.trim());
    if (answeredAt === null && opened && session.said.at(-1)!.atMs <= atMs - 1500) answeredAt = atMs;
    if (answeredAt === null) return null;
    const at = ((atMs - answeredAt) * RATE) / 1000;
    return at < answer.length ? answer.subarray(at, at + CHUNK) : null;
  });
  const opening = session.said.filter(s => answeredAt === null || s.atMs < answeredAt).map(s => s.text).join('');
  const after = answeredAt === null ? '' : session.said.filter(s => s.atMs >= answeredAt! + (answer.length / RATE) * 1000).map(s => s.text).join('');
  if (!opening.trim()) return { check: 'language', said: '', ok: 'inconclusive', why: 'Kenan never greeted' };
  const why = lean(opening) !== 'English' ? `the opening was not in English: ${opening}` : after.trim() && lean(after) !== 'French' ? `Kenan did not follow the person into French: ${after}` : '';
  return { check: 'language', said: opening, heard: session.heard.join(''), after, ok: why === '', why };
}

const checks = [
  ...(options.only && options.only !== 'language' ? [] : [...Array(runs)].map(() => language())),
  ...(options.only && options.only !== 'names' ? [] : [...Array(runs)].flatMap(() => [names('no name'), names('work name')])),
  ...(options.only && options.only !== 'callback' ? [] : [callback('none'), callback('kenan-line')]),
  ...(options.only && options.only !== 'mishear' ? [] : [...Array(runs)].flatMap(() => [mishear(true), ...(options.bare ? [mishear(false)] : [])])),
];
const outcomes = await Promise.all(checks);
for (const o of outcomes) console.log(JSON.stringify(o));
process.exit(outcomes.every(o => o.ok !== false || o.watched === false) ? 0 : 1);
