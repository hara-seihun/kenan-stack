import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const modules = ['qualification-references', 'operator-observe', 'source-lineage', 'workspace'];
const run = (args, input) => spawnSync(process.execPath, args, {
  input, encoding: 'utf8', timeout: 10000,
});

for (const name of modules) {
  const url = new URL(`./${name}.mjs`, import.meta.url);
  const code = `const module = await import(${JSON.stringify(url.href)});\n${name === 'workspace' ? 'if (!module.workspaceTesting) throw new Error("workspaceTesting is missing");' : ''}\nconsole.log('imported');`;
  for (const mode of ['stdin', 'eval', 'missing-file']) {
    test(`${name} imports without CLI effects through ${mode}`, () => {
      const args = mode === 'stdin' ? ['--input-type=module', '-']
        : ['--input-type=module', '--eval', mode === 'missing-file'
          ? `process.argv[1] = '/nonexistent-workspace-import-entry.mjs';\n${code}` : code];
      const result = run(args, mode === 'stdin' ? code : undefined);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'imported\n');
    });
  }
  test(`${name} still executes its normal CLI entry`, () => {
    const result = run([fileURLToPath(url), ...(name === 'workspace' ? ['--help'] : [])]);
    assert.equal(result.error, undefined);
    const expected = { 'qualification-references': 64, 'source-lineage': 65, 'operator-observe': 77, workspace: 0 };
    assert.equal(result.status, expected[name], result.stderr);
    assert.match(result.stdout + result.stderr, name === 'workspace' ? /agent-workspace/ : name === 'operator-observe' ? /operator-observe: refused:/ : /usage:/i);
  });
}
