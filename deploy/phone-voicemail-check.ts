// Live regression check for voicemail: real GPT Live, with the real outbound phone instructions, hears synthesized
// mailboxes in real time (French and English, with and without a beep, with a prompt after the beep, and a replica of
// call 96bb3c65's mailbox). The bridge's voicemail watch runs on the same audio and cues GPT exactly as the bridge does.
// Each mailbox must record the brief's message once: after the beep (or after the greeting when there is none).
// It also replays answered lines (call 55416c51): the callee says hello before the bridge joins, so GPT hears only the
// silence after it; Kenan must start speaking within GREET_WITHIN_MS of the join. And it replays phone menus whose key the
// brief names (call 10b48b42): the bridge's menu watch must press the key and Kenan must say nothing on the menu.
// `--bare` also runs every mailbox without the watch, to show what GPT Live does on its own; `--brief FILE` replaces the
// sample brief (a real call's brief must name its message keyword with `--keyword WORD`). Run as root:
//   sudo node --import tsx deploy/phone-voicemail-check.ts /etc/kenan/beta.json alice [--bare] [--brief FILE --keyword WORD] [--only LINE]
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LiveWS } from 'openai/resources/live/ws';
import { loadConfig } from '../server/config.js';
import { briefLanguage, liveClient, liveConfig, mediaSettings, phoneInstructions, voiceConfig } from '../server/extensions/phone.js';
import { FRAME, LEAVE_MESSAGE, LineWatch, MessageShield, greetNow } from '../server/extensions/phone-voicemail.js';
import { MenuWatch, briefKeys } from '../server/extensions/phone-menu.js';
import { ANSWERED, MAILBOXES, MENUS, render } from '../server/extensions/phone-voicemail-fixtures.js';

const { positionals: [configPath, personId], values: options } = parseArgs({ allowPositionals: true, options: { bare: { type: 'boolean' }, brief: { type: 'string' }, keyword: { type: 'string' }, only: { type: 'string' } } });
if (!configPath || !personId) throw new Error('usage: phone-voicemail-check.ts <channel config> <person id> [--bare] [--brief FILE --keyword WORD] [--only MAILBOX]');
if (Boolean(options.brief) !== Boolean(options.keyword)) throw new Error('--brief and --keyword go together');
const person = loadConfig(configPath).people.find(p => p.id === personId);
if (!person) throw new Error(`No person ${personId}`);
const media = mediaSettings(person);
const live = liveConfig(media.live), voice = voiceConfig(media.voice);

const sampleBrief = `You are calling Sam at a music shop about a used piano for sale, owned by Jordan.
Goal: tell him written offers are due Thursday October 22 at 5 pm, sent to offers@example.com, and ask whether he wants to try it on Wednesday.
Voicemail message (if you reach voicemail; once, after the beep): Jordan's used piano is for sale; written offers by Thursday October 22, 5 pm, to offers@example.com. Then hang up.
Do not disclose Jordan's price expectations.`;
const brief = options.brief ? readFileSync(options.brief, 'utf8') : sampleBrief;
const keyword = new RegExp(options.keyword ?? 'piano', 'gi');

const RATE = 24000, CHUNK_MS = 100, CHUNK = (RATE * CHUNK_MS) / 1000, TAIL_MS = 6000;
type Spoken = { atMs: number; text: string };
type Outcome = { mailbox: string; watched: boolean; cue: string | null; firstBeepMs: number | null; greetingEndMs: number; heard: Spoken[]; kenan: Spoken[]; said: string; ok: boolean; why: string };
/** Answered lines: the bridge joins here, as on call 55416c51; GPT hears silence until then. */
const JOIN_MS = 1800, GREET_WITHIN_MS = 4000;
const LINES = { ...MAILBOXES, ...ANSWERED, ...Object.fromEntries(Object.entries(MENUS).map(([name, menu]) => [name, menu.segments])) as { [K in keyof typeof MENUS]: (typeof MENUS)[K]['segments'] } };
type Line = keyof typeof LINES;
const answered = (name: Line): name is keyof typeof ANSWERED => name in ANSWERED;
const menuLine = (name: Line): name is keyof typeof MENUS => name in MENUS;
/** Kenan announcing or acknowledging a keypress on the line (call 10b48b42: "D'accord, je m'en occupe. C'est fait.", "J'ai pressé le 1"). */
const KEY_TALK = /occupe|c'est fait|press|appui|appuy|touche|tap[ée]|\b(?:1|un|one)\b/i;

async function run(name: Line, watched: boolean): Promise<Outcome> {
  const audio = render(LINES[name], RATE);
  const joinMs = answered(name) ? JOIN_MS : 0;
  audio.pcm.fill(0, 0, (RATE * joinMs) / 1000);
  const beforeJoin = answered(name) ? audio.speech.filter(s => s.endMs <= JOIN_MS).map(s => s.text).join(' ') || null : null;
  const callBrief = menuLine(name) ? `${brief}\n\n${MENUS[name].brief}` : brief;
  const ws = new LiveWS(liveClient(live), { reconnect: null });
  const watch = new LineWatch(), shield = new MessageShield(), menu = new MenuWatch(briefKeys(callBrief));
  const pressed: Spoken[] = [];
  let joined = false;
  const kenan: Spoken[] = [], heard: Spoken[] = [];
  let atMs = 0, cue: string | null = null;
  const started = new Promise<void>((resolve, reject) => {
    ws.on('event', (event: { type: string; delta?: string }) => {
      if (event.type === 'session.started') resolve();
      if (event.type === 'session.output_transcript.delta') { kenan.push({ atMs, text: event.delta ?? '' }); watch.kenan(event.delta ?? ''); shield.kenan(atMs); }
      if (event.type === 'session.input_transcript.delta') {
        heard.push({ atMs, text: event.delta ?? '' }); watch.person(event.delta ?? '');
        const hit = watched ? menu.person(event.delta ?? '') : null;
        if (hit) {
          pressed.push({ atMs, text: hit.key });
          watch.rearm();
          ws.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: null, content: `Kenan is pressing ${hit.key} on the keypad itself, once the menu has finished speaking. Say nothing about it, and do not ask for this key.` } as never);
        }
      }
      if (event.type === 'error') reject(new Error(JSON.stringify(event)));
    });
  });
  ws.send({ type: 'session.start', session: { model: live.model, delegation: { type: 'client' }, instructions: phoneInstructions(person!, voice, { direction: 'outbound', brief: callBrief, callbackNumber: null, startedAt: new Date() }), audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: voice.voice } }, store: false } } as never);
  await started;
  const total = audio.pcm.length + (RATE * TAIL_MS) / 1000;
  const begin = performance.now();
  for (let at = 0, n = 0; at < total; at += CHUNK, n++) {
    if (!joined && atMs >= joinMs) {
      joined = true;
      watch.joined();
      if (beforeJoin) watch.person(`${beforeJoin} `);
      ws.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: null, content: 'The call has connected: from now on the other side hears you.' } as never);
    }
    const chunk = new Int16Array(CHUNK);
    if (at < audio.pcm.length) chunk.set(audio.pcm.subarray(at, Math.min(at + CHUNK, audio.pcm.length)));
    if (watched) {
      for (let f = 0; f < CHUNK / (FRAME * 3); f++) {
        const frame = new Int16Array(FRAME);
        for (let i = 0; i < FRAME; i++) frame[i] = Math.round((chunk[(f * FRAME + i) * 3]! + chunk[(f * FRAME + i) * 3 + 1]! + chunk[(f * FRAME + i) * 3 + 2]!) / 3);
        const fired = watch.push(frame);
        if (fired?.kind === 'greet') {
          cue = `greet@${fired.atMs}`;
          ws.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: null, content: greetNow(beforeJoin, briefLanguage(callBrief)) } as never);
        } else if (fired) {
          cue = `${fired.after}@${fired.atMs}`;
          shield.start(atMs);
          ws.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: null, content: LEAVE_MESSAGE[fired.after] } as never);
        }
      }
      shield.check(atMs);
    }
    const heard = shield.active ? new Int16Array(CHUNK) : chunk;
    ws.send({ type: 'session.input_audio.append', audio: Buffer.from(heard.buffer).toString('base64') } as never);
    atMs = (n + 1) * CHUNK_MS;
    const wait = begin + atMs - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  ws.close();
  const said = kenan.map(k => k.text).join('');
  if (menuLine(name)) {
    const keys = pressed.map(p => p.text).join('');
    const why = keys !== MENUS[name].key ? `pressed ${JSON.stringify(keys)} instead of ${MENUS[name].key}` : KEY_TALK.test(said) ? `Kenan talked about the key: ${said.trim()}` : '';
    return { mailbox: name, watched, cue: keys ? `key ${keys}@${pressed[0]!.atMs}` : null, firstBeepMs: null, greetingEndMs: 0, heard, kenan, said, ok: watched ? why === '' : true, why };
  }
  if (answered(name)) {
    const first = kenan.find(k => k.text.trim() && k.atMs >= JOIN_MS)?.atMs ?? null;
    const why = first === null ? 'Kenan never spoke to the waiting person' : first - JOIN_MS > GREET_WITHIN_MS ? `Kenan first spoke ${first - JOIN_MS} ms after the join` : '';
    return { mailbox: name, watched, cue, firstBeepMs: null, greetingEndMs: JOIN_MS, heard, kenan, said, ok: why === '', why };
  }
  const firstBeepMs = audio.beeps[0] ?? null, greetingEndMs = audio.speech[0]!.endMs;
  // Only what Kenan says after the beep (or the end of a greeting without one) is recorded.
  const recordedFrom = firstBeepMs ?? greetingEndMs;
  const recorded = kenan.filter(k => k.atMs >= recordedFrom).map(k => k.text).join('');
  const times = [...recorded.matchAll(keyword)].length;
  const why = times === 0 ? 'no voicemail message after the beep' : times > 1 ? 'message left more than once' : '';
  return { mailbox: name, watched, cue, firstBeepMs, greetingEndMs, heard, kenan, said, ok: why === '', why };
}

const names = (Object.keys(LINES) as Line[]).filter(n => !options.only || n === options.only);
const outcomes = await Promise.all([...names.map(n => run(n, true)), ...(options.bare ? names.map(n => run(n, false)) : [])]);
for (const o of outcomes) console.log(JSON.stringify(o));
process.exit(outcomes.filter(o => o.watched).every(o => o.ok) ? 0 : 1);
