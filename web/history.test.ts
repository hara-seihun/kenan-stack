import { describe, expect, it } from 'vitest';
import type { Message } from '../shared/contract.js';
import { acceptLatest, appendDelta, appendNewer, prependOlder, trimForFollowing, upsert, WINDOW_SIZE, PAGE_SIZE } from './history.js';

const msg = (seq: number, updatedAt = seq, clipped = false): Message => ({ id: `m${seq}`, conversationId: 'c', seq, authorId: 'a', role: 'assistant', notice: null, display: 'shown', text: `t${seq}`, parts: [], state: 'done', clientId: null, createdAt: seq, updatedAt, clipped });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const seqs = (h: { messages: Message[] }) => [h.messages[0]?.seq, h.messages.at(-1)?.seq, h.messages.length];

describe('history window', () => {
  it('stays bounded and contiguous while paging back and forth through a long conversation', () => {
    let h = acceptLatest(undefined, { messages: range(951, 1000), hasOlder: true, hasNewer: false });
    for (let edge = 951; edge > 1; edge -= PAGE_SIZE) h = prependOlder(h, { messages: range(Math.max(1, edge - PAGE_SIZE), edge - 1), hasOlder: edge - PAGE_SIZE > 1, hasNewer: true });
    expect([...seqs(h), h.hasOlder, h.hasNewer]).toEqual([1, WINDOW_SIZE, WINDOW_SIZE, false, true]);
    expect(upsert(h, msg(1001))).toBe(h);
    while (h.hasNewer) { const last = h.messages.at(-1)!.seq; h = appendNewer(h, { messages: range(last + 1, Math.min(1000, last + PAGE_SIZE)), hasOlder: true, hasNewer: last + PAGE_SIZE < 1000 }); }
    expect([...seqs(h), h.hasOlder]).toEqual([1000 - WINDOW_SIZE + 1, 1000, WINDOW_SIZE, true]);
    for (let s = 1001; s <= 1000 + PAGE_SIZE + 1; s++) h = trimForFollowing(upsert(h, msg(s)));
    expect(h.messages.length).toBeLessThanOrEqual(WINDOW_SIZE + PAGE_SIZE);
    expect(h.messages.every((m, i) => i === 0 || m.seq === h.messages[i - 1]!.seq + 1)).toBe(true);
  });

  it('merges a reconnect page that touches the window and replaces one that leaves a gap', () => {
    const h = { messages: range(1, 10), hasOlder: false, hasNewer: false };
    expect(seqs(acceptLatest(h, { messages: range(5, 12), hasOlder: true, hasNewer: false }))).toEqual([1, 12, 12]);
    expect(seqs(acceptLatest(h, { messages: range(40, 50), hasOlder: true, hasNewer: false }))).toEqual([40, 50, 11]);
  });

  it('keeps a full message over a clipped copy of the same revision, but takes newer revisions', () => {
    const h = { messages: [msg(1, 5, true)], hasOlder: false, hasNewer: false };
    const full = upsert(h, msg(1, 5, false));
    expect(full.messages[0]!.clipped).toBe(false);
    expect(upsert(full, msg(1, 5, true))).toBe(full);
    expect(upsert(full, msg(1, 6, true)).messages[0]!.updatedAt).toBe(6);
  });

  it('settles a streamed reply even when its deltas arrived after the server stamped it done', () => {
    const streaming: Message = { ...msg(7, 100), text: '', state: 'streaming' };
    let h = acceptLatest(undefined, { messages: [msg(6), streaming], hasOlder: false, hasNewer: false });
    h = appendDelta(h, 'm7', 'Hel'); h = appendDelta(h, 'm7', 'lo');
    const done: Message = { ...streaming, text: 'Hello', state: 'done', updatedAt: 100 };
    h = upsert(h, done);
    expect(h.messages.at(-1)).toMatchObject({ state: 'done', text: 'Hello' });
    expect(appendDelta(h, 'm7', '!')).toBe(h);
    expect(acceptLatest(h, { messages: [msg(6), { ...streaming, updatedAt: 100 }], hasOlder: false, hasNewer: false }).messages.at(-1)!.state).toBe('done');
  });
});
