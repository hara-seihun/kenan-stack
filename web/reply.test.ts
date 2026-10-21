import { describe, expect, it } from 'vitest';
import type { Message } from '../shared/contract.js';
import { canReply, excerptOf, replyLabel, replyTarget, withReply } from './reply.js';

const msg = (over: Partial<Message>): Message => ({ id: 'm1', role: 'agent', notice: null, display: 'shown', conversationId: 'c', seq: 1, authorId: 'a', text: '', parts: [], state: 'done', clientId: null, createdAt: 0, updatedAt: 0, clipped: false, ...over } as Message);

describe('reply', () => {
  it('shortens and flattens the excerpt', () => {
    expect(excerptOf('**Hi**\n\nthere `x`')).toBe('Hi there x');
    expect(excerptOf('a'.repeat(300)).length).toBe(160);
    expect(excerptOf('> old quote\nnew words')).toBe('new words');
  });
  it('replies to words and pictures, not to tool cards', () => {
    expect(canReply(msg({ text: 'hello' }))).toBe(true);
    expect(canReply(msg({ parts: [{ type: 'image', fileId: 'f', mime: 'image/png' }] }))).toBe(true);
    expect(canReply(msg({ role: 'tool', text: 'bash' } as Partial<Message>))).toBe(false);
    expect(canReply(msg({ text: '' }))).toBe(false);
  });
  it('quotes a picture and keeps its file', () => {
    const r = replyTarget(msg({ text: '', parts: [{ type: 'file', fileId: 'f1', name: 'home.png', mime: 'image/png', size: 1 }] }), 'Kenaznia');
    expect(r.files).toEqual([{ id: 'f1', name: 'home.png', image: true }]);
    expect(replyLabel(r)).toBe('Kenaznia: 🖼 home.png');
    expect(withReply('Make this orange', r)).toBe('> **Kenaznia:**\n> 🖼 home.png\n\nMake this orange');
  });
  it('quotes words', () => {
    const r = replyTarget(msg({ text: 'Brighter or Glow?' }), 'Kenaznia');
    expect(withReply('Brighter', r)).toBe('> **Kenaznia:** Brighter or Glow?\n\nBrighter');
    expect(withReply('x', null)).toBe('x');
  });
});
