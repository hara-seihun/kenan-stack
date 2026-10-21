import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ownerProcess, ownerTools, placedCommand, assertIndependentRuntimeControl } from './owner.js';
import type { PersonConfig } from '../config.js';

const self = userInfo();
const userManager = existsSync(`/run/user/${self.uid}/bus`);

it.skipIf(!userManager)('owner processes reach the owner systemd user manager', async () => {
  const person = { uid: self.uid, gid: self.gid, home: homedir(), unixUser: self.username } as PersonConfig;
  const result = await ownerProcess({ kind: 'callerCgroup' }, person, 'systemctl', ['--user', 'show-environment'], undefined, undefined, undefined, 10);
  expect(result.output.toString()).not.toMatch(/Failed to connect/);
  expect(result.exitCode).toBe(0);
});

it('owner shells find tools in the owner ~/.local/bin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-path-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/owner-path-probe'), '#!/bin/sh\necho found-local-bin\n', { mode: 0o755 });
  const person = { uid: self.uid, gid: self.gid, home, unixUser: self.username } as PersonConfig;
  const result = await ownerProcess({ kind: 'callerCgroup' }, person, '/bin/bash', ['-c', 'owner-path-probe && command -v ls'], undefined, undefined, undefined, 10);
  rmSync(home, { recursive: true });
  expect(result.output.toString()).toBe('found-local-bin\n/usr/bin/ls\n');
});

it.skipIf(!userManager)('agent-tool scopes hand bash its command verbatim', async () => {
  const person = { uid: self.uid, gid: self.gid, home: homedir(), unixUser: self.username } as PersonConfig;
  const script = "printf '%s|' '${HOME}' \"$HOME\"\ncat <<'END'\n${x} $y\nEND";
  const placed = placedCommand({ kind: 'channelScope', channel: 'beta' }, person, '/bin/bash', ['-c', script]);
  // The test runs unprivileged: same systemd-run options in the owner's user manager, minus the system-only slice/binding and setpriv drop.
  const options = placed.args.slice(0, placed.args.indexOf('--')).filter(arg => !/^--(slice|property=BindsTo)=/.test(arg));
  const command = placed.args.slice(placed.args.indexOf('--', placed.args.indexOf('/usr/bin/setpriv')) + 1);
  const result = await ownerProcess({ kind: 'callerCgroup' }, person, '/usr/bin/systemd-run', ['--user', ...options, '--', ...command], undefined, undefined, undefined, 10);
  expect(result.output.toString()).toBe(`${'$'}{HOME}|${person.home}|${'$'}{x} $y\n`);
  expect(result.exitCode).toBe(0);
});

it('agent-tool scopes keep the owner account supplementary groups (e.g. docker) and never the server groups', () => {
  const person = { uid: self.uid, gid: self.gid, home: homedir(), unixUser: self.username } as PersonConfig;
  const { args } = placedCommand({ kind: 'channelScope', channel: 'beta' }, person, '/bin/true', []);
  expect(args).toContain('--init-groups');
  expect(args).not.toContain('--clear-groups');
});

it('distinguishes external signal, deadline and requested cancellation without guessing from 130', async () => {
  const person = { uid: self.uid, gid: self.gid, home: tmpdir(), unixUser: self.username } as PersonConfig;
  const caller = { kind: 'callerCgroup' } as const;
  expect(await ownerProcess(caller, person, process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"])).toMatchObject({ exitCode: 130, signal: 'SIGTERM', termination: 'signal' });
  expect(await ownerProcess(caller, person, process.execPath, ['-e', 'setInterval(()=>{},1000)'], undefined, undefined, undefined, 0.2)).toMatchObject({ exitCode: 130, signal: 'SIGTERM', termination: 'timeout' });
  const controller = new AbortController();
  const pending = ownerProcess(caller, person, process.execPath, ['-e', 'setInterval(()=>{},1000)'], undefined, controller.signal);
  setTimeout(() => controller.abort(), 200);
  expect(await pending).toMatchObject({ exitCode: 130, signal: 'SIGTERM', termination: 'cancelled' });
  expect(await ownerProcess(caller, person, process.execPath, ['-e', 'process.exit(130)'])).toMatchObject({ exitCode: 130, signal: null, termination: 'exit' });
});

it.skipIf(!userManager)('transient services (phone bridges, detached deploys) get their arguments literally too', async () => {
  const person = { uid: self.uid, gid: self.gid, home: homedir(), unixUser: self.username } as PersonConfig;
  const result = await ownerProcess({ kind: 'callerCgroup' }, person, '/usr/bin/systemd-run', ['--user', '--quiet', '--collect', '--wait', '--pipe', '--expand-environment=no', '--', '/bin/echo', 'literal ${HOME} $X $$'], undefined, undefined, undefined, 20);
  expect(result.output.toString()).toBe('literal ${HOME} $X $$\n');
  expect(result.exitCode).toBe(0);
});

it('the bash tool reports a deadline as a timeout, not as exit 130', async () => {
  const person = { uid: self.uid, gid: self.gid, home: tmpdir(), unixUser: self.username } as PersonConfig;
  const bash = ownerTools({ kind: 'callerCgroup' }, person).find(tool => tool.name === 'bash')!;
  await expect(bash.execute('t', { command: 'sleep 5', timeout: 0.3 }, undefined, undefined, undefined as never)).rejects.toThrow('Command timed out after 0.3 seconds');
  const done = await bash.execute('t', { command: 'echo ok', timeout: 5 }, undefined, undefined, undefined as never);
  expect(JSON.stringify(done.content)).toContain('ok');
});

it('self runtime stop cannot kill its own tool before the recovery command; unrelated units remain owned',()=>{
 const placement={kind:'channelScope',channel:'beta'} as const;
 for(const args of [['stop','kenan@beta'],['restart','kenan@beta.service'],['--no-block','kill','kenan@beta.service']])expect(()=>assertIndependentRuntimeControl(placement,'/usr/bin/systemctl',args)).toThrow('SELF_RUNTIME_INTERRUPTION_REQUIRES_DETACHED_TRANSACTION');
 expect(()=>assertIndependentRuntimeControl(placement,'/bin/bash',['-c','sudo systemctl stop kenan@beta; echo NEVER; sudo systemctl start kenan@beta'])).toThrow('independent system-manager');
 for(const command of ['sudo systemctl stop kenan@production','systemctl status kenan@beta','systemctl restart other.service','sudo /usr/local/sbin/kenan-runtime-restart beta','bash deploy/deploy.sh beta',"cat > f <<'EOF'\nthe apps kenan@beta and kenan@production\nsudo kenan-operator systemctl restart kenan@production\nEOF"])expect(()=>assertIndependentRuntimeControl(placement,'/bin/bash',['-c',command])).not.toThrow();
});
