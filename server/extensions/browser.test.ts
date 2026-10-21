import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types.js';
import { runBrowser, type BrowserDeps } from './browser.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-route-'));
  const settings = join(root, 'domain.json'), kernelDir = join(root, 'kernel'), calls: { executable: string; args: string[] }[] = [];
  await writeFile(settings, JSON.stringify({ tools: { browser: { executable: '/tc/agent-browser', executablePath: '/tc/chrome', session: 'alice-beta', configurationPath: '/tc/empty.json' } } }));
  const deps: BrowserDeps = {
    kernelBrowser: '/bin/kernel-browser', kernelConfigDir: () => kernelDir, bindingDir: () => join(root, 'bindings'),
    run: async (_ctx, executable, args) => {
      calls.push({ executable, args });
      if (executable === '/bin/kernel-browser' && (args[0] === 'start' || args[0] === 'attach')) {
        const session = args[0] === 'start' ? 'k1' : args[1]!;
        await import('node:fs/promises').then(fs => fs.mkdir(kernelDir, { recursive: true }).then(() => fs.writeFile(join(kernelDir, `${session}.json`), '{}')));
        return { exitCode: 0, output: Buffer.from(`{"session_id": "${session}", "config_path": "${kernelDir}/${session}.json"}\n`) };
      }
      if (args.includes('tab')) return { exitCode: 0, output: Buffer.from(JSON.stringify({ success: true, data: { tabs: [{ active: false, targetId: 'OTHER' }, { active: true, targetId: 'ACTIVE' }] } })) };
      return { exitCode: 0, output: Buffer.from('ok\n') };
    },
  };
  const ctx = (agentId: string) => ({ person: { id: 'alice', uid: 1000, extensionConfigPath: settings }, agent: { id: agentId }, deps: { now: () => 1 } }) as unknown as ToolContext;
  return { root, kernelDir, deps, ctx, calls };
}

describe('browser routing', () => {
  it('sends every command to the Kernel browser an agent started until it stops it, and never falls back to local Chrome', async () => {
    const f = await fixture(), worker = f.ctx('w1'), other = f.ctx('w2');
    await runBrowser(f.deps, worker, { action: 'command', args: ['open', 'https://a.test'] }, undefined);
    expect(f.calls.at(-1)!.args).toEqual(['--executable-path', '/tc/chrome', '--session', 'alice-beta', 'open', 'https://a.test']);

    expect((await runBrowser(f.deps, worker, { action: 'start', profile: 'helper-google' }, undefined)).content[0]!.text).toContain('now go to Kernel session k1');
    const kernel = ['--config', join(f.kernelDir, 'k1.json'), '--session', 'kernel-k1', 'snapshot', '-i'];
    for (const agent of [worker, f.ctx('w1')]) {
      const result = await runBrowser(f.deps, agent, { action: 'command', args: ['snapshot', '-i'] }, undefined);
      expect(f.calls.at(-1)!.args).toEqual(kernel);
      expect(result.details).toMatchObject({ browser: 'kernel:k1' });
    }
    await runBrowser(f.deps, other, { action: 'command', args: ['snapshot', '-i'] }, undefined);
    expect(f.calls.at(-1)!.args[0]).toBe('--executable-path');
    await runBrowser(f.deps, other, { action: 'command', session: 'k1', args: ['snapshot', '-i'] }, undefined);
    expect(f.calls.at(-1)!.args).toEqual(kernel);

    await rm(join(f.kernelDir, 'k1.json'));
    const before = f.calls.length;
    await expect(runBrowser(f.deps, worker, { action: 'command', args: ['snapshot'] }, undefined)).rejects.toThrow(/^kernel_session_ended/);
    await expect(runBrowser(f.deps, other, { action: 'command', session: 'gone1', args: ['snapshot'] }, undefined)).rejects.toThrow(/^kernel_session_ended/);
    expect(f.calls.length).toBe(before);

    expect((await runBrowser(f.deps, worker, { action: 'stop' }, undefined)).content[0]!.text).toContain('local browser again');
    expect(f.calls.at(-1)).toEqual({ executable: '/bin/kernel-browser', args: ['stop', 'k1'] });
    await runBrowser(f.deps, worker, { action: 'command', args: ['snapshot'] }, undefined);
    expect(f.calls.at(-1)!.args[0]).toBe('--executable-path');
    await rm(f.root, { recursive: true });
  });

  it('auth fill resolves through the person\'s plugin config and targets the active tab when no target is given', async () => {
    const f = await fixture(), worker = f.ctx('w1');
    const fill = ['auth', 'fill', '--credential-provider', 'proton-pass', '--item', 'Item', '--field', 'password', '--selector', 'input[type=password]', '--frame', 'main'];
    await runBrowser(f.deps, worker, { action: 'command', args: fill }, undefined);
    expect(f.calls.at(-2)!.args).toEqual(['--executable-path', '/tc/chrome', '--session', 'alice-beta', '--json', 'tab', 'list']);
    expect(f.calls.at(-1)!.args).toEqual(['--executable-path', '/tc/chrome', '--session', 'alice-beta', ...fill, '--target', 'ACTIVE']);
    expect(f.calls.flatMap(call => call.args)).not.toContain('--config');
    await runBrowser(f.deps, worker, { action: 'attach', session: 'k9' }, undefined);
    await runBrowser(f.deps, worker, { action: 'command', args: [...fill, '--target', 'GIVEN'] }, undefined);
    expect(f.calls.at(-1)!.args).toEqual(['--config', join(f.kernelDir, 'k9.json'), '--session', 'kernel-k9', ...fill, '--target', 'GIVEN']);
    await expect(runBrowser(f.deps, worker, { action: 'attach', session: '../x' }, undefined)).rejects.toThrow(/^kernel_session_invalid/);
    await rm(f.root, { recursive: true });
  });
});
