import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersonConfig } from '../config.js';
import type { Deps, StoredFile } from '../types.js';
import { ATTACH_LIMITS, filePart, storeOwnerFiles } from './files.js';

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'kenan-attach-home-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'kenan-attach-data-'));
  const files: StoredFile[] = [];
  const store = { createFile: async (f: Omit<StoredFile, 'id'>) => { const id = `f${files.length}`; files.push({ id, ...f }); return { id }; } };
  const deps = { config: { dataDir }, store } as unknown as Deps;
  const person = { id: 'alice', uid: process.getuid!(), gid: process.getgid!(), home, unixUser: 'alice' } as PersonConfig;
  return { home, deps, person, files };
}

describe('storeOwnerFiles', () => {
  it('copies readable files in as the person, so later edits on disk do not change what was sent', async () => {
    const { home, deps, person, files } = await setup();
    await mkdir(join(home, 'out'));
    await writeFile(join(home, 'out', 'plot.png'), 'png bytes');
    await writeFile(join(home, 'notes.pdf'), 'pdf bytes');
    const stored = await storeOwnerFiles(deps, { kind: 'callerCgroup' }, person, ['~/out/plot.png', join(home, 'notes.pdf')]);
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    expect(stored.files.map(f => [f.name, f.mime, f.size])).toEqual([['plot.png', 'image/png', 9], ['notes.pdf', 'application/pdf', 9]]);
    expect(stored.files.map(filePart).map(p => p.type)).toEqual(['image', 'file']);
    await writeFile(join(home, 'out', 'plot.png'), 'changed later');
    expect(await readFile(files[0]!.path, 'utf8')).toBe('png bytes');
    expect(files.every(f => f.ownerId === 'alice')).toBe(true);
  });

  it('a bad path is a typed error naming each failure, and nothing is stored', async () => {
    const { home, deps, person, files } = await setup();
    await writeFile(join(home, 'ok.txt'), 'fine');
    await mkdir(join(home, 'folder'));
    const stored = await storeOwnerFiles(deps, { kind: 'callerCgroup' }, person, ['ok.txt', 'missing.png', 'folder']);
    expect(stored).toMatchObject({ ok: false, error: { code: 'attach_unreadable', failures: [{ path: join(home, 'missing.png'), reason: 'not_found' }, { path: join(home, 'folder'), reason: 'not_a_file' }] } });
    expect(files).toEqual([]);
    expect(await storeOwnerFiles(deps, { kind: 'callerCgroup' }, person, Array(ATTACH_LIMITS.files + 1).fill('ok.txt'))).toEqual({ ok: false, error: { code: 'attach_too_many', count: ATTACH_LIMITS.files + 1 } });
  });
});
