import { expect, it } from 'vitest';
import type { ServerEvent } from '../../shared/contract.js';
import { createBus } from './bus.js';

const beat = (at: number): ServerEvent => ({ type: 'heartbeat', at });

it('fans out to members in order, caches the member lookup and refreshes it on invalidate', async () => {
  let lookups = 0, members = ['a', 'b'];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const bus = createBus({ conversationMembers: async () => { lookups++; await gate; return members; } });
  const got: string[] = [];
  bus.subscribe('a', e => got.push(`a${(e as { at: number }).at}`));
  const unsubscribeB = bus.subscribe('b', e => got.push(`b${(e as { at: number }).at}`));
  bus.toConversation('c', beat(1));
  bus.toConversation('c', beat(2));   // while the lookup is pending
  release();
  await new Promise(r => setTimeout(r, 0));
  expect(got).toEqual(['a1', 'b1', 'a2', 'b2']);
  bus.toConversation('c', beat(3));   // cached: synchronous
  expect(got.slice(4)).toEqual(['a3', 'b3']);
  expect(lookups).toBe(1);
  unsubscribeB();
  members = ['a'];
  bus.invalidateMembers('c');
  bus.toConversation('c', beat(4));
  await new Promise(r => setTimeout(r, 0));
  expect(got.slice(6)).toEqual(['a4']);
  expect(lookups).toBe(2);
  bus.toPerson('a', beat(5));
  expect(got.at(-1)).toBe('a5');
});

it('remembers each conversation\'s live activity until its run ends', () => {
  const bus = createBus({ conversationMembers: async () => [] });
  const writing = { state: 'streaming' as const, label: null, since: 1 };
  bus.toConversation('c', { type: 'activity', conversationId: 'c', activity: writing });
  expect([bus.activity('c'), bus.activity('d')]).toEqual([writing, null]);
  bus.toConversation('c', { type: 'activity', conversationId: 'c', activity: null });
  expect(bus.activity('c')).toBeNull();
});
