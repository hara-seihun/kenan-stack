// Classic must look exactly as before for everyone who hasn't switched to Organized (Carol, 2026-10-21).
// The fixture was rendered by the Classic app before the Organized layout existed; a deliberate Classic change updates it.
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

const conversation = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, ownerId: 'ana', memberIds: ['ana', 'manager:ana'], agentId: null, archived: false, color: null, lastSeq: 3, readThrough: 3, lastMessage: { authorId: 'ana', preview: 'Hello', at: 1, seq: 3 }, updatedAt: 1, emoji: null, pinnedAt: null, keyDate: null, keyLabel: null, titleLocked: false, project: false, statusLine: null, projectId: null, ...extra });
const bootstrap = (layout: string) => ({
  me: { id: 'ana', name: 'Ana', kind: 'human' }, people: [{ id: 'ana', name: 'Ana', kind: 'human' }], agents: [], goals: [],
  conversations: [conversation('11111111-1111-1111-1111-111111111111', 'Trip planning', { pinnedAt: 5, emoji: '✈️', keyDate: '2026-10-29' }), conversation('22222222-2222-2222-2222-222222222222', 'Recipes')],
  activity: {}, manager: { kind: 'none' }, layout, extensions: [{ id: 'calendar', name: 'Calendar' }], serverTime: 1, channel: 'production',
});

async function renderClassic(layout: string): Promise<string> {
  vi.resetModules();
  const store = new Map<string, string>([['kenan-startup-v3', JSON.stringify({ build: 'index-test.js', bootstrap: bootstrap(layout), page: null })], ['kenan-startup-v2', JSON.stringify({ bootstrap: bootstrap(layout), page: null })]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const target = { addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, {
    window: Object.assign(globalThis, target), document: { ...target, documentElement: { dataset: {} }, visibilityState: 'visible', title: '', querySelector: (selector: string) => selector.includes('assets/index-') ? { src: 'https://example.test/assets/index-test.js' } : null, querySelectorAll: () => [] },
    localStorage: storage, location: { search: '', href: 'https://example.test/' }, history: { state: null, pushState() {}, replaceState() {}, back() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const { App } = await import('./App.js');
  return renderToString(h(App, {}));
}

describe('Classic layout', () => {
  it('renders byte-for-byte as before for a person without Organized, whatever layout is stored', async () => {
    const html = await renderClassic('classic');
    await expect(html).toMatchFileSnapshot('./__fixtures__/classic.html');
    expect(await renderClassic('organized')).toBe(html);
  });
});
