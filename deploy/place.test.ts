import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./place.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

it('lets parallel deploys place the same host files, links and release trees at once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kenan-place-')); roots.push(root);
  writeFileSync(join(root, 'tool'), 'tool body'); writeFileSync(join(root, 'lib.py'), 'lib body');
  const deploy = `. "${helper}"; for i in $(seq 40); do
   place 0755 "${root}/tool" "${root}/bin-tool" && place_link "${root}/release/tool" "${root}/selected" &&
   place_tree "${root}/release" 755 "${root}/tool" "${root}/lib.py" || exit 1; done`;
  await Promise.all([1, 2, 3].map(() => run('sh', ['-c', deploy])));
  expect(readFileSync(join(root, 'bin-tool'), 'utf8')).toBe('tool body');
  expect(statSync(join(root, 'bin-tool')).mode & 0o777).toBe(0o755);
  expect(readlinkSync(join(root, 'selected'))).toBe(join(root, 'release/tool'));
  expect(readdirSync(join(root, 'release')).sort()).toEqual(['lib.py', 'tool']);
  expect(readdirSync(root).filter(name => name.startsWith('.'))).toEqual([]);
});
