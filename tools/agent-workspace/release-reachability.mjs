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
