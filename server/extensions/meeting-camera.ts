// The pages a Recall bot renders: the camera page (Kenan's face and voice in the meeting) and the screen page (what
// Kenan presents). The camera controller runs in Recall's bot browser; it is embedded with Function.prototype.toString,
// so it stays self-contained.
// GPT Live has no turns (see the top of phone-bridge.ts): the page streams the meeting's audio in and GPT Live's voice
// out, continuously. It never gates the voice on who was addressed; only a privacy mute from the server silences it.
import { randomBytes } from 'node:crypto';
import { marked } from 'marked';

export type CameraPageConfig = {
  sessionId: string; capability: string; title: string;
  /** Same-origin paths under /pi-stack/hooks/meeting/<session>/. */
  voiceStartUrl: string; voiceEndBase: string; controlUrl: string;
};

/**
 * Hears the meeting (getUserMedia gives Recall's mixed meeting audio), talks to GPT Live over WebRTC and plays its voice
 * into the meeting as it comes. A control stream from the server mutes it for a few seconds when its words contain a
 * private name, and stops everything when Kenan leaves. A server restart (new boot) restarts the voice.
 */
export function installMeetingCamera(config: CameraPageConfig, env: any): any {
  const doc = env.document;
  const status = (text: string) => { const el = doc.getElementById('status'); if (el) el.textContent = text; };
  const caption = (text: string) => { const el = doc.getElementById('said'); if (el) el.textContent = text.slice(-160); };
  let mutedUntil = 0;
  let pc: any = null, ctx: any = null, gain: any = null, sessionId: string | null = null, boot: string | null = null, stopped = false, starting = false, attempts = 0, events: any = null;
  const headers = { 'content-type': 'application/json', 'x-kenan-meeting-capability': config.capability };
  const speaking = (open: boolean) => { const el = doc.getElementById('mic'); if (el) el.className = open ? 'on' : ''; };
  function applyMute() {
    if (!gain || !ctx) return;
    const on = !stopped && Date.now() >= mutedUntil;
    gain.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.015);
    speaking(on);
  }
  const timer = env.setInterval(applyMute, 50);
  async function teardown() {
    const id = sessionId; sessionId = null;
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (id) await env.fetch(`${config.voiceEndBase}/${encodeURIComponent(id)}/end`, { method: 'POST', headers, body: '{}', keepalive: true }).catch(() => {});
  }
  async function start() {
    if (stopped || starting || pc) return;
    starting = true; attempts++;
    try {
      status('Connecting voice…');
      const input = await env.navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = ctx ?? new env.AudioContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      gain = gain ?? ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);
      pc = new env.RTCPeerConnection();
      pc.ontrack = (event: any) => {
        if (event.track.kind !== 'audio') return;
        const stream = event.streams?.[0] ?? new env.MediaStream([event.track]);
        // Chrome only feeds remote WebRTC audio into Web Audio while a (muted) element plays it.
        const sink = doc.createElement('audio'); sink.muted = true; sink.autoplay = true; sink.srcObject = stream; doc.body.appendChild(sink);
        ctx.createMediaStreamSource(stream).connect(gain);
      };
      pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc?.connectionState) && !stopped) { void teardown().then(() => retry()); } };
      for (const track of input.getAudioTracks()) pc.addTrack(track, input);
      const channel = pc.createDataChannel('oai-events');
      channel.onmessage = (message: any) => {
        let event: any; try { event = JSON.parse(message.data); } catch { return; }
        if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') caption(event.delta);
        if (event.type === 'session.closed' && !stopped) { void teardown().then(() => retry()); }
      };
      await pc.setLocalDescription(await pc.createOffer());
      const response = await env.fetch(config.voiceStartUrl, { method: 'POST', headers, body: JSON.stringify({ sdp: pc.localDescription?.sdp }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw Object.assign(new Error(data.error?.message ?? `Voice start failed (${response.status})`), { status: response.status });
      sessionId = data.value.sessionId; boot = data.value.boot;
      await pc.setRemoteDescription({ type: 'answer', sdp: data.value.sdp });
      attempts = 0;
      status('Listening');
    } catch (error: any) {
      status(`Voice unavailable: ${String(error?.message ?? error)}`);
      await teardown();
      if (error?.status !== 404 && error?.status !== 429) retry();
    } finally { starting = false; }
  }
  function retry() { if (!stopped && attempts < 6) env.setTimeout(() => { void start(); }, 3000 * attempts); }
  function stop(reason: string) {
    stopped = true; applyMute(); env.clearInterval(timer);
    status(reason === 'leaving' ? 'Leaving the meeting' : 'Voice off · still taking notes');
    if (events) events.close();
    void teardown();
  }
  function listen() {
    events = new env.EventSource(config.controlUrl);
    events.onmessage = (message: any) => {
      let event: any; try { event = JSON.parse(message.data); } catch { return; }
      if (event.type === 'hello' && boot && event.boot !== boot && !stopped) { void teardown().then(() => start()); }
      // Privacy, not timing: the server mutes Kenan's voice for a few seconds when it starts saying a private name.
      if (event.type === 'mute') { mutedUntil = Date.now() + (event.ms ?? 6000); applyMute(); }
      if (event.type === 'stop') stop(event.reason);
    };
    // EventSource gives up on a non-200 answer (a 502 while the server restarts); listen again.
    events.onerror = () => { if (events.readyState === 2 && !stopped) env.setTimeout(listen, 3000); };
  }
  listen();
  void start();
  const api = { stop, get muted() { return Date.now() < mutedUntil; }, get sessionId() { return sessionId; } };
  env.kenanMeetingCamera = api;
  return api;
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderCameraPage(config: CameraPageConfig): string {
  for (const path of [config.voiceStartUrl, config.voiceEndBase, config.controlUrl]) {
    if (!path.startsWith('/') || !path.includes('/hooks/meeting/') || path.includes('//') || /[\\\r\n#]/.test(path)) throw new Error('Meeting hook route required');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escape(config.title)}</title>
<style>html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#111827;color:#fff;font-family:system-ui,sans-serif}
main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center}
.face{width:220px;height:220px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#7c8cff,#3b47c4);display:grid;place-items:center;font-size:96px;font-weight:700}
#mic{width:18px;height:18px;border-radius:50%;background:#374151;display:inline-block;margin-right:10px;vertical-align:middle}#mic.on{background:#22c55e;box-shadow:0 0 18px #22c55e}
h1{margin:0;font-size:48px}p{margin:0;font-size:26px;color:#d1d5db}small{font-size:20px;color:#9ca3af}#said{font-size:18px;color:#6b7280;max-width:1100px;height:24px;overflow:hidden}</style></head>
<body><main><div class="face">K</div><h1>Kenan</h1><p>Alice's AI notetaker · speaks only when addressed</p><p>Say "Kenan, please leave" to remove me</p><small><span id="mic"></span><span id="status">Starting…</span></small><div id="said"></div></main>
<script type="module">(${installMeetingCamera.toString()})(${embed(config)},window);</script></body></html>`;
}

export type Presentation = { version: number; format: 'html' | 'markdown' | 'text' | 'url' | 'slides'; content: string; title: string;
  /** Slides only: the slide showing now (0-based) and how many there are. */
  slide?: number; slides?: number };

/** The most slides one deck may have. */
export const MAX_SLIDES = 30;
/** One slide of a deck: its markdown as shown (speaker notes removed), its title and its speaker notes. */
export type Slide = { markdown: string; title: string; text: string; notes: string };
/**
 * A slide deck from markdown: a line holding only `---` separates slides (not inside a fenced code block), and lines
 * starting with `Note:` are speaker notes, kept for the voice and never shown. Throws when the deck is empty or has
 * more than MAX_SLIDES slides.
 */
export function parseSlides(content: string): Slide[] {
  const chunks: string[][] = [[]];
  let fence: string | null = null;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) fence = fence ? null : marker;
    if (!fence && /^\s*---\s*$/.test(line)) { chunks.push([]); continue; }
    chunks[chunks.length - 1]!.push(line);
  }
  const slides = chunks.map(lines => {
    const notes: string[] = [], shown: string[] = [];
    for (const line of lines) {
      const note = /^\s*Notes?:\s?(.*)$/.exec(line);
      if (note) notes.push(note[1]!.trim()); else shown.push(line);
    }
    const markdown = shown.join('\n').trim();
    const text = markdown.split('\n').map(plainLine).filter(Boolean).join('\n');
    const heading = /^\s*#{1,6}\s+(.+)$/m.exec(markdown)?.[1];
    return { markdown, title: plainLine(heading ?? text.split('\n')[0] ?? ''), text, notes: notes.filter(Boolean).join(' ') };
  }).filter(slide => slide.markdown || slide.notes);
  if (!slides.length) throw new Error('slides: the deck has no slides (separate slides with a line holding only ---)');
  if (slides.length > MAX_SLIDES) throw new Error(`slides: a deck may have at most ${MAX_SLIDES} slides (this one has ${slides.length})`);
  return slides;
}
/** One markdown line as plain spoken text: no heading marks, bullets, emphasis, link targets or table pipes. */
function plainLine(line: string): string {
  if (/^\s*\|?\s*:?-{3,}/.test(line) || /^\s*(`{3,}|~{3,})/.test(line)) return '';
  return line.replace(/<[^>]*>/g, '').replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '').replace(/\s*\|\s*/g, ' | ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s+/g, ' ').trim();
}
/** The slide index to show, clamped into the deck. */
export const clampSlide = (index: number, count: number) => Math.max(0, Math.min(count - 1, Math.trunc(Number.isFinite(index) ? index : 0)));

/**
 * The screen-share page: what Kenan presents, under a "Kenan is presenting" banner. HTML runs sandboxed without scripts.
 * Slides render every slide as a hidden section and show one; `window.__kenanSlide(i)` switches synchronously with no
 * network fetch, so the native notetaker can change slides by evaluating it and repainting at once. `slide` is the
 * initial slide (the screen URL's slide parameter, else the stored one).
 */
export function renderScreenPage(presentation: Presentation | null, slide?: number): string {
  const banner = '<div class="banner">Kenan is presenting</div>';
  let body: string, head = '';
  if (!presentation) body = '<main class="doc"><p>Nothing is being presented.</p></main>';
  else if (presentation.format === 'html') body = `<iframe sandbox="" srcdoc="${escape(presentation.content)}"></iframe>`;
  else if (presentation.format === 'markdown') body = `<main class="doc">${marked.parse(presentation.content, { async: false }) as string}</main>`;
  else if (presentation.format === 'text') body = `<main class="doc"><pre>${escape(presentation.content)}</pre></main>`;
  else if (presentation.format === 'slides') ({ body, head } = renderSlides(presentation, slide));
  else body = `<main class="doc"><p><a href="${escape(presentation.content)}">${escape(presentation.content)}</a></p></main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">${head}<title>${escape(presentation?.title ?? 'Kenan')}</title>
<style>html,body{margin:0;height:100%;background:#fff;color:#111;font-family:system-ui,sans-serif}.banner{position:fixed;top:0;left:0;right:0;height:36px;line-height:36px;padding:0 16px;background:#3b47c4;color:#fff;font-size:18px;z-index:2}
.doc{padding:56px 48px 24px;font-size:22px;line-height:1.5;max-width:1200px}.doc pre{white-space:pre-wrap}iframe{position:fixed;top:36px;left:0;width:100%;height:calc(100% - 36px);border:0}</style></head>
<body>${banner}${body}</body></html>`;
}

/**
 * A deck at 1280x720: large type, one slide visible, an "n / N" footer. Only this page's own script may run (a CSP
 * with a fresh nonce), so markdown in a slide can never run script, and nothing is fetched except images.
 */
function renderSlides(presentation: Presentation, slide?: number): { body: string; head: string } {
  const slides = parseSlides(presentation.content);
  const initial = clampSlide(slide ?? presentation.slide ?? 0, slides.length);
  const nonce = randomBytes(16).toString('base64');
  const sections = slides.map((s, i) => `<section class="slide"${i === initial ? '' : ' hidden'} data-slide="${i}">${marked.parse(s.markdown, { async: false }) as string}<footer>${i + 1} / ${slides.length}</footer></section>`).join('\n');
  const script = `(()=>{const all=[...document.querySelectorAll('section.slide')];window.__kenanSlide=i=>{const n=Math.max(0,Math.min(all.length-1,Math.trunc(Number(i))||0));all.forEach((s,k)=>{s.hidden=k!==n;});return n;};const q=new URLSearchParams(location.search).get('slide');if(q!==null&&/^\\d+$/.test(q))window.__kenanSlide(Number(q));})();`;
  const head = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>html,body{width:1280px;height:720px;overflow:hidden}.slide{position:fixed;top:36px;left:0;width:1280px;height:684px;box-sizing:border-box;padding:40px 80px 64px;overflow:hidden;font-size:36px;line-height:1.35}
.slide[hidden]{display:none}.slide h1{font-size:60px;line-height:1.1;margin:0 0 28px}.slide h2{font-size:46px;margin:0 0 22px}.slide h3{font-size:40px;margin:0 0 18px}.slide p{margin:0 0 18px}
.slide ul,.slide ol{margin:0 0 18px;padding-left:1.2em}.slide li{margin:0 0 10px}.slide table{border-collapse:collapse;font-size:28px;margin:8px 0}.slide th,.slide td{border:1px solid #c7cbe0;padding:8px 16px;text-align:left}
.slide th{background:#eef0fb}.slide code{font-size:0.85em}.slide img{max-width:100%;max-height:420px}.slide footer{position:absolute;right:32px;bottom:20px;font-size:20px;color:#6b7280}</style>`;
  return { head, body: `${sections}<script nonce="${nonce}">${script}</script>` };
}
