import { expect, it } from 'vitest';
import { overlayStack } from './overlayStack.js';

function browser(marked = false) {
  const log: string[] = [];
  let entries = marked ? ['base', 'overlay'] : ['base'];
  const nav = {
    marked: () => entries.at(-1) === 'overlay',
    push: () => { entries = [...entries, 'overlay']; log.push('push'); },
    back: () => { entries = entries.slice(0, -1); log.push('back'); queueMicrotask(() => stack.popped()); },
    unmark: () => { entries = [...entries.slice(0, -1), 'base']; },
  };
  const stack = overlayStack(nav);
  const pressBack = () => { entries = entries.slice(0, -1); stack.popped(); };
  return { stack, log, pressBack, entries: () => entries };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('browser back closes the topmost overlay, then the next, then leaves history to the page', async () => {
  const { stack, log, pressBack, entries } = browser();
  const closed: string[] = [];
  stack.register({ close: () => closed.push('sidebar') });
  stack.register({ close: () => closed.push('viewer') });
  await settle();
  expect(log).toEqual(['push']);
  pressBack(); await settle();
  expect(closed).toEqual(['viewer']);
  expect(entries()).toEqual(['base', 'overlay']);
  pressBack(); await settle();
  expect(closed).toEqual(['viewer', 'sidebar']);
  expect(entries()).toEqual(['base']);
  expect(stack.dismissTop()).toBe(false);
});

it('closing from the page (X, Escape, the Android app) removes its history entry so the next back is not swallowed', async () => {
  const { stack, log, entries } = browser();
  const unregister = stack.register({ close: () => undefined });
  await settle();
  unregister(); await settle();
  expect(log).toEqual(['push', 'back']);
  expect(entries()).toEqual(['base']);
  stack.register({ close: () => undefined });
  await settle();
  expect(stack.dismissTop()).toBe(true); await settle();
  expect(entries()).toEqual(['base']);
  expect(stack.depth).toBe(0);
});

it('one overlay replacing another in the same render keeps a single entry', async () => {
  const { stack, log } = browser();
  const sidebar = stack.register({ close: () => undefined });
  await settle();
  sidebar(); stack.register({ close: () => undefined });
  await settle();
  expect(log).toEqual(['push']);
});

it('a reload with an overlay entry current starts with nothing open and no entry to pop', async () => {
  const { stack, log, entries } = browser(true);
  await settle();
  expect(entries()).toEqual(['base', 'base']);
  expect(stack.dismissTop()).toBe(false);
  expect(log).toEqual([]);
});
