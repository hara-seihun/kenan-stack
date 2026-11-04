import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {selectedArguments} from './cli-contract.mjs';

test('help distinguishes ordinary repricing from the explicit active-reduction form', () => {
  const help = spawnSync(process.execPath, [new URL('./workspace.mjs', import.meta.url).pathname, '--help'], {encoding:'utf8', timeout:10000});
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Ordinary reprice-capacity accepts exactly one selector: use --id ID or --path PATH, never both\./);
  assert.match(help.stdout, /Only an explicit active reduction uses both selectors:\n  agent-workspace reprice-capacity --id ID --path PATH --owner OWNER --reduction FILE --reduction-sha256 SHA256/);
  const documentation = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(documentation, /Ordinary `reprice-capacity` requires exactly one selector/);
});

test('invalid ordinary reprice selectors explain the exception without changing selection', () => {
  for (const input of [{}, {id:'fixture',path:'/fixture'}]) {
    const result = selectedArguments('reprice-capacity', input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-workspace-selector');
    assert.equal(result.error.nextAction.command, 'reprice-capacity');
    assert.match(result.error.detail, /Ordinary repricing uses --id ID or --path PATH, never both\./);
    assert.match(result.error.detail, /only for an explicit active reduction with --owner, --reduction and --reduction-sha256\./);
  }
  assert.equal(selectedArguments('reprice-capacity',{id:'fixture'}).ok,true);
  assert.equal(selectedArguments('reprice-capacity',{path:'/fixture'}).ok,true);
  assert.equal(selectedArguments('growth-status',{id:'fixture',path:'/fixture'}).ok,true);
  assert.equal(selectedArguments('resume-growth',{id:'fixture',path:'/fixture'}).ok,true);
});
