/// <reference lib="dom" />
/**
 * Kenan's own Google Meet notetaker: one process per meeting, started by the meeting extension as its own
 * systemd unit so it outlives server restarts. It runs Chrome under a private Xvfb display, signed in with a
 * copy of the notetaker's Google profile, joins (or knocks), announces itself in chat, turns on captions and
 * writes everything it sees to DIR/events.jsonl. The server reads that file; it writes DIR/control.json to
 * make the notetaker leave.
 *
 * It leaves when: every other participant has been gone ALONE grace, the call ends or it is removed, someone
 * asks it to leave (chat or speech), the server asks, or the hard cap passes. A lobby nobody answers by
 * admitUntil ends the attempt. Arriving before everyone else is not being alone: the alone grace only runs
 * once someone else has been in the call, or once admitUntil has passed with nobody arriving. The chat
 * announcement likewise waits for someone else, since people who join later may not see earlier chat.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asksToLeave, asksToStay, DEFAULT_WAKE_NAMES, LEAVE_GRACE_MS, LeaveGrace } from './meeting-consent.js';
import { cloudMinutes, startCloudBrowser, stopCloudBrowser } from './meeting-cloud-browser.js';
import { meetingVoice, type JoinerVoice, type VoiceNote } from './meeting-joiner-voice.js';
export { asksToLeave, LEAVE_GRACE_MS, LeaveGrace };

export interface JoinerRequest {
  sessionId: string;
  meetingUrl: string;
  /** Only used when the profile isn't signed in (Meet then asks for a name). */
  displayName: string;
  /** Posted in the meeting chat right after entering. */
  announcement: string;
  chrome: string;
  /** A signed-in Chrome user-data directory, copied per meeting and never used directly; null joins signed out (Meet asks for a name and the host must admit). */
  profile: string | null;
  /**
   * A Browser Use Cloud profile (cloud-browser) to run the notetaker's Chrome in instead of a local one: US residential
   * egress and a Google session that lives there. Google refuses a session copied to a datacenter host. profile is then unused.
   */
  cloudProfile?: string | null;
  admitUntil: number;
  capAt: number;
  aloneGraceMs: number;
  /**
   * When to open the meeting: shortly before the scheduled start. Meet ends a call that has had only the
   * notetaker in it for a while, so a notetaker that sits in an empty call long before the start loses it.
   * Absent in requests written before this existed: enter at once.
   */
  enterAt?: number;
  /** Set for a meeting with voice: Kenan talks (GPT Live as its microphone) and can present (meeting-joiner-voice.ts). */
  voice?: JoinerVoice;
}
export type LeaveReason = 'alone' | 'ended' | 'removed' | 'asked' | 'control' | 'cap' | 'not-admitted' | 'denied' | 'failed';
export type JoinerEvent =
  | { kind: 'state'; state: 'starting' | 'prejoin' | 'lobby' | 'entered'; at: number }
  | { kind: 'state'; state: 'left'; at: number; reason: LeaveReason; detail: string | null }
  | { kind: 'caption'; id: string; speaker: string | null; text: string; at: number; startedAt: number }
  | { kind: 'participants'; names: string[]; at: number }
  | { kind: 'chat'; from: string | null; text: string; at: number }
  | { kind: 'announced'; at: number; ok: boolean; detail: string | null }
  | { kind: 'captions'; at: number; ok: boolean; detail: string | null }
  /** What the page showed when something unexpected happened (no captions in the "call", say): for diagnosis only. */
  | { kind: 'page'; at: number; why: string; clicked: 'join' | 'ask'; buttons: string[]; text: string }
  | VoiceNote;
export type Control = { leave: string };

/** A caption line as Meet shows it right now. Meet rewrites the newest line as speech continues. */
export type CaptionLine = { speaker: string | null; text: string };
/**
 * Turns successive caption snapshots into final lines. Meet shows one block per speaker turn and keeps
 * rewriting it: words are appended, earlier words are corrected, and a long block may lose its start.
 * A block is matched to what was seen before by speaker and shared words; its new words are emitted once
 * it pauses for settleMs, once a newer block follows it, once it leaves the screen, or every
 * MAX_PENDING_WORDS words of a long monologue (cut at a sentence end where there is one).
 */
const words = (t: string) => t.split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const MAX_PENDING_WORDS = 60;
const bigrams = (w: string[]) => new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));
/**
 * How surely a block on screen now is the open line seen before: 3 the same words, 2 one continues the other, otherwise
 * the share of word pairs they have in common (single shared words like "the" or "you" made unrelated blocks from one
 * speaker match each other on November 4).
 */
export function captionSimilarity(a: string, b: string): number {
  const x = words(a).map(norm).filter(Boolean), y = words(b).map(norm).filter(Boolean);
  if (!x.length || !y.length) return 0;
  if (x.join(' ') === y.join(' ')) return 3;
  const n = Math.min(x.length, y.length);
  if (x.slice(0, n).join(' ') === y.slice(0, n).join(' ')) return 2;
  const bx = bigrams(x), by = bigrams(y);
  if (!bx.size || !by.size) return 0;
  return [...by].filter(p => bx.has(p)).length / Math.min(bx.size, by.size);
}
/** Lines emitted recently per speaker: a block Meet shows again is never written twice (the November 4 repetition). */
const RECENT_MS = 60_000, SHORT_RECENT_MS = 10_000;
type OpenLine = { id: string; speaker: string | null; text: string; startedAt: number; changedAt: number; tail: string[]; emittedWords: number; parts: number };
export class CaptionTracker {
  private open: OpenLine[] = [];
  private next = 0;
  private recent: { speaker: string | null; text: string; at: number }[] = [];
  /** Whether these words were already written for this speaker: the same words lately, or (for a long piece) inside a longer line. */
  private repeated(speaker: string | null, rest: string[], now: number): boolean {
    this.recent = this.recent.filter(r => now - r.at < RECENT_MS);
    const text = rest.map(norm).filter(Boolean).join(' ');
    if (!text) return false;
    const count = text.split(' ').length;
    return this.recent.some(r => r.speaker === speaker && ((r.text === text && (count >= 4 || now - r.at < SHORT_RECENT_MS)) || (count >= 6 && r.text.includes(text))));
  }
  constructor(private readonly settleMs: number) {}
  /** The words of a line not yet emitted: whatever follows the last emitted words, found again in the current text. */
  private pending(line: OpenLine): string[] {
    const all = words(line.text);
    if (!line.tail.length) return all;
    const n = all.map(norm);
    for (let k = line.tail.length; k >= Math.min(2, line.tail.length); k--) {
      const tail = line.tail.slice(-k);
      for (let i = n.length - k; i >= 0; i--) if (tail.every((w, j) => n[i + j] === w)) return all.slice(i + k);
    }
    return all.slice(Math.min(line.emittedWords, all.length));
  }
  private emit(line: OpenLine, now: number, out: Extract<JoinerEvent, { kind: 'caption' }>[], upToSentence = false) {
    let rest = this.pending(line);
    if (upToSentence) { const end = rest.map(w => /[.!?]$/.test(w)).lastIndexOf(true); if (end >= 0) rest = rest.slice(0, end + 1); }
    if (!rest.length) return;
    if (!this.repeated(line.speaker, rest, now)) {
      out.push({ kind: 'caption', id: line.parts ? `${line.id}.${line.parts}` : line.id, speaker: line.speaker, text: rest.join(' '), at: now, startedAt: line.startedAt });
      this.recent.push({ speaker: line.speaker, text: rest.map(norm).filter(Boolean).join(' '), at: now });
      line.parts++;
    }
    line.tail = [...line.tail, ...rest.map(norm)].slice(-6);
    line.emittedWords = words(line.text).length - (this.pending(line).length);
  }
  update(lines: CaptionLine[], now: number): Extract<JoinerEvent, { kind: 'caption' }>[] {
    const out: Extract<JoinerEvent, { kind: 'caption' }>[] = [];
    const used = new Set<number>();
    const kept: OpenLine[] = [];
    // Pair each block on screen with an open line, most similar pairs first, so one block never takes another's line.
    const pairs: { line: number; open: number; score: number }[] = [];
    lines.forEach((line, l) => this.open.forEach((o, i) => { if (o.speaker === line.speaker) { const score = captionSimilarity(o.text, line.text); if (score >= 0.4) pairs.push({ line: l, open: i, score }); } }));
    pairs.sort((a, b) => b.score - a.score || a.line - b.line);
    const match = new Map<number, number>();
    for (const p of pairs) if (!match.has(p.line) && !used.has(p.open)) { match.set(p.line, p.open); used.add(p.open); }
    for (const [l, line] of lines.entries()) {
      const best = match.get(l) ?? -1;
      if (best < 0) { kept.push({ id: `c${this.next++}`, speaker: line.speaker, text: line.text, startedAt: now, changedAt: now, tail: [], emittedWords: 0, parts: 0 }); continue; }
      const o = this.open[best]!;
      if (o.text !== line.text) { o.text = line.text; o.changedAt = now; }
      kept.push(o);
    }
    this.open.forEach((o, i) => { if (!used.has(i)) this.emit(o, now, out); });
    kept.forEach((o, i) => {
      if (i < kept.length - 1 || now - o.changedAt >= this.settleMs) this.emit(o, now, out);
      else if (this.pending(o).length > MAX_PENDING_WORDS) this.emit(o, now, out, true);
    });
    this.open = kept;
    return out;
  }
  flush(now: number) { const out: Extract<JoinerEvent, { kind: 'caption' }>[] = []; for (const o of this.open) this.emit(o, now, out); this.open = []; return out; }
}

/** What the page shows, read in one evaluate. Runs in the browser: keep it self-contained. */
export function readMeetPage() {
  const visible = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect?.(); return !!r && r.width > 0 && r.height > 0; };
  const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible).map(b => ({ label: (b.getAttribute('aria-label') ?? '').trim(), text: ((b as HTMLElement).innerText ?? '').trim() }));
  const has = (re: RegExp) => buttons.some(b => re.test(b.label) || re.test(b.text));
  const body = (document.body?.innerText ?? '').slice(0, 20000);
  // Meet's newer waiting room is inside the call screen (it has a Leave call button), so the lobby text rules it out.
  const lobby = /Asking to be let in|You'll join the call when someone lets you in|Waiting for the host|Please wait until a meeting host brings you into the call|Someone will let you in soon/i.test(body);
  const inCall = has(/^Leave call$/) && !lobby;
  const region = [...document.querySelectorAll('[role=region]')].find(r => /caption/i.test(r.getAttribute('aria-label') ?? ''));
  const captions: { speaker: string | null; text: string }[] = [];
  if (region) {
    // Each caption entry has the speaker's avatar image; without the usual structure, its name is the shortest text block, its words the longest.
    const entries = [...region.querySelectorAll('img')].map(img => { let e: Element | null = img; while (e && e.parentElement !== region && !(e.parentElement && e.parentElement.querySelectorAll('img').length > 1)) e = e.parentElement; return e; }).filter((e): e is Element => !!e);
    for (const entry of new Set(entries)) {
      // Meet's entry is a header (avatar and name) followed by the words. Read them by that structure: by length,
      // a short utterance ("Magic.") would pass for the speaker and the name for the words.
      const header = [...entry.children].find(c => c.tagName === 'IMG' || !!c.querySelector('img'));
      const words = [...entry.children].filter(c => c !== header && c.tagName !== 'IMG' && !c.querySelector('img')).map(c => (c as HTMLElement).innerText?.trim() ?? '').filter(Boolean).join(' ');
      if (header && words) {
        const name = (header as HTMLElement).innerText?.trim() || null;
        captions.push({ speaker: name === words ? null : name, text: words });
        continue;
      }
      const texts = [...entry.querySelectorAll('div,span')].filter(x => x.children.length === 0 || [...x.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim())).map(x => (x as HTMLElement).innerText?.trim() ?? '').filter(Boolean);
      if (!texts.length) continue;
      const sorted = [...texts].sort((a, b) => a.length - b.length);
      const text = sorted[sorted.length - 1]!;
      const speaker = texts.length > 1 ? sorted[0]! : null;
      captions.push({ speaker: speaker === text ? null : speaker, text });
    }
  }
  // Each participant tile has a "More options for NAME" button; the tile count stands in when there are none.
  const names = [...new Set([...document.querySelectorAll('button[aria-label^="More options for "]')].map(b => b.getAttribute('aria-label')!.slice('More options for '.length).trim()).filter(Boolean))];
  const tiles = new Set([...document.querySelectorAll('[data-participant-id]')].map(t => t.getAttribute('data-participant-id'))).size;
  const peopleBadge = buttons.find(b => /^(People|Show everyone)/i.test(b.label))?.text.match(/\d+/)?.[0] ?? null;
  const chat = [...document.querySelectorAll('div[data-message-id]')].map(m => ({ id: m.getAttribute('data-message-id')!,
    from: m.closest('[data-sender-name]')?.getAttribute('data-sender-name') ?? null,
    text: ((m.querySelector('[jsname="dTKtvb"]') ?? m.firstElementChild ?? m) as HTMLElement).innerText.split('\nHover over a message')[0]!.trim() }));
  return {
    url: location.href, inCall, body,
    joinNow: has(/^Join now/) || has(/Join here too$/), otherWays: has(/Other ways to join/), askToJoin: has(/^Ask to join/), nameInput: !!document.querySelector('input[type=text][aria-label*="name" i], input[placeholder*="name" i]'),
    lobby,
    denied: /You can't join this video call|Someone in the call denied your request|denied your request to join|You were removed|You've been removed/i.test(body),
    ended: /You left the meeting|You've left the meeting|The call has ended|This call has ended|Call ended|Meeting ended|Return to home screen/i.test(body) && !inCall,
    captionsOn: !!region || has(/^Turn off captions/), captions,
    buttons: buttons.map(b => b.label || b.text).filter(Boolean).slice(0, 40),
    participants: names, tiles, peopleBadge: peopleBadge ? Number(peopleBadge) : null,
    selfName: document.querySelector('[data-self-name]')?.getAttribute('data-self-name') ?? null,
    chat,
  };
}
export type MeetPage = ReturnType<typeof readMeetPage>;

/**
 * Decides when an entered notetaker is alone long enough to leave. Before anyone else has been seen, being
 * the only one in the call means "early", not "everyone left": the grace starts only after another
 * participant has been present, or after admitUntil (scheduled start plus the lobby wait) with nobody arriving.
 */
export class AloneWatch {
  private since: number | null = null;
  seenOthers = false;
  constructor(private readonly graceMs: number, private readonly admitUntil: number) {}
  /** Feeds one observation; true when the notetaker should leave because it is alone. */
  update(others: number | null, now: number): boolean {
    if (others !== null && others > 0) { this.seenOthers = true; this.since = null; return false; }
    if (others !== 0 || (!this.seenOthers && now <= this.admitUntil)) { this.since = null; return false; }
    this.since ??= now;
    return now - this.since >= this.graceMs;
  }
}

/**
 * Whether the notetaker is really in the call, and not in Meet's waiting room. Meet's newer waiting room is drawn
 * inside the call screen (it has a Leave call button), and its wording changes, so the lobby text alone can't be
 * trusted: on November 2, 2026 the notetaker sat 17 minutes in Morgan's "Zoom Info Catch-up" taking that screen for
 * the call (captions never turned on, nobody else ever seen, and Google's Meet API shows it never joined the
 * conference). The call is confirmed only by something the waiting room never has: captions on, or someone else in
 * the call. Until then it counts as the lobby (after LOBBY_AFTER_MS, so a normal entry that confirms within seconds
 * never pings the host), and an entry still unconfirmed at admitUntil was not let in.
 */
export const LOBBY_AFTER_MS = 20_000;
export type EntryStep = 'entered' | 'waiting' | 'lobby' | 'not-admitted';
export class EntryWatch {
  confirmed = false;
  lobby = false;
  constructor(readonly since: number, readonly admitUntil: number) {}
  /** Feeds one observation; returns 'entered' and 'lobby' once each, when they first become true. */
  update(seen: { captionsOn: boolean; others: number | null }, now: number): EntryStep {
    if (this.confirmed) return 'waiting';
    if (seen.captionsOn || (seen.others ?? 0) > 0) { this.confirmed = true; return 'entered'; }
    if (now > this.admitUntil) return 'not-admitted';
    if (!this.lobby && now - this.since >= LOBBY_AFTER_MS) { this.lobby = true; return 'lobby'; }
    return 'waiting';
  }
}

/**
 * A refusal by a person in the call (the knock denied, or removed) is 'removed': a withdrawal, never handed to Recall.
 * Meet refusing the account itself ("You can't join this video call") is 'denied', which Recall may still try.
 */
export const refusal = (body: string): 'removed' | 'denied' =>
  /denied your request|You were removed|You've been removed/i.test(body) ? 'removed' : 'denied';

/** Why an alone notetaker leaves: null when others had been there (the usual "everyone else had left"). */
export const aloneDetail = (seenOthers: boolean) => seenOthers ? null : 'nobody else joined the call';

/** How long to wait before opening the meeting. */
export function enterDelay(request: Pick<JoinerRequest, 'enterAt'>, now: number): number {
  return request.enterAt === undefined ? 0 : Math.max(0, request.enterAt - now);
}

/**
 * Whether a call that ended under the notetaker should be entered again rather than finishing the session:
 * Meet ended an empty call (nobody else ever came) and the admission window is still open, so the real
 * meeting has not happened yet.
 */
export function rejoinAfterEmptyEnd(seenOthers: boolean, denied: boolean, now: number, admitUntil: number): boolean {
  return !seenOthers && !denied && now < admitUntil;
}

/** Meet's device prompt ("Continue without microphone and camera") can appear in the call too; it blocks captions and chat. */
async function dismissPrompts(page: Page): Promise<void> {
  for (const text of ['Continue without microphone and camera', 'Continue without microphone', 'Got it', 'Dismiss']) {
    const l = page.getByText(text, { exact: true }).first(); if (await l.count().catch(() => 0)) await l.click({ timeout: 3000 }).catch(() => {});
  }
}

/** How many people besides the notetaker are in the call, or null when the page doesn't say. */
export function othersPresent(page: Pick<MeetPage, 'participants' | 'peopleBadge' | 'tiles'>): number | null {
  if (page.peopleBadge !== null) return Math.max(0, page.peopleBadge - 1);
  if (page.participants.length) return page.participants.length - 1;
  if (page.tiles) return page.tiles - 1;
  return null;
}

type Browser = import('playwright-core').Browser;
type Page = import('playwright-core').Page;

export async function runJoiner(dir: string): Promise<LeaveReason> {
  const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')) as JoinerRequest;
  const emit = (event: JoinerEvent) => appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  const control = (): Control | null => { try { return JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')) as Control; } catch { return null; } };
  const now = () => Date.now();
  const children: ChildProcess[] = [];
  let browser: Browser | undefined;
  let cloud: string | null = null;
  let voice: ReturnType<typeof meetingVoice> | null = null;
  const profile = join(dir, 'profile');
  let stopping: string | null = null;
  process.on('SIGTERM', () => { stopping = 'service stopped'; });
  process.on('SIGINT', () => { stopping = 'service stopped'; });
  const finish = (reason: LeaveReason, detail: string | null) => { emit({ kind: 'state', state: 'left', at: now(), reason, detail }); return reason; };
  try {
    emit({ kind: 'state', state: 'starting', at: now() });
    // Wait outside any browser (a cloud browser bills while it runs) until shortly before the start.
    for (let wait = enterDelay(request, now()); wait > 0 && !stopping && !control(); wait = enterDelay(request, now()))
      await new Promise(resolve => setTimeout(resolve, Math.min(wait, 1000)));
    const early = control();
    if (early) return finish('control', early.leave);
    if (stopping) return finish('control', stopping);
    const { chromium } = await import('playwright-core');
    let page: Page;
    if (request.cloudProfile) {
      const remote = await startCloudBrowser(request.cloudProfile, cloudMinutes(request.capAt, now()), dir);
      cloud = remote.session;
      browser = await chromium.connectOverCDP(remote.cdp);
      const context = browser.contexts()[0] ?? await browser.newContext();
      await context.addInitScript('globalThis.__name ??= (f => f)');
      page = await context.newPage();
      for (const other of context.pages()) if (other !== page) await other.close().catch(() => {});
    } else {
      const display = await startXvfb(children);
      rmSync(profile, { recursive: true, force: true });
      if (request.profile === null) mkdirSync(profile, { recursive: true });
      else cpSync(request.profile, profile, { recursive: true, filter: src => !/(Singleton(Lock|Socket|Cookie)|DevToolsActivePort|\/Crashpad|\/GPUCache|\/Code Cache|\/Service Worker\/CacheStorage)/.test(src) });
      const chrome = spawn(request.chrome, [
        `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
        '--password-store=basic', '--disable-dev-shm-usage', '--window-size=1280,800', '--use-fake-ui-for-media-stream', '--lang=en-US',
        '--disable-features=Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required', 'about:blank',
      ], { env: { ...process.env, DISPLAY: display, LANG: 'en_US.UTF-8' }, stdio: 'ignore' });
      children.push(chrome);
      const port = await devtoolsPort(profile, 30_000);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0]!;
      await context.grantPermissions([], { origin: 'https://meet.google.com' }).catch(() => {});
      // Bundlers that wrap functions in a __name helper (tsx in tests) would break page.evaluate(readMeetPage).
      await context.addInitScript('globalThis.__name ??= (f => f)');
      page = context.pages()[0] ?? await context.newPage();
    }
    if (request.voice) {
      const meetPage = page;
      voice = meetingVoice(page.context(), request.voice, emit, text => sendChat(meetPage, text));
      await voice.install();
    }
    const v = voice;
    return await meet(page, request, emit, control, () => stopping, finish, v ? p => v.entered(p) : undefined, v ? p => v.observe(p.captions, p.participants) : undefined);
  } catch (error) {
    return finish('failed', error instanceof Error ? error.message.split('\n')[0]!.slice(0, 500) : String(error));
  } finally {
    await voice?.close().catch(() => {});
    await browser?.close().catch(() => {});
    // Stopping the cloud browser ends its billing and saves the profile's refreshed cookies.
    if (cloud) await stopCloudBrowser(cloud, dir).catch(error => console.error(`cloud browser ${cloud} did not stop: ${error instanceof Error ? error.message : String(error)}`));
    for (const child of children.reverse()) { try { child.kill('SIGKILL'); } catch {} }
    rmSync(profile, { recursive: true, force: true });
  }
}

export async function meet(page: Page, request: JoinerRequest, emit: (e: JoinerEvent) => void, control: () => Control | null, stopping: () => string | null,
  finish: (reason: LeaveReason, detail: string | null) => LeaveReason, entered?: (page: Page) => Promise<void>, observe?: (snapshot: MeetPage) => Promise<void>): Promise<LeaveReason> {
  const now = () => Date.now();
  const read = () => page.evaluate(readMeetPage);
  const clickButton = async (name: RegExp) => {
    for (const b of [page.getByRole('button', { name }).first(), page.locator('button,[role=button]').filter({ hasText: name }).first()]) {
      if (await b.count()) { await b.click({ timeout: 5000 }); return true; }
    }
    return false;
  };
  await page.goto(request.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  emit({ kind: 'state', state: 'prejoin', at: now() });
  // Prejoin: dismiss device prompts, give a name when signed out, then join or knock.
  let knocked = false, clicked: 'join' | 'ask' = 'join';
  for (const deadline = now() + 90_000; !knocked;) {
    if (now() > deadline) return finish('failed', 'the join button never appeared');
    const c = control(); if (c) return finish('control', c.leave);
    if (stopping()) return finish('control', stopping());
    await dismissPrompts(page);
    const p = await read();
    if (p.denied) return finish(refusal(p.body), firstLine(p.body, /can't join|denied|removed/i));
    if (p.nameInput) await page.locator('input[type=text][aria-label*="name" i], input[placeholder*="name" i]').first().fill(request.displayName).catch(() => {});
    // "Join here too": Kenan's account is already in the call on another device; never "Switch here", which would move it.
    // Meet prefixes some button texts with their icon's name ("add_to_queueJoin here too").
    if (p.joinNow) knocked = await clickButton(/^Join now|Join here too$/);
    // With Kenan's account already in the call, "Join here too" sits under the collapsed "Other ways to join".
    else if (p.otherWays && !p.askToJoin) { await clickButton(/^Other ways to join/).catch(() => false); await page.waitForTimeout(1000); }
    else if (p.askToJoin) { knocked = await clickButton(/^Ask to join/); clicked = 'ask'; }
    else await page.waitForTimeout(1000);
  }
  // Lobby: wait to be let in.
  let announcedLobby = false;
  for (;;) {
    await page.waitForTimeout(1000);
    const p = await read();
    if (p.inCall) break;
    if (p.denied) return finish(refusal(p.body), firstLine(p.body, /can't join|denied|removed/i));
    if (p.lobby && !announcedLobby) { emit({ kind: 'state', state: 'lobby', at: now() }); announcedLobby = true; }
    const c = control(); if (c) { await clickButton(/^Cancel request$/).catch(() => false); return finish('control', c.leave); }
    if (stopping()) return finish('control', stopping());
    if (now() > request.admitUntil) { await clickButton(/^Cancel request$/).catch(() => false); return finish('not-admitted', 'nobody let the notetaker in'); }
  }
  // Not "entered" yet: the waiting room looks like the call (see EntryWatch); captions or another person confirm it.
  const entry = new EntryWatch(now(), request.admitUntil);
  entry.lobby = announcedLobby;
  await dismissPrompts(page);
  emit({ kind: 'captions', at: now(), ...(await turnOnCaptions(page)) });

  const tracker = new CaptionTracker(4000);
  const alone = new AloneWatch(request.aloneGraceMs, request.admitUntil);
  let announced = false, announceAt = 0;
  let lastNames = '';
  const seenChat = new Set<string>();
  let captionCheckAt = now() + 15_000;
  const leave = async (reason: LeaveReason, detail: string | null) => {
    for (const c of tracker.flush(now())) emit(c);
    await clickButton(/^Leave call$/).catch(() => false);
    await page.waitForTimeout(1500);
    return finish(reason, detail);
  };
  // A leave request is announced in the chat and carried out after a short grace, so a misheard one can be taken back
  // ("Kenan, stay"); a second request during the grace, or the grace running out, leaves (2026-11-02 false leave).
  const asked = new LeaveGrace(LEAVE_GRACE_MS);
  const heard = async (who: string, text: string, said: boolean): Promise<LeaveReason | null> => {
    const detail = `${who} ${said ? 'said' : 'wrote'}: ${text}`;
    if (asked.pending && asksToStay(text, DEFAULT_WAKE_NAMES)) { asked.cancel(); await sendChat(page, 'Staying, since you asked.').catch(() => false); return null; }
    if (!asksToLeave(text, DEFAULT_WAKE_NAMES)) return null;
    if (asked.request(detail, now()) === 'leave') return leave('asked', asked.detail);
    await sendChat(page, `Leaving in ${Math.round(LEAVE_GRACE_MS / 1000)} seconds, since you asked. Say "Kenan, stay" to cancel.`).catch(() => false);
    return null;
  };
  for (;;) {
    await page.waitForTimeout(1000);
    let p: MeetPage;
    try { p = await read(); } catch (error) { return finish('failed', `the Meet page stopped responding: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
    await observe?.(p).catch(() => {});
    for (const c of tracker.update(p.captions, now())) {
      emit(c);
      // Meet captions the notetaker's own voice as "You": Kenan saying its own name is never a request to leave.
      if (c.speaker === 'You') continue;
      const done = await heard(c.speaker ?? 'someone', c.text, true);
      if (done) return done;
    }
    for (const m of p.chat) {
      if (seenChat.has(m.id)) continue;
      seenChat.add(m.id);
      if (m.text.includes(request.announcement) || m.from === 'You') continue;
      emit({ kind: 'chat', from: m.from, text: m.text, at: now() });
      const done = await heard(m.from ?? 'someone', m.text, false);
      if (done) return done;
    }
    if (asked.due(now())) { await sendChat(page, 'Leaving now, since you asked.').catch(() => false); return leave('asked', asked.detail); }
    const names = JSON.stringify(p.participants);
    if (names !== lastNames) { lastNames = names; emit({ kind: 'participants', names: p.participants, at: now() }); }
    if (!p.inCall) {
      // Meet ends a call nobody else has joined yet; the real meeting is still to come, so go back in.
      if (rejoinAfterEmptyEnd(alone.seenOthers, p.denied, now(), request.admitUntil)) {
        for (const c of tracker.flush(now())) emit(c);
        await page.waitForTimeout(Math.max(5000, enterDelay(request, now())));
        return meet(page, request, emit, control, stopping, finish, entered);
      }
      // Never confirmed in the call: the waiting room ended (refused, or the knock timed out), not the meeting.
      if (!entry.confirmed) return finish(p.denied ? refusal(p.body) : 'not-admitted', firstLine(p.body, /can't join|denied|removed|responded|left|ended|return/i));
      return finish(p.denied ? 'removed' : 'ended', firstLine(p.body, /left|ended|removed|return/i));
    }
    const step = entry.update({ captionsOn: p.captionsOn, others: othersPresent(p) }, now());
    if (step === 'entered') { emit({ kind: 'state', state: 'entered', at: now() }); await entered?.(page); }
    if (step === 'lobby') {
      emit({ kind: 'state', state: 'lobby', at: now() });
      emit({ kind: 'page', at: now(), why: 'no captions and nobody else: still waiting to be let in', clicked, buttons: p.buttons, text: p.body.slice(0, 400) });
    }
    if (step === 'not-admitted') {
      emit({ kind: 'page', at: now(), why: 'never confirmed in the call', clicked, buttons: p.buttons, text: p.body.slice(0, 400) });
      return leave('not-admitted', 'nobody let the notetaker in: captions never turned on and nobody else was seen');
    }
    if (entry.confirmed && alone.update(othersPresent(p), now())) return leave('alone', aloneDetail(alone.seenOthers));
    if (!p.captionsOn && now() > captionCheckAt) { captionCheckAt = now() + (entry.confirmed ? 30_000 : 15_000); await dismissPrompts(page); emit({ kind: 'captions', at: now(), ...(await turnOnCaptions(page)) }); }
    if (!announced && alone.seenOthers && now() > announceAt) {
      announceAt = now() + 15_000;
      await dismissPrompts(page);
      const sent = await sendChat(page, request.announcement);
      announced = sent.ok;
      emit({ kind: 'announced', at: now(), ...sent });
    }
    const c = control(); if (c) return leave('control', c.leave);
    if (stopping()) return leave('control', stopping());
    if (now() >= request.capAt) return leave('cap', null);
  }
}

async function turnOnCaptions(page: Page): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const on = page.getByRole('button', { name: /^Turn on captions/ }).first();
    if (await on.count()) await on.click({ timeout: 5000 });
    else await page.keyboard.press('c');
    await page.waitForTimeout(1500);
    const p = await page.evaluate(readMeetPage);
    return p.captionsOn ? { ok: true, detail: null } : { ok: false, detail: 'captions did not turn on' };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message.split('\n')[0]! : String(error) }; }
}

async function sendChat(page: Page, text: string): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const box = page.getByRole('textbox', { name: /send a message/i }).first();
    if (!await box.count()) await page.getByRole('button', { name: /^Chat with everyone/ }).first().click({ timeout: 5000 });
    await box.waitFor({ timeout: 10_000 });
    await box.fill(text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    return { ok: true, detail: null };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message.split('\n')[0]! : String(error) }; }
}

const firstLine = (body: string, re: RegExp) => body.split('\n').map(s => s.trim()).find(s => re.test(s))?.slice(0, 200) ?? null;

export function startXvfb(children: ChildProcess[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    children.push(xvfb);
    let out = '';
    const timer = setTimeout(() => reject(new Error('Xvfb did not start')), 15_000);
    (xvfb.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => { out += d.toString(); if (out.includes('\n')) { clearTimeout(timer); resolve(`:${out.trim()}`); } });
    xvfb.once('exit', code => { clearTimeout(timer); reject(new Error(`Xvfb exited (${code})`)); });
  });
}

export async function devtoolsPort(profile: string, timeoutMs: number): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise(r => setTimeout(r, 200))) {
    if (existsSync(file)) { const port = Number(readFileSync(file, 'utf8').split('\n')[0]); if (port > 0) return port; }
  }
  throw new Error('Chrome did not open its debugging port');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: meeting-joiner.js DIR'); process.exit(2); }
  mkdirSync(dir, { recursive: true });
  runJoiner(dir).then(reason => process.exit(reason === 'failed' ? 1 : 0), error => { console.error(error); process.exit(1); });
}
