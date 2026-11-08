// Art behind the app (Bootstrap.background), loaded only for a person who chose some. Dave picked the starfield on
// 2026-10-22 from five live options: three depths of stars drifting a few pixels a second, some breathing, and every
// few seconds one glints. One fixed canvas under everything; it draws at most 30 times a second at the painter's own
// pixel-ratio cap (maxDpr), stops while the page is hidden and always starts again when it's back, and is a still frame under the system's reduced motion only when the person chose
// to follow it (skyMotionPref): Android turns that on with "Remove animations", and Alice wants her sky to move.
import type { Background } from '../../shared/contract.js';
import { typing } from '../typing.js';
import { api } from '../client.js';
import { sync } from '../sync.js';
import './sky.css';

/** Draws one kind of art into the layer's canvas. resize gets CSS pixels and the device pixel ratio already capped at
 *  maxDpr: the soft 2D starfield is drawn at 1.5, but forest's stars are points of light a device pixel or two across
 *  and must be drawn at the screen's own resolution (at 1.5 on Alice's 3× phone the canvas was stretched 2× and every
 *  star and the faint-star glow came out blurred, 2026-10-26).
 *  pixels: the most device pixels the canvas may have (a desktop at 2× is 7.6 M and made Safari take forest's WebGL context away, 2026-11-06; phones are under 4 M).
 *  lost: why the canvas can't draw until it is made again (a WebGL context the browser took away and hasn't given back), or null. */
type Painter = { fps: number; maxDpr: number; pixels: number; resize(width: number, height: number, dpr: number): void; frame(seconds: number, step: number): void; lost(): string | null; dispose(): void };

export type Sky = { followSystem(on: boolean): void; unmount(): void };

/** Watchdog period. Animation frames that stop arriving, a lost canvas or a draw that threw are put right within
 *  about this long of the page being shown; each showing gets TRIES fresh canvases before the failure is reported. */
const CHECK_MS = 1000;
const TRIES = 3;
/** Each failed canvas is made again with this share of the last one's pixels; forest that still can't draw falls back to the starfield. */
const SHRINK = 0.6;
/** How often the app sends the art's state to the server while the page shows (report below). */
const REPORT_MS = 30_000;

/** followSystem: true draws a still frame while the system asks for reduced motion; false always animates.
 *  failed hears when the art can't be drawn again on this showing of the page (no WebGL any more, say). */
export async function mountSky(wanted: Background, followSystem: boolean, failed: (error: unknown) => void): Promise<Sky> {
  let kind = wanted, shrink = 1;
  const host = document.createElement('div');
  host.className = `sky sky-${kind}`;
  host.setAttribute('aria-hidden', 'true');
  let seconds = 40, raf = 0, last = 0, owed = 0, lastTick = 0, lostChecks = 0, tries = 0, reported = false, gone = false;
  let frames = 0, refits = 0, stuck = 0, lastFrameAt = 0, kicks = 0, rebuilds = 0, lastError: string | null = null;
  let size: { width: number; height: number } | null = null;
  let rebuilding: Promise<void> | null = null;
  const fit = () => { if (size) painter.resize(size.width, size.height, Math.min(painter.maxDpr, devicePixelRatio || 1, Math.sqrt(painter.pixels * shrink / (size.width * size.height)))); };
  const draw = () => { if (size) painter.frame(seconds, 0); };
  let canvas = document.createElement('canvas');
  let painter: Painter;
  try { painter = await painterFor(kind, canvas, () => draw()); }
  catch (error) {
    if (kind === 'starfield') throw error;
    console.error(`the ${kind} sky can't start, drawing the starfield instead`, error);
    lastError = String(error instanceof Error ? error.message : error).slice(0, 300);
    kind = 'starfield'; host.className = `sky sky-${kind}`; canvas = document.createElement('canvas');
    painter = await painterFor(kind, canvas, () => draw());
  }
  host.appendChild(canvas);
  document.body.prepend(host);
  const unhold = holdThroughKeyboard(host, () => { if (gone || !size) return; refits++; fit(); draw(); schedule(); });
  document.documentElement.classList.add('sky-on');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const animating = () => !gone && size !== null && !document.hidden && sync.read() !== 'syncing' && !(followSystem && still.matches);

  /** A fresh canvas and painter in place of one that can't draw; the old one goes only once the new one works. */
  const rebuild = (why: unknown) => {
    if (rebuilding || gone) return;
    halt();
    lastError = String(why instanceof Error ? why.message : why).slice(0, 300);
    console.warn(`the ${kind} sky failed (${lastError}); making it again at ${Math.round(shrink * SHRINK * 100)}% of the pixels`);
    if (tries >= TRIES) {
      if (kind === 'starfield') { if (!reported) { reported = true; failed(why); } return; }
      kind = 'starfield'; host.className = `sky sky-${kind}`; tries = 0; shrink = 1;
    } else shrink *= SHRINK;
    tries++; rebuilds++;
    report('rebuild');
    rebuilding = (async () => {
      const next = document.createElement('canvas');
      const made = await painterFor(kind, next, () => draw()).then(p => ({ ok: true as const, p }), (error: unknown) => ({ ok: false as const, error }));
      if (!made.ok) { rebuilding = null; if (!gone && !reported) { reported = true; failed(made.error); } return; }
      if (gone) { made.p.dispose(); return; }
      const old = painter;
      host.replaceChild(next, canvas);
      canvas = next; painter = made.p;
      old.dispose();
      resized.disconnect(); resized.observe(canvas);
      lostChecks = 0; rebuilding = null;
      fit(); draw(); schedule();
    })();
  };
  /** Time is read from the page clock, not the frame's timestamp: after the keyboard is closed with the back swipe,
   *  Alice's Android app WebView kept delivering frames whose timestamps lagged the clock, so time measured between
   *  them went backwards and no frame was ever due again (2026-10-25). */
  const tick = () => {
    raf = 0;
    const now = performance.now();
    lastTick = now;
    owed += Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (owed + 0.004 >= 1 / painter.fps) {
      seconds += owed;
      const step = owed;
      owed = 0;
      try { painter.frame(seconds, step); } catch (error) { rebuild(error); return; }
      frames++; lastFrameAt = now;
    }
    if (animating() && !rebuilding) raf = requestAnimationFrame(tick);
  };
  /** Starts the loop when it isn't running; the time it was stopped doesn't count. */
  const schedule = () => {
    if (raf || rebuilding || !animating()) return;
    last = lastTick = performance.now();
    raf = requestAnimationFrame(tick);
  };
  const halt = () => { cancelAnimationFrame(raf); raf = 0; };
  // Returning text gets the first frame. Keep the existing sky still during catch-up.
  const stopSync = sync.subscribe(() => { if (animating()) schedule(); else halt(); });
  /** Runs every CHECK_MS and whenever the page comes back: a frame asked for and never delivered is asked for again,
   *  frames that keep coming without one being drawn make the next one due, and a canvas lost for two checks running
   *  is made again. */
  const check = () => {
    if (!animating() || rebuilding) return;
    const lost = painter.lost();
    if (lost !== null) { if (++lostChecks >= 2) rebuild(new Error(lost)); return; }
    lostChecks = 0;
    const now = performance.now();
    if (raf && now - lastTick > CHECK_MS) { halt(); kicks++; }
    else if (frames && now - lastFrameAt > CHECK_MS + 1000 / painter.fps) { stuck++; owed = 1 / painter.fps; }
    schedule();
  };
  /** Everything that says whether the art is moving and why not, for the server's journal (sky-diag lines). */
  const state = (reason: string) => {
    const now = performance.now(), view = window.visualViewport, box = canvas.getBoundingClientRect(), gl = canvas.getContext('webgl2');
    return {
      reason, kind, wanted, shrink, webview: 'KenanNext' in window, ua: navigator.userAgent.slice(0, 200), uptimeS: Math.round(now / 1000),
      hidden: document.hidden, focused: document.hasFocus(), typing: typing(), followSystem, reducedMotion: still.matches,
      inner: [innerWidth, innerHeight], view: view ? [Math.round(view.width), Math.round(view.height), Math.round(view.offsetTop), view.scale] : null, dpr: devicePixelRatio,
      size, host: { height: host.style.height, transform: host.style.transform, connected: host.isConnected },
      canvas: { width: canvas.width, height: canvas.height, connected: canvas.isConnected, box: [Math.round(box.top), Math.round(box.width), Math.round(box.height)] },
      gl: gl ? { lost: gl.isContextLost(), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight] } : null,
      painterLost: painter.lost(), animating: animating(), rafPending: raf !== 0, rebuilding: rebuilding !== null, tries, reported, rebuilds, kicks, refits, stuck, lastError,
      frames, sinceFrameMs: lastFrameAt ? Math.round(now - lastFrameAt) : null, sinceTickMs: lastTick ? Math.round(now - lastTick) : null,
    };
  };
  const report = (reason: string) => { if (!gone) api('/diag/sky', 'POST', state(reason)).catch(() => {}); };
  const resized = new ResizeObserver(([entry]) => {
    const box = entry?.contentRect;
    if (!box || box.width < 1 || box.height < 1) return;
    size = { width: box.width, height: box.height };
    fit();
    draw();
    schedule();
  });
  const shown = () => { if (document.hidden) { halt(); return; } tries = 0; reported = false; check(); report('shown'); };
  const motion = () => { if (followSystem && still.matches) halt(); else schedule(); };
  const watchdog = setInterval(check, CHECK_MS);
  const reporter = setInterval(() => { if (!document.hidden) report('periodic'); }, REPORT_MS);
  let afterKeyboard: ReturnType<typeof setTimeout> | null = null;
  const keyboardGone = () => { if (afterKeyboard !== null) clearTimeout(afterKeyboard); afterKeyboard = setTimeout(() => { afterKeyboard = null; report('field-left'); }, 2000); };
  document.addEventListener('focusout', keyboardGone);
  const firstReport = setTimeout(() => report('mounted'), 5000);
  (window as unknown as { kenanSkyState?: () => unknown }).kenanSkyState = () => state('asked');
  resized.observe(canvas);
  document.addEventListener('visibilitychange', shown);
  addEventListener('pageshow', shown);
  addEventListener('focus', shown);
  still.addEventListener('change', motion);
  return {
    followSystem(on) { followSystem = on; motion(); },
    unmount() {
      gone = true;
      stopSync(); halt();
      clearInterval(watchdog); clearInterval(reporter); clearTimeout(firstReport);
      if (afterKeyboard !== null) clearTimeout(afterKeyboard);
      document.removeEventListener('focusout', keyboardGone);
      delete (window as unknown as { kenanSkyState?: () => unknown }).kenanSkyState;
      resized.disconnect();
      unhold();
      document.removeEventListener('visibilitychange', shown);
      removeEventListener('pageshow', shown);
      removeEventListener('focus', shown);
      still.removeEventListener('change', motion);
      painter.dispose();
      host.remove();
      document.documentElement.classList.remove('sky-on');
    },
  };
}

/** Keeps the art where it is while the on-screen keyboard is up (Alice 2026-10-25). The Android app (adjustResize) and
 *  Chrome with interactive-widget=resizes-content shrink the page by the keyboard's height, which would refit the art
 *  to the shorter page; Chrome's default instead pans the page up under a fixed keyboard, carrying the art with it.
 *  So while a text field has focus and the width is unchanged the layer keeps the tallest height it had, and it is
 *  moved down by however far the visual viewport has panned. A probe, an invisible fixed box with inset 0, gives the
 *  height the layer would have, so it still reaches the bottom where that differs from innerHeight (iOS home-screen
 *  apps, web/viewport.ts). A changed width (rotation) or a shrink with no text field focused refits as before.
 *  settled hears once the window's size has stopped changing (a keyboard has finished opening or closing) while the
 *  layer kept its size: the canvas then gets a fresh drawing buffer of the same size, as it did when every keyboard
 *  refit it, because an Android app's WebView can keep showing the canvas's last frame after resizing around it. */
function holdThroughKeyboard(host: HTMLElement, settled: () => void): () => void {
  const probe = document.createElement('div');
  probe.className = 'sky-probe';
  probe.setAttribute('aria-hidden', 'true');
  document.body.prepend(probe);
  const view = window.visualViewport;
  let held: { width: number; height: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, settling: ReturnType<typeof setTimeout> | null = null;
  let seen = '';
  const place = () => {
    const box = probe.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const now = `${box.width}x${box.height}`;
    if (seen && now !== seen) { if (settling !== null) clearTimeout(settling); settling = setTimeout(() => { settling = null; settled(); }, 300); }
    seen = now;
    if (!held || box.width !== held.width || box.height >= held.height || !typing()) held = { width: box.width, height: box.height };
    host.style.height = `${held.height}px`;
    const pan = view && Math.abs(view.scale - 1) < 0.01 ? Math.max(0, view.offsetTop) : 0;
    host.style.transform = pan ? `translateY(${pan}px)` : '';
  };
  /** Focus leaving a field may come before or after the keyboard has gone; look again once it surely has. */
  const later = () => { if (timer !== null) clearTimeout(timer); timer = setTimeout(() => { timer = null; place(); }, 1000); };
  const sized = new ResizeObserver(place);
  sized.observe(probe);
  view?.addEventListener('resize', place);
  view?.addEventListener('scroll', place);
  document.addEventListener('focusin', place);
  document.addEventListener('focusout', later);
  place();
  return () => {
    if (timer !== null) clearTimeout(timer);
    if (settling !== null) clearTimeout(settling);
    sized.disconnect();
    view?.removeEventListener('resize', place);
    view?.removeEventListener('scroll', place);
    document.removeEventListener('focusin', place);
    document.removeEventListener('focusout', later);
    probe.remove();
  };
}

async function painterFor(kind: Background, canvas: HTMLCanvasElement, redraw: () => void): Promise<Painter> {
  switch (kind) {
    case 'starfield': {
      const g = canvas.getContext('2d');
      if (!g) throw new Error('this browser gave no 2D canvas');
      return starfield(canvas, g);
    }
    case 'forest': return (await import('./forest.js')).forest(canvas, redraw);
  }
}

const TAU = Math.PI * 2;
const TINTS = ['255,255,255', '214,228,255', '196,214,255', '255,236,214', '255,224,196'] as const;
const TINT_WEIGHTS = [3, 1, 1, 1, 1];
/** Each depth tiles the screen with its own square of stars, so a resize (a phone's toolbar sliding away) moves no
 *  star; three tile sizes drifting at three speeds never line up into a visible repeat. */
const DEPTHS = [
  { tile: 1031, perStar: 2740, speed: 0.45, size: [0.45, 0.3], alpha: 0.42 },
  { tile: 997, perStar: 5670, speed: 1, size: [0.75, 0.35], alpha: 0.62 },
  { tile: 1123, perStar: 21250, speed: 1.9, size: [1.1, 0.5], alpha: 0.85 },
] as const;
const DRIFT = [-2.1, 0.9] as const;

type Star = { x: number; y: number; depth: number; size: number; alpha: number; tint: number; breathe: number; period: number; phase: number };
type Glint = { star: Star; age: number; life: number; size: number };

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function halo(rgb: string): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const g = sprite.getContext('2d')!;
  const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, `rgba(${rgb},1)`);
  glow.addColorStop(0.12, `rgba(${rgb},.55)`);
  glow.addColorStop(0.4, `rgba(${rgb},.09)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = glow;
  g.fillRect(0, 0, 64, 64);
  return sprite;
}

function starfield(canvas: HTMLCanvasElement, g: CanvasRenderingContext2D): Painter {
  const r = random(11);
  const pickTint = () => { let n = r() * 7; for (let i = 0; i < TINT_WEIGHTS.length; i++) { n -= TINT_WEIGHTS[i]!; if (n < 0) return i; } return 0; };
  const stars: Star[] = DEPTHS.flatMap((d, depth) => Array.from({ length: Math.round(d.tile * d.tile / d.perStar) }, () => ({
    x: r() * d.tile, y: r() * d.tile, depth, size: d.size[0] + r() * d.size[1], alpha: d.alpha + r() * 0.15, tint: pickTint(),
    breathe: r() < 0.3 ? 0.18 + r() * 0.22 : 0, period: 5 + r() * 9, phase: r() * TAU,
  }))).sort((a, b) => a.tint - b.tint);
  const glintable = stars.filter(s => s.depth > 0);
  const halos = TINTS.map(halo);
  let width = 0, height = 0, glints: Glint[] = [], nextGlint = 2;
  const offset = (star: Star, seconds: number): [number, number] => {
    const d = DEPTHS[star.depth]!, t = d.tile;
    const x = ((star.x + DRIFT[0] * d.speed * seconds) % t + t) % t, y = ((star.y + DRIFT[1] * d.speed * seconds) % t + t) % t;
    return [x, y];
  };
  return {
    fps: 30,
    maxDpr: 1.5,
    pixels: Infinity,
    lost: () => null,
    dispose() {},
    resize(w, h, dpr) {
      width = w; height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    frame(seconds, step) {
      g.clearRect(0, 0, width, height);
      let tint = -1;
      for (const star of stars) {
        if (star.tint !== tint) { tint = star.tint; g.fillStyle = `rgb(${TINTS[tint]})`; }
        const tile = DEPTHS[star.depth]!.tile, [x0, y0] = offset(star, seconds);
        g.globalAlpha = star.alpha * (star.breathe ? 1 - star.breathe * (0.5 + 0.5 * Math.sin(TAU * seconds / star.period + star.phase)) : 1);
        const round = star.size >= 0.8, s = star.size, half = s / 2, radius = s * 0.62;
        for (let y = y0; y < height + 2; y += tile) for (let x = x0; x < width + 2; x += tile) {
          if (round) { g.beginPath(); g.arc(x, y, radius, 0, TAU); g.fill(); }
          else g.fillRect(x - half, y - half, s, s);
        }
      }
      if (step > 0) {
        nextGlint -= step;
        if (nextGlint <= 0) {
          nextGlint = 2.5 + r() * 4.5;
          const star = glintable[Math.floor(r() * glintable.length)];
          if (star) { const [x, y] = offset(star, seconds); if (x < width && y < height) glints.push({ star, age: 0, life: 2.6 + r() * 1.6, size: 9 + r() * 7 }); }
        }
      }
      for (const glint of glints) {
        glint.age += step;
        const e = Math.sin(Math.PI * Math.min(1, glint.age / glint.life)) ** 2, [x, y] = offset(glint.star, seconds), d = glint.size * (0.6 + 0.4 * e);
        g.globalAlpha = 0.85 * e;
        g.drawImage(halos[glint.star.tint]!, x - d, y - d, d * 2, d * 2);
        g.globalAlpha = 0.22 * e;
        g.fillStyle = `rgb(${TINTS[glint.star.tint]})`;
        g.fillRect(x - d * 1.15, y - 0.3, d * 2.3, 0.6);
        g.fillRect(x - 0.3, y - d * 1.15, 0.6, d * 2.3);
      }
      g.globalAlpha = 1;
      glints = glints.filter(glint => glint.age < glint.life);
    },
  };
}
