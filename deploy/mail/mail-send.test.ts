import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = join(import.meta.dirname, 'mail-send');

function run(executable: string, args: string[], input: string, env: Record<string, string> = {}) {
  const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
}

function bridge() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-send-'));
  const credentials = join(dir, 'bridge.json');
  writeFileSync(credentials, JSON.stringify({ email: 'owner@example.com', password: 'unused' }));
  return { MAIL_BRIDGE_CREDENTIAL_FILE: credentials };
}

function hosted(account: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-send-hosted-'));
  const path = join(dir, 'account.json');
  writeFileSync(path, JSON.stringify(account));
  return { MAIL_ACCOUNT_FILE: path };
}
const hostedAccount = { email: 'dave@dave.example', password: 'unused', imap: { host: 'imap.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.example', port: 587, security: 'starttls' }, addresses: ['dave@dave.example'] };

// Sender choice against a fixed set of owned addresses: the Bridge check (SMTP AUTH as the address) is replaced by set membership.
const chooser = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader('mail_send', sys.argv[1])
spec = importlib.util.spec_from_loader('mail_send', loader); module = importlib.util.module_from_spec(spec); loader.exec_module(module)
owned = {'assistant@example.net', 'owner@example.net'}
out = []
for case in json.load(sys.stdin):
    parent = case['parent'] and {'delivered': [], 'from': '', 'to': [], 'cc': [], **case['parent']}
    try:
        out.append(list(module.choose_sender(case.get('explicit'), parent, lambda a: module.re.sub(r'\\+[^@]*@', '@', a) in owned)))
    except module.SenderError as error:
        out.append(error.code)
print(json.dumps(out))
`;

describe('mail-send', () => {
  // The mail tool hands the body over stdin with Node's stdio pipes, which are sockets on Linux: /dev/stdin cannot be
  // reopened from a socket, so the CLI must read the open stream (2026-10-18: every tool draft/send failed with OSError).
  it('drafts a body read from socket stdin', async () => {
    const result = await run(cli, ['--to', 'someone@example.com', '--from-addr', 'owner@example.com', '--subject', 'Socket stdin', '--body-file', '/dev/stdin'], 'Body over a socket.\n', bridge());
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '# from: owner@example.com (explicit)\n# not sent (pass --send)\n' });
    expect(result.stdout).toContain('Body over a socket.');
  });

  // 2026-10-21: a person with their own hosted mailbox (Dave) sends only as the addresses its account file lists.
  it('checks a hosted mailbox sender against its account file', async () => {
    const draft = (from: string, env: Record<string, string>) => run(cli, ['--to', 'someone@example.com', '--from-addr', from, '--subject', 'Hosted', '--body-file', '/dev/stdin'], 'Body.\n', env);
    const owned = await draft('dave+tag@dave.example', hosted(hostedAccount));
    expect({ code: owned.code, stderr: owned.stderr }).toEqual({ code: 0, stderr: '# from: dave+tag@dave.example (explicit)\n# not sent (pass --send)\n' });
    expect(owned.stdout).toMatch(/Message-ID: <[^>]+@dave\.example>/);
    const foreign = await draft('assistant@example.net', hosted(hostedAccount));
    expect(JSON.parse(foreign.stderr).error).toBe('sender-not-owned');
    const invalid = await draft('dave@dave.example', hosted({ ...hostedAccount, smtp: { host: 'smtp.example', port: 587 } }));
    expect(JSON.parse(invalid.stderr).error).toBe('account-invalid');
    const both = await draft('dave@dave.example', { ...hosted(hostedAccount), ...bridge() });
    expect(JSON.parse(both.stderr).error).toBe('account-ambiguous');
  });

  // 2026-10-19: with no sender the tool sent as the account default (assistant@) on threads that began from owner@.
  it('refuses a new message without an explicit sender', async () => {
    const result = await run(cli, ['--to', 'someone@example.com', '--subject', 'No sender', '--body-file', '/dev/stdin'], 'Body.\n', bridge());
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toBe('sender-required');
  });

  it('replies from the address of ours the message reached', async () => {
    const cases = [
      { parent: { delivered: ['owner@example.net'], from: 'Clerk <clerk@city.example>', to: ['"Kenan" <owner@example.net>'], cc: ['robin@example.org'] } },
      { parent: { delivered: ['owner+sms@example.net'], from: 'support@twilio.com' } },
      { parent: { from: '"Kenan" <owner@example.net>', to: ['clerk@city.example'] } },
      { parent: { from: 'clerk@city.example', to: ['owner@example.net'], cc: ['other@example.com'] } },
      { parent: { from: 'clerk@city.example', to: ['owner@example.net'], cc: ['assistant@example.net'] } },
      { parent: { from: 'clerk@city.example', to: ['someone@example.com'] } },
      { parent: { delivered: ['owner@example.net'] }, explicit: 'assistant@example.net' },
      { parent: null, explicit: 'stranger@example.com' },
      { parent: null, explicit: 'not an address' },
    ];
    const result = await run('python3', ['-B', '-c', chooser, cli], JSON.stringify(cases));
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([
      ['owner@example.net', 'delivered-to'],
      ['owner+sms@example.net', 'delivered-to'],
      ['owner@example.net', 'own-message'],
      ['owner@example.net', 'recipient'],
      'sender-ambiguous',
      'sender-required',
      ['assistant@example.net', 'explicit'],
      'sender-not-owned',
      'sender-invalid',
    ]);
  });
});
