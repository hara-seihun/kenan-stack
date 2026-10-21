import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { eventOf } from './event-relay.mjs';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('condition not reached in 20 s');
};

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await exited;
};
async function withChild(getChild: () => ChildProcess, run: () => Promise<void>) {
  try { await run(); } finally { await stop(getChild()); }
}

describe('event relay', () => {
  const root = mkdtempSync(join(tmpdir(), 'event-relay-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A relay following `log` whose kenan-event is the given bash `sender` body (it sees the args as "$*" and JSON on stdin). */
  const fixture = (name: string, sender: string) => {
    const dir = join(root, name), log = join(dir, 'events.jsonl'), sent = join(dir, 'sent.jsonl'), bin = join(dir, 'bin'), state = join(dir, 'state.json'), config = join(dir, 'config.json');
    mkdirSync(bin, { recursive: true });
    writeFileSync(log, JSON.stringify({ kind: 'qualify', owner: 'old' }) + '\n');
    writeFileSync(join(bin, 'kenan-event'), `#!/bin/bash\njq -c --arg args "$*" '{args: $args, body: .}' >> ${sent}\n${sender}\n`);
    chmodSync(join(bin, 'kenan-event'), 0o755);
    writeFileSync(config, JSON.stringify({ via: ['bash', '-c'], file: log, topicPrefix: 'acme', uid: 1000, state, startAt: 'end', routine: [] }));
    return {
      log, dir,
      start: () => spawn(process.execPath, [join(import.meta.dirname, 'event-relay.mjs'), config], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' }),
      lines: () => existsSync(sent) ? readFileSync(sent, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(l => JSON.parse(l)) : [],
      offset: () => existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).offset as number : null,
    };
  };

  it('forwards owned lines once as acme:<owner> events and a graceful stop saves the offset of the line it forwarded', async () => {
    const f = fixture('graceful', 'sleep 0.3');
    let relay = f.start();
    await withChild(() => relay, async () => {
      await until(() => f.offset() !== null);
      appendFileSync(f.log, JSON.stringify({ kind: 'qualify', owner: 'w1', verdict: 'qualified' }) + '\nnot json\n' + JSON.stringify({ kind: 'deploy' }) + '\n');
      await until(() => f.lines().length === 1);
      await stop(relay);
      appendFileSync(f.log, JSON.stringify({ kind: 'deploy', owner: 'w1', outcome: 'live' }) + '\n');
      relay = f.start();
      await until(() => f.lines().length === 2);
      await stop(relay);
      expect(f.offset()).toBe(statSync(f.log).size);
      const got = f.lines();
      expect(got.map(l => l.body.verdict ?? l.body.outcome)).toEqual(['qualified', 'live']);
      expect(got.every(l => /^--uid 1000 --id acme:[0-9a-f]{64} acme:w1$/.test(l.args))).toBe(true);
    });
  }, 45000);

  it('re-offers the line with the same id after a crash between forwarding it and saving its offset', async () => {
    const f = fixture('crash', '[ -e "$(dirname "$0")/crashed" ] || { touch "$(dirname "$0")/crashed"; kill -KILL $PPID; }');
    let relay = f.start();
    await withChild(() => relay, async () => {
      await until(() => f.offset() !== null);
      const before = f.offset();
      appendFileSync(f.log, JSON.stringify({ kind: 'qualify', owner: 'w2', verdict: 'qualified' }) + '\n');
      await new Promise(resolve => relay.once('exit', resolve));
      expect(relay.signalCode).toBe('SIGKILL');
      expect(f.offset()).toBe(before);
      relay = f.start();
      await until(() => f.lines().length === 2 && f.offset() === statSync(f.log).size);
      await stop(relay);
      const [first, replay] = f.lines();
      expect(replay).toEqual(first);
      expect(first.args).toMatch(/^--uid 1000 --id acme:[0-9a-f]{64} acme:w2$/);
    });
  }, 45000);

  it('reads only newline-committed output while the fake sender is appending', () => {
    const partial = '{"ok":true}\n{"unfinished":';
    expect(partial.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line))).toEqual([{ ok: true }]);
  });

  it('cleans its exact owned child when readiness fails, without terminating another child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    try {
      await expect(withChild(() => child, async () => { throw new Error('readiness failed'); })).rejects.toThrow('readiness failed');
      expect(child.signalCode).toBe('SIGTERM');
      expect(other.signalCode).toBeNull();
      expect(other.exitCode).toBeNull();
    } finally { await stop(child); await stop(other); }
  });

  it('gives a line the same id each time and refuses lines without an owner', () => {
    const line = JSON.stringify({ owner: 'abc', kind: 'suite' });
    expect(eventOf('acme', [], line)).toEqual(eventOf('acme', [], line));
    expect(eventOf('acme', [], line)).toMatchObject({ ok: true, value: { topic: 'acme:abc' } });
    expect(eventOf('acme', [], '{"owner": "a b"}')).toMatchObject({ ok: false });
    const routine = [{ kind: ['deploy'], outcome: ['live'] }];
    expect(eventOf('acme', routine, '{"owner": "abc", "kind": "deploy", "outcome": "live"}')).toMatchObject({ ok: true, value: { body: { routine: true } } });
    expect(eventOf('acme', routine, '{"owner": "abc", "kind": "deploy", "outcome": "refused"}').value.body.routine).toBeUndefined();
  });
});
