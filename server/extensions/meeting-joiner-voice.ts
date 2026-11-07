/// <reference lib="dom" />
/**
 * Voice and screen share for Kenan's own Meet notetaker (meeting-joiner.ts). Meet itself is the bot: a script installed in
 * the Meet page before Meet loads gives Meet a microphone that is GPT Live's voice, and a screen that is a canvas this
 * process paints with pictures of the presentation tab.
 *
 * GPT LIVE HAS NO TURNS (the full note is at the top of phone-bridge.ts). The page streams the call's audio (every remote
 * audio track of Meet's own peer connections, mixed) to GPT Live and GPT Live's voice into Meet's microphone,
 * continuously, both at once. Nothing here detects speech, opens or closes anything on who is talking, or tells the model
 * when to speak; it is told who it is and decides. The one exception is privacy: the server can mute the voice for a few
 * seconds when GPT Live starts saying a private name.
 *
 * Signalling goes through this process (an exposed binding), never from the page, so Meet's content security policy is
 * not involved: the page hands its SDP offer to the binding, this process posts it to the meeting voice runtime's
 * /voice/start with the session's capability and hands back the answer. The runtime's control stream (server-sent
 * events) tells this process to mute, stop, share a page, stop sharing or write in the chat.
 */
import { meetingCaptionFact } from './meeting-caption-context.js';
import { CLIP_NOTE, type AckClip } from './meeting-voice-ack.js';
import type { BrowserContext, Page } from 'playwright-core';

/** What the server gives the joiner for a meeting with voice (meeting-voice.ts prepare). */
export interface JoinerVoice {
  /** POST {sdp} with x-kenan-meeting-capability: answers {ok, value: {sessionId, sdp, boot}}. */
  startUrl: string;
  /** POST `${endBase}/${voiceSessionId}/end` ends one voice session. */
  endBase: string;
  /**
   * Server-sent control events: hello {boot}, mute {ms}, stop {reason}, share {url}, slide {index}, unshare, chat {text},
   * heartbeat, and the request desk's spoken acknowledgements: clips {clips} (base64 WAV by name) and clip {clip, recentMs}.
   */
  controlUrl: string;
  capability: string;
  wakeNames?: string[];
}

/** What the voice side reports into the joiner's events (for diagnosis and the server's view of it). */
export type VoiceNote = { kind: 'voice'; at: number; what: 'started' | 'failed' | 'stopped' | 'unmuted' | 'sharing' | 'share-failed' | 'unshared' | 'slide' | 'chat' | 'levels' | 'ack'; detail: string | null };

/**
 * Runs in the Meet page before Meet's own scripts (addInitScript): self-contained, no imports, no closures over this
 * module. Installs window.__kenanVoice. Signalling calls window.__kenanSignal (the binding). `ackNotes` (CLIP_NOTE) is
 * passed in by the init script (meetVoiceScript), never imported here.
 */
export function installMeetVoice(ackNotes?: Record<AckClip, string>) {
  const w = window as any;
  if (w.__kenanVoice) return;
  const NativePC: typeof RTCPeerConnection = w.RTCPeerConnection;
  const AudioCtx: typeof AudioContext = w.AudioContext;
  if (!NativePC || !AudioCtx || !navigator.mediaDevices) return;
  const ctx = new AudioCtx({ sampleRate: 48000 });
  /** The call as Kenan hears it: every remote audio track Meet receives, mixed. */
  const heard = ctx.createMediaStreamDestination();
  /** Kenan's microphone in Meet: GPT Live's voice through a gain (0 only during a privacy mute). */
  const mic = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.connect(mic);
  // Loudest sample heard from the call and sent as Kenan's voice since the last state() read: whether audio really flows.
  const meter = () => { const an = ctx.createAnalyser(); an.fftSize = 2048; return { an, peak: 0 }; };
  const heardMeter = meter(), voiceMeter = meter();
  gain.connect(voiceMeter.an);
  const samples = new Float32Array(2048);
  setInterval(() => { for (const m of [heardMeter, voiceMeter]) { m.an.getFloatTimeDomainData(samples); for (const x of samples) m.peak = Math.max(m.peak, Math.abs(x)); } }, 100);
  // Chrome only lets a remote WebRTC track's audio into Web Audio while a media element plays it; muted elements keep it flowing.
  const sinks: HTMLAudioElement[] = [];
  const play = (stream: MediaStream) => { const el = new Audio(); el.muted = true; el.srcObject = stream; void el.play().catch(() => {}); sinks.push(el); };
  // Two ways the call's audio can reach Kenan. Meet may decode and play it itself through Web Audio (in the Browser Use
  // cloud browser on 2026-11-02, its received tracks decoded to silence: packets arrived with zero audio energy), so
  // whatever any other audio context in the page sends to its speakers is heard; and the received tracks themselves, used
  // only while the speakers path is silent, so nothing is heard twice.
  const fromTracks = ctx.createGain(), fromSpeakers = ctx.createGain();
  for (const bus of [fromTracks, fromSpeakers]) { bus.connect(heard); bus.connect(heardMeter.an); }
  const speakersMeter = meter();
  fromSpeakers.connect(speakersMeter.an);
  let speakersAt = 0;
  setInterval(() => {
    speakersMeter.an.getFloatTimeDomainData(samples);
    if (samples.some(x => Math.abs(x) > 0.002)) speakersAt = Date.now();
    fromTracks.gain.setTargetAtTime(Date.now() - speakersAt < 2000 ? 0 : 1, ctx.currentTime, 0.05);
  }, 100);
  const tapped = new Set<string>();
  const tap = (track: MediaStreamTrack) => {
    if (track.kind !== 'audio' || tapped.has(track.id)) return;
    tapped.add(track.id);
    const stream = new MediaStream([track]);
    play(stream);
    ctx.createMediaStreamSource(stream).connect(fromTracks);
  };
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: any[]) => any;
  const speakers = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>();
  (AudioNode.prototype as any).connect = function (this: AudioNode, ...args: any[]) {
    const result = connect.apply(this, args);
    try {
      const target = args[0], other = this.context;
      if (target instanceof AudioDestinationNode && other !== ctx && other instanceof AudioCtx) {
        let out = speakers.get(other);
        if (!out) { out = other.createMediaStreamDestination(); speakers.set(other, out); ctx.createMediaStreamSource(out.stream).connect(fromSpeakers); }
        connect.call(this, out);
      }
    } catch { /* never disturb Meet's own audio */ }
    return result;
  };
  const meetPCs: RTCPeerConnection[] = [];
  class TappedPC extends NativePC {
    constructor(...args: any[]) { super(...(args as [RTCConfiguration?])); meetPCs.push(this); this.addEventListener('track', (e: RTCTrackEvent) => tap(e.track)); }
  }
  // A receiver Meet set up itself (addTransceiver) may never fire 'track': hear every audio receiver of every connection.
  setInterval(() => { for (const pc of meetPCs) if (pc.connectionState !== 'closed') for (const r of pc.getReceivers()) tap(r.track); }, 1000);
  w.RTCPeerConnection = TappedPC;
  if (w.webkitRTCPeerConnection) w.webkitRTCPeerConnection = TappedPC;

  // ---- devices: Kenan's microphone is GPT Live's voice; there is no camera; the screen is a canvas.
  const media = navigator.mediaDevices;
  const device = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: 'kenan', toJSON() { return { kind, deviceId, label, groupId: 'kenan' }; } });
  media.enumerateDevices = async () => [device('audioinput', 'default', 'Kenan voice'), device('audiooutput', 'default', 'Kenan hearing')] as any;
  media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (constraints?.video && !constraints.audio) throw new DOMException('Requested device not found', 'NotFoundError');
    void ctx.resume().catch(() => {});
    return new MediaStream(constraints?.audio ? [mic.stream.getAudioTracks()[0]!.clone()] : []);
  };
  const permissions = navigator.permissions;
  if (permissions?.query) {
    const query = permissions.query.bind(permissions);
    permissions.query = (async (d: PermissionDescriptor) => (d?.name as string) === 'microphone' ? ({ state: 'granted', name: 'microphone', onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }) : query(d)) as any;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const g = canvas.getContext('2d')!;
  let picture: HTMLImageElement | null = null, share: MediaStreamTrack | null = null;
  const draw = () => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
    if (picture) { const s = Math.min(canvas.width / picture.width, canvas.height / picture.height); g.drawImage(picture, (canvas.width - picture.width * s) / 2, (canvas.height - picture.height * s) / 2, picture.width * s, picture.height * s); }
  };
  // A canvas stream only carries frames when the canvas is painted; repaint while sharing, at the stream's frame rate.
  setInterval(() => { if (share && share.readyState === 'live') draw(); }, 100);
  media.getDisplayMedia = async () => {
    draw();
    const stream = canvas.captureStream(10);
    share = stream.getVideoTracks()[0]!;
    share.contentHint = 'detail';
    // November 4 (Alice / Taylor Sync): Meet answered a bare canvas track with "Can't share your screen. Something went
    // wrong", because a canvas track reports no displaySurface. Report it as the whole-screen capture Meet asked for.
    const track = share, settings = track.getSettings.bind(track);
    track.getSettings = () => ({ ...settings(), displaySurface: 'monitor', logicalSurface: true, cursor: 'never' } as MediaTrackSettings);
    if (track.getCapabilities) { const capabilities = track.getCapabilities.bind(track); track.getCapabilities = () => ({ ...capabilities(), displaySurface: 'monitor', logicalSurface: true, cursor: ['never'] } as MediaTrackCapabilities); }
    try { Object.defineProperty(track, 'label', { value: 'screen:0:0', configurable: true }); } catch { /* read-only label */ }
    return stream;
  };

  // ---- GPT Live
  let captionChannel: RTCDataChannel | null = null, captionFacts = 0;
  let pc: RTCPeerConnection | null = null, sessionId: string | null = null, boot: string | null = null, stopped = false, starting = false, mutedUntil = 0, attempts = 0;
  const applyMute = () => gain.gain.setTargetAtTime(!stopped && Date.now() >= mutedUntil ? 1 : 0, ctx.currentTime, 0.015);
  setInterval(applyMute, 100);
  // ---- the request desk's spoken acknowledgements (meeting-voice-ack.ts): a recorded line plays into the privacy gain on
  // the desk's command. GPT Live's own audio is untouched; it is only metered, so a line never starts while GPT Live is
  // talking (or talked within `recentMs`) and stops as soon as GPT Live is heard.
  const liveMeter = ctx.createAnalyser(); liveMeter.fftSize = 2048;
  const clipBuffers = new Map<string, AudioBuffer>();
  let clipSource: AudioBufferSourceNode | null = null, liveHeardAt = -1e15;
  const liveSamples = new Float32Array(2048);
  setInterval(() => {
    liveMeter.getFloatTimeDomainData(liveSamples);
    let peak = 0; for (const x of liveSamples) peak = Math.max(peak, Math.abs(x));
    if (peak < 0.02) return;
    liveHeardAt = Date.now();
    if (clipSource) { try { clipSource.stop(); } catch { /* ended */ } clipSource = null; ackNote('yielded'); }
  }, 40);
  const ackNote = (detail: string) => { void Promise.resolve(w.__kenanSignal?.({ op: 'note', what: 'ack', detail })).catch(() => {}); };
  const signal = (message: unknown) => w.__kenanSignal(message);
  async function teardown() {
    captionChannel = null;
    const id = sessionId; sessionId = null;
    if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; }
    if (id) await signal({ op: 'end', sessionId: id }).catch(() => {});
  }
  async function start(): Promise<string> {
    if (stopped) return 'stopped';
    if (pc || starting) return 'running';
    starting = true;
    try {
      await ctx.resume().catch(() => {});
      const peer = new NativePC();
      pc = peer;
      peer.addTrack(heard.stream.getAudioTracks()[0]!, heard.stream);
      peer.ontrack = (e: RTCTrackEvent) => { const stream = e.streams[0] ?? new MediaStream([e.track]); play(stream); const source = ctx.createMediaStreamSource(stream); source.connect(gain); source.connect(liveMeter); };
      peer.onconnectionstatechange = () => { if (pc === peer && (peer.connectionState === 'failed' || peer.connectionState === 'closed') && !stopped) void teardown().then(retry); };
      const channel = peer.createDataChannel('oai-events');
      captionChannel = channel;
      channel.onmessage = (m: MessageEvent) => { let e: any; try { e = JSON.parse(m.data); } catch { return; } if (e.type === 'session.closed' && pc === peer && !stopped) void teardown().then(retry); };
      await peer.setLocalDescription(await peer.createOffer());
      const answer = await signal({ op: 'start', sdp: peer.localDescription!.sdp });
      if (!answer?.ok) throw new Error(answer?.error?.message ?? 'voice start refused');
      sessionId = answer.value.sessionId; boot = answer.value.boot;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.value.sdp });
      attempts = 0;
      return 'started';
    } catch (error) {
      await teardown();
      retry();
      throw error;
    } finally { starting = false; }
  }
  function retry() { if (!stopped && attempts < 6) { attempts++; setTimeout(() => { void start().catch(() => {}); }, 3000 * attempts); } }
  w.__kenanVoice = {
    start,
    /** The server's boot changed (a restart): its voice sessions are gone, so start a new one. */
    async hello(serverBoot: string) { if (boot && serverBoot !== boot && !stopped) { await teardown(); attempts = 0; return start(); } return 'same'; },
    captionFact(content: string) {
      if (captionChannel?.readyState !== 'open') return false;
      try { captionChannel.send(JSON.stringify({ type: 'session.thinking.append', event_id: crypto.randomUUID(), delegation_id: null, content })); captionFacts++; return true; } catch { return false; }
    },
    mute(ms: number) { mutedUntil = Date.now() + ms; applyMute(); },
    /** The desk's recorded lines, base64 WAV by name, decoded once. */
    async clips(clips: Record<string, string>) {
      for (const [name, b64] of Object.entries(clips)) {
        try { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); clipBuffers.set(name, await ctx.decodeAudioData(bytes.buffer)); } catch { /* left without that line */ }
      }
      return [...clipBuffers.keys()];
    },
    /** Plays one line now, unless it can't be heard as Kenan's own (muted, stopped, missing) or GPT Live is or was just talking. */
    clip(name: string, recentMs: number) {
      const now = Date.now(), buffer = clipBuffers.get(name);
      const why = !buffer ? 'missing' : stopped ? 'stopped' : now < mutedUntil ? 'muted' : now - liveHeardAt < recentMs ? 'voice' : clipSource ? 'playing' : '';
      if (why || !buffer) { ackNote(`skipped:${name}:${why}`); return false; }
      const source = ctx.createBufferSource();
      source.buffer = buffer; source.connect(gain); source.start();
      source.onended = () => { if (clipSource === source) clipSource = null; };
      clipSource = source;
      const note = ackNotes?.[name as AckClip];
      if (note && captionChannel?.readyState === 'open') { try { captionChannel.send(JSON.stringify({ type: 'session.thinking.append', event_id: crypto.randomUUID(), delegation_id: null, content: note })); } catch { /* closed */ } }
      ackNote(`played:${name}`);
      return true;
    },
    async stop() { stopped = true; applyMute(); await teardown(); },
    paint(dataUrl: string) { const img = new Image(); img.onload = () => { picture = img; draw(); }; img.src = dataUrl; },
    unshare() { if (share) { share.stop(); share.dispatchEvent(new Event('ended')); share = null; } picture = null; },
    /** Meet's own connections as the page sees them: received audio packets and energy per track (for diagnosis). */
    async diagnose() {
      const out: unknown[] = [];
      for (const pc of meetPCs) {
        const inbound: unknown[] = [];
        try { (await pc.getStats()).forEach((r: any) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound.push({ packets: r.packetsReceived, energy: r.totalAudioEnergy, level: r.audioLevel, track: r.trackIdentifier }); }); } catch { /* closed */ }
        out.push({ state: pc.connectionState, receivers: pc.getReceivers().map(r => ({ kind: r.track.kind, muted: r.track.muted, ready: r.track.readyState, id: r.track.id, tapped: tapped.has(r.track.id) })), inbound });
      }
      return { frame: location.href, top: window.top === window, pcs: out };
    },
    state() {
      const levels = { heardPeak: Math.round(heardMeter.peak * 1000) / 1000, voicePeak: Math.round(voiceMeter.peak * 1000) / 1000 };
      heardMeter.peak = 0; voiceMeter.peak = 0;
      return { running: !!pc, sessionId, stopped, captionFacts, heardTracks: tapped.size, context: ctx.state, sharing: !!share && share.readyState === 'live', ...levels };
    },
  };
}

/** The Meet page's init script: installMeetVoice with the acknowledgement notes passed in. */
export function meetVoiceScript(): string {
  return `(${installMeetVoice.toString()})(${JSON.stringify(CLIP_NOTE)});`;
}

/** Matches Meet's controls (labels, or button text that some versions prefix with the icon's name). */
/** Meet labels its muted microphone button "… on microphone (ctrl + d)". */
const MIC_OFF = /\bon microphone\b/i;
const SHARE = /^(Share screen|Present now)/i;
const SHARE_CHOICE = /(Your entire screen|A window|A tab)$/i;
const STOP_SHARE = /^(Stop presenting|Stop sharing)/i;
/** What Meet shows only once it really is presenting, and the dialog it shows when it refuses. */
const PRESENTING = /You are presenting/i;
const SHARE_REFUSED = /Can.t share your screen/i;

/**
 * The Node side for one Meet page: installs the page script and the signalling binding before Meet loads, then (once the
 * notetaker is in the call) starts the voice, unmutes Meet's microphone and follows the control stream.
 */
/** How often the presenting tab is pictured onto the shared canvas (a tick is skipped while a picture is still being taken). */
export const PAINT_INTERVAL_MS = 250;
/** How often, and for how long in all, Meet is checked for "You are presenting" after the Share screen clicks. */
export const SHARE_POLL_MS = 150;
export const SHARE_VERDICT_TIMEOUT_MS = 10_000;

export function meetingVoice(context: BrowserContext, voice: JoinerVoice, note: (n: VoiceNote) => void, sendChat: (text: string) => Promise<unknown>) {
  let page: Page | null = null, presenting: Page | null = null, painter: ReturnType<typeof setInterval> | null = null, levels: ReturnType<typeof setInterval> | null = null, listening = false, closed = false;
  /** Whether Meet is presenting our canvas now (its own "You are presenting" was seen, and nothing has stopped it since). */
  let inMeet = false, painting = false, prewarming: Promise<Page | null> | null = null;
  const now = () => Date.now();
  const headers = { 'content-type': 'application/json', 'x-kenan-meeting-capability': voice.capability };
  const evaluate = <T>(fn: string) => page!.evaluate(fn) as Promise<T>;
  const click = async (re: RegExp) => {
    for (const b of [page!.getByRole('button', { name: re }).first(), page!.locator('button,[role=button],[role=menuitem],li').filter({ hasText: re }).first()]) {
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 5000 }); return true; }
    }
    return false;
  };
  async function unmute() {
    if (!page) return;
    if (await click(MIC_OFF).catch(() => false)) note({ kind: 'voice', at: now(), what: 'unmuted', detail: null });
  }
  /**
   * The presenting tab, created once (about:blank at 1280x720) and kept: sharing navigates it, unsharing blanks it. Made
   * when the voice starts, so the first share does not wait for a new tab; the Meet page is brought back to the front.
   */
  function presentingTab(): Promise<Page | null> {
    if (presenting && !presenting.isClosed()) return Promise.resolve(presenting);
    prewarming ??= (async () => {
      const tab = await context.newPage();
      await tab.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
      presenting = tab;
      await page?.bringToFront().catch(() => {});
      return tab;
    })().catch(() => null).finally(() => { prewarming = null; });
    return prewarming;
  }
  /** One picture of the presenting tab onto the shared canvas, now. Skipped while the previous one is still being taken. */
  async function paint() {
    if (painting || !presenting || presenting.isClosed() || !page) return;
    painting = true;
    try {
      const shot = await presenting.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      if (shot) await page.evaluate(d => (window as any).__kenanVoice?.paint(d), `data:image/jpeg;base64,${shot.toString('base64')}`).catch(() => {});
    } finally { painting = false; }
  }
  /** Shows a page in the presenting tab: painted as soon as its document is parsed, and again once it has loaded. */
  async function show(url: string) {
    const tab = await presentingTab();
    if (!tab) throw new Error('the presenting tab could not be opened');
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await paint();
    void tab.waitForLoadState('load', { timeout: 30_000 }).then(() => paint()).catch(() => {});
    painter ??= setInterval(() => { void paint(); }, PAINT_INTERVAL_MS);
  }
  /** Whether Meet is presenting our canvas and its capture track is live (then a new page needs no new share). */
  async function stillPresenting() {
    if (!inMeet || !page) return false;
    const live = await evaluate<boolean>('!!window.__kenanVoice && window.__kenanVoice.state().sharing').catch(() => false);
    if (!live) inMeet = false;
    return live;
  }
  /**
   * Presents a page. When Meet is already presenting our canvas, only the presenting tab changes (no Meet clicks, no
   * stop and start); otherwise the first share goes through Meet's Share screen flow and waits for "You are presenting".
   */
  async function share(url: string): Promise<'switched' | 'shared'> {
    if (await stillPresenting()) { await show(url); return 'switched'; }
    await unshare(false);
    // The page loads in the presenting tab while Meet's share flow runs (November 6, 2026: loading first, then sharing,
    // took 3.5 to 4.5 s from present to "You are presenting"). Until its first picture the canvas is plain white.
    const loading = show(url);
    loading.catch(() => {});
    await page!.bringToFront().catch(() => {});
    if (!await click(SHARE)) { await loading.catch(() => {}); throw new Error("Meet's Share screen button was not found"); }
    // Meet may offer a choice (entire screen, window, tab) or go straight to the capture: take the choice as soon as it
    // appears instead of a fixed one-second wait (November 6, 2026: about 3.5 s from present to "You are presenting").
    for (const until = now() + 1500; now() < until;) {
      if (await click(SHARE_CHOICE).catch(() => false)) break;
      if (await evaluate<boolean>(`${PRESENTING}.test(document.body.innerText)`).catch(() => false)) break;
      await page!.waitForTimeout(100);
    }
    // Success is only what participants see: Meet's own "You are presenting". A live capture track or a Stop button
    // alone is not enough (Meet showed its refusal dialog while the old check reported sharing).
    for (const deadline = now() + SHARE_VERDICT_TIMEOUT_MS; now() < deadline;) {
      await page!.waitForTimeout(SHARE_POLL_MS);
      const shown = await evaluate<{ presenting: boolean; refused: string | null }>(`(() => { const t = document.body.innerText; const m = t.match(${SHARE_REFUSED})?.index; return { presenting: ${PRESENTING}.test(t) && !(m >= 0), refused: m >= 0 ? t.slice(m, m + 160).replace(/\\s+/g, ' ') : null }; })()`).catch(() => ({ presenting: false, refused: null }));
      if (shown.refused) {
        await page!.getByRole('button', { name: /^OK$/ }).first().click({ timeout: 2000 }).catch(() => {});
        await loading.catch(() => {});
        throw new Error(`Meet refused the screen share: ${shown.refused}`);
      }
      if (shown.presenting) { inMeet = true; await loading; return 'shared'; }
    }
    await loading.catch(() => {});
    throw new Error(`Meet did not show "You are presenting" within ${SHARE_VERDICT_TIMEOUT_MS / 1000} seconds`);
  }
  /** Stops presenting in Meet and blanks the presenting tab (kept open for the next share). */
  async function unshare(tell = true) {
    if (painter) { clearInterval(painter); painter = null; }
    inMeet = false;
    if (page) { await click(STOP_SHARE).catch(() => false); await evaluate('window.__kenanVoice?.unshare()').catch(() => {}); }
    if (presenting && !presenting.isClosed()) await presenting.goto('about:blank').catch(() => {});
    if (tell) note({ kind: 'voice', at: now(), what: 'unshared', detail: null });
  }
  /** Shows slide `index` of the deck in the presenting tab (no reload, no network) and repaints at once. */
  async function slide(index: number) {
    if (!presenting || presenting.isClosed()) return;
    await presenting.evaluate(i => (window as any).__kenanSlide?.(i), index).catch(() => {});
    await paint();
    note({ kind: 'voice', at: now(), what: 'slide', detail: String(index) });
  }
  async function onControl(event: { type?: string; boot?: string; ms?: number; reason?: string; url?: string; text?: string; index?: number; clips?: Record<string, string>; clip?: string; recentMs?: number }) {
    if (!page) return;
    switch (event.type) {
      case 'hello': if (event.boot) await page.evaluate(b => (window as any).__kenanVoice?.hello(b), event.boot).catch(() => {}); break;
      case 'mute': await page.evaluate(ms => (window as any).__kenanVoice?.mute(ms), event.ms ?? 6000).catch(() => {}); break;
      case 'clips': if (event.clips && typeof event.clips === 'object') await page.evaluate(c => (window as any).__kenanVoice?.clips?.(c), event.clips).catch(() => {}); break;
      case 'clip': if (event.clip === 'sure' || event.clip === 'check') await page.evaluate(([c, r]) => (window as any).__kenanVoice?.clip?.(c, r), [event.clip, event.recentMs ?? 1500] as const).catch(() => {}); break;
      case 'stop': await evaluate('window.__kenanVoice?.stop()').catch(() => {}); note({ kind: 'voice', at: now(), what: 'stopped', detail: event.reason ?? null }); break;
      case 'share':
        if (!event.url) break;
        try { const how = await share(event.url); note({ kind: 'voice', at: now(), what: 'sharing', detail: `${event.url.replace(/[?#].*$/, '')}${how === 'switched' ? ' (switched)' : ''}` }); }
        catch (error) { note({ kind: 'voice', at: now(), what: 'share-failed', detail: error instanceof Error ? error.message.split('\n')[0]! : String(error) }); await unshare(false); }
        break;
      case 'slide': if (typeof event.index === 'number' && Number.isInteger(event.index) && event.index >= 0) await slide(event.index); break;
      case 'unshare': await unshare(); break;
      case 'chat': if (event.text) { await sendChat(event.text); note({ kind: 'voice', at: now(), what: 'chat', detail: null }); } break;
    }
  }
  /** Follows the control stream until closed, reconnecting after a dropped connection (a server restart). */
  async function listen() {
    if (listening) return;
    listening = true;
    while (!closed) {
      try {
        const response = await fetch(voice.controlUrl, { headers: { accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error(`control ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (closed) break;
          buffer += decoder.decode(chunk, { stream: true });
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            let event: Record<string, unknown>; try { event = JSON.parse(data); } catch { continue; }
            await onControl(event as never);
          }
        }
      } catch { /* reconnect below */ }
      if (!closed) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  let lastCaptionFact = '';
  return {
    /** Supply current speaker attribution immediately; the durable transcript is still handled separately. */
    async observe(captions: {speaker: string | null; text: string}[], participants: string[]) {
      if (!page) return;
      const latest = captions.at(-1);
      if (!latest) return;
      const fact = meetingCaptionFact(latest.speaker, latest.text, participants, voice.wakeNames);
      if (fact === lastCaptionFact) return;
      const sent = await page.evaluate(content => (window as any).__kenanVoice?.captionFact(content) === true, fact).catch(() => false);
      if (sent) lastCaptionFact = fact;
    },
    /** Before the Meet page loads: the page script and the signalling binding. */
    async install() {
      await context.exposeBinding('__kenanSignal', async (_source, message: { op: string; sdp?: string; sessionId?: string; what?: string; detail?: unknown }) => {
        if (message?.op === 'start') {
          const response = await fetch(voice.startUrl, { method: 'POST', headers, body: JSON.stringify({ sdp: message.sdp }) });
          return response.json().catch(() => ({ ok: false, error: { message: `voice start answered ${response.status}` } }));
        }
        if (message?.op === 'note' && message.what === 'ack' && typeof message.detail === 'string') {
          note({ kind: 'voice', at: now(), what: 'ack', detail: message.detail.slice(0, 80) });
          return { ok: true };
        }
        if (message?.op === 'end' && message.sessionId && /^[A-Za-z0-9_-]{8,128}$/.test(message.sessionId)) {
          await fetch(`${voice.endBase}/${message.sessionId}/end`, { method: 'POST', headers, body: '{}' }).catch(() => {});
          return { ok: true };
        }
        return { ok: false, error: { message: 'unknown op' } };
      });
      await context.addInitScript({ content: meetVoiceScript() });
    },
    /** In the call: start the voice, unmute Meet's microphone and follow the control stream. Safe to call again. */
    async entered(meetPage: Page) {
      page = meetPage;
      try {
        const how = await evaluate<string>('window.__kenanVoice ? window.__kenanVoice.start() : "missing"');
        if (how === 'missing') throw new Error('the voice script is not in the Meet page');
        if (how === 'started') note({ kind: 'voice', at: now(), what: 'started', detail: null });
        await unmute();
      } catch (error) { note({ kind: 'voice', at: now(), what: 'failed', detail: error instanceof Error ? error.message.split('\n')[0]! : String(error) }); }
      void listen();
      void presentingTab();
      // Once a minute, how loud the call was and how loud Kenan was: the record of whether audio flows both ways.
      levels ??= setInterval(() => {
        void evaluate<{ heardPeak: number; voicePeak: number; heardTracks: number; captionFacts: number; running: boolean; context: string }>('window.__kenanVoice.state()')
          .then(s => note({ kind: 'voice', at: now(), what: 'levels', detail: `heard ${s.heardPeak} voice ${s.voicePeak} tracks ${s.heardTracks} caption facts ${s.captionFacts} ${s.running ? 'live' : 'down'} ${s.context}` })).catch(() => {});
      }, 60_000);
    },
    async close() {
      closed = true;
      if (levels) clearInterval(levels);
      await unshare(false).catch(() => {});
      if (presenting) { await presenting.close().catch(() => {}); presenting = null; }
      if (page) await evaluate('window.__kenanVoice?.stop()').catch(() => {});
    },
  };
}
