import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const script = new URL('./host-requirements.sh', import.meta.url).pathname;
function check(versionLine: string): { status: number; stderr: string } {
  const bin = mkdtempSync(join(tmpdir(), 'host-req-'));
  writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\necho '${versionLine}'\necho '+PAM +AUDIT'\n`, { mode: 0o755 });
  try { execFileSync('/bin/bash', [script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: 'pipe' }); return { status: 0, stderr: '' }; }
  catch (error) { const e = error as { status: number; stderr: Buffer }; return { status: e.status, stderr: e.stderr.toString() }; }
  finally { rmSync(bin, { recursive: true }); }
}

it('deploys only to hosts whose systemd-run keeps commands literal (systemd 254+)', () => {
  expect(check('systemd 259 (259.5-0ubuntu3.4)')).toEqual({ status: 0, stderr: '' });
  expect(check('systemd 254 (254.26-1~bpo12+1)')).toEqual({ status: 0, stderr: '' });
  expect(check('systemd 252 (252.39-1~deb12u2)')).toMatchObject({ status: 21, stderr: expect.stringContaining('host_requirement_systemd: systemd 252') });
  expect(check('garbage')).toMatchObject({ status: 20, stderr: expect.stringContaining('host_requirement_unknown') });
});
