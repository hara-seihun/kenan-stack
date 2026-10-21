import type { StreamEvent } from '../shared/contract.js';

const EVENT_TYPES: StreamEvent['type'][] = ['ready', 'unauthenticated', 'message', 'delta', 'conversation', 'activity', 'agent', 'goal', 'heartbeat'];
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

/**
 * Native EventSource retries network drops; terminal HTTP errors close it, and then this reopens it with a
 * fresh URL (so a reconnect asks for the conversation open at that moment). The first connection may adopt
 * the early stream: its buffered events are replayed in order before live delivery continues.
 */
export function connectEvents(url: () => string, handlers: {
  onOpen(): void;
  onError(): void;
  onEvent(event: MessageEvent<string>): void;
}, early: EarlyStream | null): () => void {
  let source: EventSource;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const open = (adopted: EarlyStream | null) => {
    if (closed) return;
    const current = adopted?.source ?? new EventSource(url());
    source = current;
    current.onopen = () => { if (!closed && source === current) handlers.onOpen(); };
    current.onerror = () => {
      if (closed || source !== current) return;
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
        if (closed || source !== current) return;
        if (current.readyState === EventSource.OPEN) handlers.onOpen();
        for (const event of buffered) if (!closed && source === current) handlers.onEvent(event);
        if (!closed && current.readyState === EventSource.CLOSED) current.onerror?.(new Event('error'));
      });
    }
    for (const type of EVENT_TYPES) current.addEventListener(type, event => {
      if (!closed && source === current) handlers.onEvent(event as MessageEvent<string>);
    });
  };
  open(early);
  return () => {
    closed = true;
    clearTimeout(timer);
    source.close();
  };
}
