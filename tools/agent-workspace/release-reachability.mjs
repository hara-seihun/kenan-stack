// One union walk is equivalent to asking whether any candidate has commits outside
// the union of durable exclusions. Revision operands use stdin to avoid ARG_MAX.
export function hasUncoveredCommits(git, candidates, exclusions) {
  if (!candidates.length) throw new Error('release reachability has no candidates');
  const tips = [...new Set(candidates)], durable = [...new Set(exclusions)];
  if ([...tips, ...durable].some(tip => !/^[a-f0-9]{40,64}$/u.test(tip))) {
    throw new Error('release reachability requires exact commit identities');
  }
  const output = git(['rev-list', '--max-count=1', '--stdin'], {
    input: [...tips, ...durable.map(tip => `^${tip}`)].join('\n') + '\n',
  });
  if (output === '') return false;
  if (!/^[a-f0-9]{40,64}$/u.test(output)) throw new Error('malformed release reachability result');
  return true;
}

// Fresh, read-only remote custody: every head each configured remote advertises now (any
// branch name, not only the local branch names), kept only when the commit object is present
// locally so ancestry can be walked. A remote tip that is not present locally proves nothing
// and is left out; local object existence alone is never counted as durable.
// `command(file, args, options)` returns {status, stdout, error}.
export const MAX_RELEASE_REMOTES = 16;
export function observedRemoteHeads(command, repository, {timeout = 4000} = {}) {
  const listed = command('git', ['-C', repository, 'remote'], {timeout});
  if (listed.status !== 0 || listed.error) return {ok: false, code: 'remote-custody-unknown', detail: 'remote inventory failed'};
  const remotes = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (!remotes.length) return {ok: false, code: 'remote-custody-absent', detail: 'no configured remote'};
  if (remotes.length > MAX_RELEASE_REMOTES) return {ok: false, code: 'remote-custody-unknown', detail: `more than ${MAX_RELEASE_REMOTES} remotes`};
  const durable = [], observations = [];
  for (const remote of remotes) {
    const advertised = command('git', ['-C', repository, 'ls-remote', '--heads', remote], {timeout});
    if (advertised.status !== 0 || advertised.error) return {ok: false, code: 'remote-custody-unknown', detail: `fresh remote observation failed: ${remote}`};
    const tips = [];
    for (const line of advertised.stdout.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(/\s+/u);
      if (!/^[a-f0-9]{40,64}$/u.test(sha) || !ref?.startsWith('refs/heads/')) return {ok: false, code: 'remote-custody-unknown', detail: `malformed remote refs: ${remote}`};
      tips.push(sha);
    }
    const unique = [...new Set(tips)];
    if (unique.length) {
      const checked = command('git', ['-C', repository, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], {input: unique.join('\n') + '\n', timeout});
      if (checked.status !== 0 || checked.error) return {ok: false, code: 'remote-custody-unknown', detail: 'remote object inventory failed'};
      const rows = checked.stdout.split('\n').filter(Boolean);
      if (rows.length !== unique.length) return {ok: false, code: 'remote-custody-unknown', detail: 'incomplete remote object inventory'};
      for (let index = 0; index < rows.length; index++) {
        const [name, type] = rows[index].split(' ');
        if (type === 'commit' && name === unique[index]) durable.push(unique[index]);
        else if (!(type === 'missing' && name === unique[index])) return {ok: false, code: 'remote-custody-unknown', detail: 'invalid remote object response'};
      }
    }
    observations.push({remote, heads: tips.length, presentLocally: durable.length, observedAt: Date.now()});
  }
  return {ok: true, durable: [...new Set(durable)], observations};
}
