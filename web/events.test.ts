import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents } from './events.js';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  close = vi.fn(() => { this.readyState = FakeEventSource.CLOSED; });
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
}
const callbacks = () => ({ onOpen: vi.fn(), onError: vi.fn(), onEvent: vi.fn() });

describe('event stream reconnect', () => {
  beforeEach(() => { FakeEventSource.instances = []; vi.useFakeTimers(); vi.stubGlobal('EventSource', FakeEventSource); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reopens a terminal HTTP failure once and resumes existing open/event callbacks', () => {
    const handlers = callbacks(), cleanup = connectEvents(() => '/pi-stack/api/events', handlers, null);
    const first = FakeEventSource.instances[0]!;
    first.readyState = FakeEventSource.CLOSED;
    first.onerror!(); first.onerror!();
    vi.advanceTimersByTime(2999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe('/pi-stack/api/events');
    second.onopen!();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    const message = { data: '{"type":"delta"}' } as MessageEvent<string>;
    second.listeners.get('delta')!(message);
    expect(handlers.onEvent).toHaveBeenCalledWith(message);
    first.onerror!(); first.onopen!(); first.listeners.get('delta')!(message);
    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    cleanup();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('leaves CONNECTING errors to native retry', () => {
    const handlers = callbacks(), cleanup = connectEvents(() => '/api/events', handlers, null);
    const first = FakeEventSource.instances[0]!;
    first.onerror!();
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    first.readyState = FakeEventSource.OPEN;
    first.onopen!();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('cancels a pending reconnect on cleanup and ignores late callbacks', () => {
    const handlers = callbacks(), cleanup = connectEvents(() => '/api/events', handlers, null);
    const first = FakeEventSource.instances[0]!;
    first.readyState = FakeEventSource.CLOSED; first.onerror!();
    cleanup(); first.onerror!(); first.onopen!();
    first.listeners.get('message')!({ data: '{}' } as MessageEvent<string>);
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onOpen).not.toHaveBeenCalled();
    expect(handlers.onEvent).not.toHaveBeenCalled();
  });

  it('adopts the early stream: replays its buffer in order once connectEvents has returned, then delivers live events', async () => {
    const early = new FakeEventSource('/api/events?open=c1');
    early.readyState = FakeEventSource.OPEN;
    const ready = { data: '{"type":"ready"}' } as MessageEvent<string>, delta = { data: '{"type":"delta"}' } as MessageEvent<string>;
    const stream = { source: early as unknown as EventSource, events: [ready] as MessageEvent<string>[] | null };
    const handlers = callbacks(), cleanup = connectEvents(() => '/api/events?open=c2', handlers, stream);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(stream.events).toBeNull();
    expect(handlers.onEvent).not.toHaveBeenCalled();
    await Promise.resolve();
    early.listeners.get('delta')!(delta);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent.mock.calls.map(([event]) => event)).toEqual([ready, delta]);
    early.readyState = FakeEventSource.CLOSED; early.onerror!();
    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances.at(-1)!.url).toBe('/api/events?open=c2');
    cleanup();
  });
});
