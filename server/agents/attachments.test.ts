import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptInput } from './attachments.js';
import type { Deps } from '../types.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('promptInput', () => {
  it('sends an attached photo inline and still names every attachment path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kenan-attach-'));
    const photo = join(dir, 'a'), notes = join(dir, 'b');
    await writeFile(photo, PNG_1x1); await writeFile(notes, 'plain text');
    const files: Record<string, { name: string; mime: string; path: string }> = {
      p: { name: 'chair.png', mime: 'image/png', path: photo },
      t: { name: 'notes.txt', mime: 'text/plain', path: notes },
    };
    const store = { getFile: async (id: string) => files[id] ? { id, ownerId: 'x', size: 1, ...files[id] } : null } as unknown as Deps['store'];
    const input = await promptInput({ store }, { agentId: 'a', kind: 'human', text: 'look', fromId: 'robin', conversationId: 'c', fileIds: ['p', 't', 'gone'] });
    expect(input.images).toHaveLength(1);
    expect(input.images[0]!.mimeType).toBe('image/png');
    expect(input.text).toContain(photo);
    expect(input.text).toContain(notes);
    expect(input.text).toContain('gone is not stored');
  });
});
