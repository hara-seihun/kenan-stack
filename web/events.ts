import { SSE_HEARTBEAT_MS, type StreamEvent } from '../shared/contract.js';
import { bridge } from './native.js';

/** Every named event the stream sends; the record makes the compiler reject a missing or unknown type. index.html's early stream listens to the same list. */
const STREAM_EVENTS: Record<StreamEvent['type'], true> = { ready: true, unauthenticated: true, message: true, delta: true, thinking: true, tool_draft: true, conversation: true, activity: true, agent: true, goal: true, todo: true, chat_groups: true, buy: true, layout: true, seen: true, notifications_cleared: true, waiting: true, heartbeat: true };
export const EVENT_TYPES = Object.keys(STREAM_EVENTS) as StreamEvent['type'][];
const RECONNECT_MS = 3000;

/** The stream index.html opens before the app's script has loaded, with the events it has buffered so far. */
export type EarlyStream = { source: EventSource; events: MessageEvent<string>[] | null };
declare global { interface Window { __kenanStream?: EarlyStream } }

/** Takes the early stream once; later connections open their own. */
export function adoptEarlyStream(): EarlyStream | null {
  const early = window.__kenanStream ?? null;
  window.__kenanStream = undefined;
  return early;
}

/** Why the app dropped its stream and opened a fresh one, reported to the server's journal (`stream-diag`). */
export type StreamRestart = { reason: 'silent' | 'online' | 'resume'; silentMs: number; readyState: number };

/**
 * The server sends a heartbeat every SSE_HEARTBEAT_MS. A network change (Wi-Fi to cellular, a VPN reconnecting, the
 * phone freezing the app) can leave a stream that the browser still calls open or connecting but that will never
 * deliver again, so this long with nothing heard means it is dead.
 */
export const SILENT_MS = SSE_HEARTBEAT_MS * 2 + 5000;
const WATCH_MS = 5000;
/** After the page comes back, buffered events get this long to arrive before silence counts. */
const RESUME_GRACE_MS = 2000;

/**
 * Native EventSource retries network drops; terminal HTTP errors close it, and then this reopens it with a
 * fresh URL (so a reconnect asks for the conversation open at that moment). A stream that has been silent for
 * SILENT_MS, or any stream when the device comes back online, is replaced at once: native retry never notices a
 * connection that died without closing. The first connection may adopt the early stream: its buffered events are
 * replayed in order before live delivery continues.
 */
export function connectEvents(url: () => string, handlers: {
  onOpen(): void;
  /** Start screen reads alongside the stream handshake, not after its snapshot. */
  onConnect?(): void;
  onStale?(): void;
  onError(): void;
  onEvent(event: MessageEvent<string>): void;
  onRestart?(restart: StreamRestart): void;
}, early: EarlyStream | null): () => void {
  let source: EventSource;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heard = Date.now();
  let closed = false, paused = false;
  const hiddenNative = () => {
    const native = bridge();
    return Boolean(native?.nativeNotifications && (native.foreground === false || document.visibilityState === 'hidden'));
  };
  const restart = (reason: StreamRestart['reason']) => {
    if (closed || paused) return;
    const silentMs = Date.now() - heard, readyState = source.readyState;
    clearTimeout(timer); timer = undefined;
    source.close();
    handlers.onStale?.();
    handlers.onRestart?.({ reason, silentMs, readyState });
    open(null);
  };
  const check = () => { if (!closed && !paused && Date.now() - heard >= SILENT_MS) restart('silent'); };
  const open = (adopted: EarlyStream | null) => {
    if (closed || paused) return;
    if (!adopted) handlers.onConnect?.();
    const current = adopted?.source ?? new EventSource(url());
    source = current; heard = Date.now();
    current.onopen = () => { if (!closed && !paused && source === current) { heard = Date.now(); handlers.onOpen(); } };
    current.onerror = () => {
      if (closed || paused || source !== current) return;
      handlers.onError();
      if (current.readyState !== EventSource.CLOSED || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        current.close();
        open(null);
      }, RECONNECT_MS);
    };
    if (adopted) {
      const buffered = adopted.events ?? [];
      adopted.events = null;
      // Replayed after connectEvents has returned, so a buffered `unauthenticated` can already stop this stream.
      queueMicrotask(() => {
        if (closed || paused || source !== current) return;
        if (current.readyState === EventSource.OPEN) handlers.onOpen();
        for (const event of buffered) if (!closed && !paused && source === current) handlers.onEvent(event);
        if (!closed && current.readyState === EventSource.CLOSED) current.onerror?.(new Event('error'));
      });
    }
    for (const type of EVENT_TYPES) current.addEventListener(type, event => {
      if (!closed && !paused && source === current) { heard = Date.now(); handlers.onEvent(event as MessageEvent<string>); }
    });
  };
  open(early);
  let watch: ReturnType<typeof setInterval> | undefined = setInterval(check, WATCH_MS);
  let grace: ReturnType<typeof setTimeout> | undefined;
  // Native notifications keep running; a hidden chat does not need a second stream or rendering work.
  let backgrounded = document.visibilityState === 'hidden' || hiddenNative();
  const visibility = () => {
    if (closed) return;
    const hidden = document.visibilityState === 'hidden' || hiddenNative();
    if (hidden && !backgrounded) handlers.onStale?.();
    const returning = backgrounded && !hidden;
    backgrounded = hidden;
    if (hiddenNative()) {
      paused = true; clearTimeout(timer); timer = undefined; clearTimeout(grace); clearInterval(watch); watch = undefined;
      source.close();
    } else if (paused) {
      paused = false; handlers.onStale?.(); open(null); watch = setInterval(check, WATCH_MS);
    } else if (returning) restart('resume');
  };
  const resumed = () => {
    visibility();
    if (paused || document.visibilityState !== 'visible') return;
    clearTimeout(grace); grace = setTimeout(check, RESUME_GRACE_MS);
  };
  const online = () => restart('online');
  const offline = () => handlers.onError();
  const listeners: [EventTarget, string, () => void][] = [[window, 'online', online], [window, 'offline', offline], [window, 'pageshow', resumed], [window, 'focus', resumed], [window, 'kenan-native-ready', visibility], [window, 'kenan-app-visibility', visibility], [document, 'visibilitychange', resumed], [document, 'resume', resumed]];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  visibility();
  return () => {
    closed = true;
    clearTimeout(timer); clearTimeout(grace); clearInterval(watch);
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    source.close();
  };
}

/** Events that arrive within this many ms of each other are applied together. */
const BATCH_MS = 16;

/**
 * Busy agents send many events a second (deltas, tool messages, activity). Applying each in its own task makes the app
 * render once per event; applying all that arrived within one frame's time in one task makes it render once for them.
 * Order is kept; `ready` and `unauthenticated` apply at once; `drop` discards what is queued.
 */
export function eventBatch(apply: (event: MessageEvent<string>) => void) {
  let queue: MessageEvent<string>[] = [], timer: ReturnType<typeof setTimeout> | undefined, generation = 0;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    const events = queue, current = generation;
    queue = [];
    for (const event of events) { if (generation !== current) return; apply(event); }
  };
  return {
    add(event: MessageEvent<string>) {
      queue.push(event);
      if (event.type === 'ready' || event.type === 'unauthenticated') flush();
      else timer ??= setTimeout(flush, BATCH_MS);
    },
    drop() { generation++; queue = []; clearTimeout(timer); timer = undefined; },
  };
}
