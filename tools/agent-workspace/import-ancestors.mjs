// Search from the requested source, not lexical mirror refs (which may all be
// ancient). Every accepted base still needs independent full object closure.
export const IMPORT_ANCESTOR_LIMIT = 128;
export function recentImportBase(repository, sourceCommit, mirror, {git, closure}) {
 const tips = git(repository, ['rev-list', '--first-parent', `--max-count=${IMPORT_ANCESTOR_LIMIT}`, sourceCommit]).split('\n').filter(Boolean);
 for (const tip of tips) {
  if (!/^[a-f0-9]{40,64}$/u.test(tip)) throw Error('source capacity estimate unknown: invalid ancestor identity');
  if (closure(mirror, tip)) return tip;
 }
 return null;
}
