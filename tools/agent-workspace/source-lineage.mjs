// Retain exact private deployment ancestry without projecting private source to public main.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {installedEntries} from './installed-base.mjs';

const git = (repository, ...args) => execFileSync('git', ['-C', repository, ...args],
  {encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024}).trim();
const exactCommit = value => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('An immutable full commit is required.');
  return value;
};
export function retainSource(repository, custody, commit) {
  exactCommit(commit);
  if (!path.isAbsolute(custody)) throw new Error('Source custody must be an absolute local repository path.');
  fs.mkdirSync(path.dirname(custody), {recursive: true});
  if (!fs.existsSync(custody)) execFileSync('git', ['init', '--bare', custody], {stdio: 'pipe'});
  if (git(custody, 'rev-parse', '--is-bare-repository') !== 'true') throw new Error('Source custody must be a bare repository.');
  git(repository, 'push', custody, `${commit}:refs/agent-workspace/deployed/${commit}`);
  if (git(custody, 'rev-parse', `refs/agent-workspace/deployed/${commit}`) !== commit) throw new Error('Retained source identity mismatch.');
  return custody;
}
export function integrateInstalled(repository, destination, fixes) {
  if (!fixes.length) throw new Error('At least one explicit component fix commit is required.');
  if (git(repository, 'status', '--porcelain')) throw new Error('Integration requires a clean admitted checkout, including untracked files.');
  const baseline = exactCommit(fs.readFileSync(path.join(destination, '.pi-stack-commit'), 'utf8').trim());
  const receipt = JSON.parse(fs.readFileSync(path.join(destination, 'agent-workspace/.component-release.json'), 'utf8'));
  if (receipt.sourceCommit !== baseline || !path.isAbsolute(receipt.sourceRepository ?? '')) throw new Error('Installed release has no matching durable source repository.');
  // Fetch exact retained ancestry, never an arbitrary public substitute for the private line.
  git(repository, 'fetch', '--no-tags', receipt.sourceRepository, `refs/agent-workspace/deployed/${baseline}`);
  const expected = git(repository, 'ls-tree', '-r', baseline, '--', 'tools/agent-workspace').split('\n').filter(Boolean).map(line => {
    const [meta, name] = line.split('\t');
    const [mode, , object] = meta.split(' ');
    return `${mode} ${object} ${name.replace('tools/agent-workspace/', '')}`;
  }).filter(entry => !entry.endsWith(' deploy') && !entry.endsWith(' .component-release.json')).sort().join('\n');
  if (expected !== installedEntries(path.join(destination, 'agent-workspace')).join('\n')) throw new Error('Installed component bytes or modes do not match retained source.');
  const commits = fixes.map(fix => {
    exactCommit(fix);
    const parents = git(repository, 'rev-list', '--parents', '-n', '1', fix).split(' ');
    if (parents.length !== 2) throw new Error('Each fix must be a non-merge commit with one parent.');
    const changed = git(repository, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', fix).split('\0').filter(Boolean);
    if (!changed.length || changed.some(name => !name.startsWith('tools/agent-workspace/'))) throw new Error('Each fix must change only tools/agent-workspace.');
    return fix;
  });
  const branch = `repair/agent-workspace-${baseline.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  git(repository, 'switch', '-c', branch, baseline);
  // A conflict remains visible for normal resolution or git cherry-pick --abort; never reset a writer.
  git(repository, 'cherry-pick', ...commits);
  return {baseline, branch, sourceCommit: git(repository, 'rev-parse', 'HEAD'), fixes: commits,
    nextAction: 'Run the changed component tests, then bash tools/agent-workspace/deploy in this checkout.'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, repository, destination, ...args] = process.argv.slice(2);
    if (command === 'retain' && args.length === 1) console.log(retainSource(repository, destination, args[0]));
    else if (command === 'integrate' && args.length) console.log(JSON.stringify(integrateInstalled(repository, destination, args), null, 2));
    else throw new Error('Usage: source-lineage.mjs integrate ADMITTED_CHECKOUT TOOLS_DEST FIX_COMMIT... | retain CHECKOUT BARE_REPOSITORY COMMIT');
  } catch (error) { console.error(error.message); process.exitCode = 65; }
}
