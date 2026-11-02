// A mirror can gain a real shallow boundary after a shared checkout was made.
// Read that checkout through a private Git view; never change an active writer.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function withDonorView(repository, mirror, commit, {git, command}, action) {
 if (!mirror || !fs.existsSync(repository) || !fs.existsSync(path.join(mirror, 'shallow'))) return action(repository);
 const objects = git(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
 const alternateFile = path.join(objects, 'info', 'alternates');
 if (!fs.existsSync(alternateFile)) return action(repository);
 const stores = fs.readFileSync(alternateFile, 'utf8').split('\n').filter(Boolean).map(p => path.resolve(objects, p));
 if (!stores.includes(path.join(mirror, 'objects'))) return action(repository);
 const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
 const own = read(git(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']));
 const mirrored = read(path.join(mirror, 'shallow'));
 const valid = id => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id);
 if ([...own, ...mirrored].some(id => !valid(id))) throw Error('invalid donor shallow boundary');
 const missing = mirrored.filter(id => {
  if (own.includes(id)) return false;
  const body = command(repository, ['cat-file', 'commit', id]);
  if (body.status !== 0) return false; // This boundary is not in the donor.
  const headers = body.stdout.split('\n\n', 1)[0].split('\n');
  const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.some(id => !valid(id))) throw Error('invalid donor parent identity');
  return parents.some(parent => {
   const probe = command(repository, ['cat-file', '--batch-check'], {input: parent + '\n'});
   if (probe.status !== 0) throw Error('donor parent presence is unknown');
   return probe.stdout.trim() === `${parent} missing`;
  });
 });
 if (!missing.length) return action(repository);
 const view = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-donor-view-'));
 try {
  git(view, ['init', '--bare', '--quiet']);
  fs.writeFileSync(path.join(view, 'objects', 'info', 'alternates'), objects + '\n');
  fs.writeFileSync(path.join(view, 'shallow'), [...new Set([...own, ...missing])].join('\n') + '\n');
  git(view, ['update-ref', 'refs/heads/source', commit]);
  return action(view);
 } finally { fs.rmSync(view, {recursive: true, force: true}); }
}
