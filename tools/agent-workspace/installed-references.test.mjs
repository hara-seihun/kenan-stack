// target: release/reconcile deletion guard. level: unit. intent: incident regression (2026-10-19 converge Slack sender). size: small.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {workspaceTesting} from './workspace.mjs';

test('an installed file naming a checkout keeps it referenced; node_modules are not scanned', () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'installed-refs-'));
  try {
    const install = path.join(base, 'opt', 'sender', 'abc');
    fs.mkdirSync(install, {recursive: true});
    fs.mkdirSync(path.join(base, 'opt', 'sender', 'node_modules'), {recursive: true});
    fs.writeFileSync(path.join(install, 'bundle.js'), 'var __dirname = "/home/kenan/work/clones/sender-src/node_modules/playwright-core/lib";\n');
    fs.writeFileSync(path.join(base, 'opt', 'sender', 'node_modules', 'ignored.js'), '"/home/kenan/work/clones/unrelated/x"');
    const installed = workspaceTesting.installedReferenceSnapshot([path.join(base, 'opt')]);
    assert.deepEqual(installed.map(r => r.path), ['/home/kenan/work/clones/sender-src/node_modules/playwright-core/lib']);
    const record = {id: 'r', path: '/home/kenan/work/clones/sender-src', state: 'active', leaseExpiresAt: 0, checkoutType: 'clone'};
    const safety = {processes: [], threads: [], docker: {containers: [], available: false}, systemd: {units: [], available: false}, installed,
      currentStackQueue: {errors: [], references: [], observedAt: Date.now()}};
    assert.deepEqual(installed.filter(r => r.path.startsWith('/home/kenan/work/clones/unrelated')), []);
    fs.mkdirSync(path.join(base, 'sender-src'));
    const held = workspaceTesting.inspectRecord({...record, path: path.join(base, 'sender-src')},
      {safety: {...safety, installed: [{file: path.join(install, 'bundle.js'), path: path.join(base, 'sender-src', 'node_modules', 'x')}]}, ignoreLease: true});
    assert.equal(held.classification, 'referenced');
    assert.match(held.reason, /installed file\(s\) under \/opt, \/srv or \/etc\/systemd name this checkout/);
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});
