// Recorded disposal of candidate-local merge commits.
//
// A candidate branch is often built by merging leaves that are already durable on a
// remote (for example, several pull-request heads merged into a staging candidate).
// The merge commit itself is never pushed, so release would otherwise report
// "commits absent from remote refs" forever. A merge is disposable ONLY when it holds
// no unique source: every parent is durable on a remote (or is itself a disposable
// merge) and its tree is exactly the conflict-free merge of its two parents, so it can
// be reproduced from the durable leaves. Ordinary commits, octopus merges, conflict
// resolutions and any merge whose tree differs from the re-merge are unique source and
// are never disposable. Verification is recomputed at every release; a receipt only
// records that an owner asked for the disposal.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const MERGE_DISPOSAL_SCHEMA = 'agent-workspace.local-merge-disposal.v1';
export const MAX_DISPOSABLE_MERGES = 64;
const SHA = /^[a-f0-9]{40,64}$/u;

function requireShas(list) {
  if (list.some(sha => !SHA.test(sha))) throw new Error('merge disposal requires exact commit identities');
}

// Returns {ok:true, merges:[{commit,parents,tree}]} or {ok:false, reason}.
// `git(args, options)` returns trimmed stdout and throws on a non-zero exit.
export function classifyLocalMerges(git, candidates, durable) {
  const tips = [...new Set(candidates)], covered = [...new Set(durable)];
  if (!tips.length) throw new Error('merge disposal has no candidates');
  requireShas([...tips, ...covered]);
  const output = git(['rev-list', '--parents', `--max-count=${MAX_DISPOSABLE_MERGES + 1}`, '--stdin'], {
    input: [...tips, ...covered.map(tip => `^${tip}`)].join('\n') + '\n',
  });
  const rows = output === '' ? [] : output.split('\n').map(line => line.split(' '));
  if (rows.length === 0) return {ok: true, merges: []};
  if (rows.length > MAX_DISPOSABLE_MERGES) return {ok: false, reason: `more than ${MAX_DISPOSABLE_MERGES} commits are absent from remotes`};
  const uncovered = new Set(rows.map(row => row[0]));
  const merges = [];
  for (const [commit, ...parents] of rows) {
    requireShas([commit, ...parents]);
    if (parents.length < 2) return {ok: false, reason: `commit ${commit} is ordinary local source, not a merge`, commit};
    if (parents.length > 2) return {ok: false, reason: `merge ${commit} has ${parents.length} parents; only two-parent merges are reproducible`, commit};
    // A parent outside the uncovered set is reachable from durable remote refs.
    // A parent inside it must itself be a verified merge (checked in this loop).
    let reproduced;
    try {
      reproduced = git(['merge-tree', '--write-tree', '--no-messages', parents[0], parents[1]]).split('\n')[0];
    } catch {
      return {ok: false, reason: `merge ${commit} is not a conflict-free merge of its parents`, commit};
    }
    const tree = git(['rev-parse', `${commit}^{tree}`]);
    if (!SHA.test(reproduced) || reproduced !== tree) {
      return {ok: false, reason: `merge ${commit} contains content beyond its parents (conflict resolution or edits)`, commit};
    }
    merges.push({commit, parents, tree});
  }
  return {ok: true, merges, uncovered: [...uncovered]};
}

export function mergeDisposalDirectory(gitCommonDir) {
  return path.join(gitCommonDir, 'agent-workspace-merge-disposals');
}

export function recordMergeDisposal({gitCommonDir, workspaceId, owner, head, merges, durable, now = Date.now()}) {
  if (!merges.length) throw new Error('nothing to record');
  const body = {schema: MERGE_DISPOSAL_SCHEMA, workspaceId, owner, head, recordedAt: now,
    durableRemoteTips: [...new Set(durable)].sort(), merges};
  const text = JSON.stringify(body, null, 2) + '\n';
  const sha256 = createHash('sha256').update(text).digest('hex');
  const directory = mergeDisposalDirectory(gitCommonDir);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, `${head}-${sha256.slice(0, 16)}.json`);
  if (!existsSync(file)) {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, {mode: 0o600});
    renameSync(temporary, file);
  }
  return {file, sha256, receipt: body};
}

export function recordedDisposedCommits(gitCommonDir) {
  const directory = mergeDisposalDirectory(gitCommonDir);
  const recorded = new Set();
  if (!existsSync(directory)) return recorded;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    try {
      const receipt = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      if (receipt.schema !== MERGE_DISPOSAL_SCHEMA) continue;
      for (const merge of receipt.merges ?? []) if (SHA.test(merge.commit)) recorded.add(merge.commit);
    } catch { /* unreadable receipt records nothing */ }
  }
  return recorded;
}

// True only when release may treat the remaining uncovered commits as disposed:
// they all verify as reproducible merges NOW and every one was explicitly recorded.
export function disposedMergesCoverRelease(git, gitCommonDir, candidates, durable) {
  const verdict = classifyLocalMerges(git, candidates, durable);
  if (!verdict.ok || verdict.merges.length === 0) return false;
  const recorded = recordedDisposedCommits(gitCommonDir);
  return verdict.merges.every(merge => recorded.has(merge.commit));
}
