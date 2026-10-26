import fs from 'node:fs';
import path from 'node:path';

// This operation owns only the directory entry, never the resolved dependency tree.
// Both spellings are observed because kernel FD/cwd paths resolve a symlink.
export function unlinkDeclaredCacheSymlink(context) {
  const {root, target, declarations} = context;
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) ||
      !declarations.some(d => d === relative || d.startsWith('**/') && path.basename(relative) === d.slice(3))) return false;
  const snapshot = () => {
    if (fs.realpathSync(root) !== root) return null;
    const ancestors = [];
    let current = root;
    for (const part of ['', ...relative.split(path.sep).slice(0, -1)]) {
      if (part) current = path.join(current, part);
      const stat = fs.lstatSync(current, {bigint:true});
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      ancestors.push([current, String(stat.dev), String(stat.ino)]);
    }
    const stat = fs.lstatSync(target, {bigint:true});
    if (!stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n || String(stat.dev) !== ancestors[0][1]) return null;
    let resolved;
    try { resolved = fs.realpathSync(target); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ELOOP') return null; throw error; }
    return {ancestors, device:String(stat.dev), inode:String(stat.ino), uid:String(stat.uid), link:fs.readlinkSync(target), resolved};
  };
  const before = snapshot();
  if (!before || context.tracked(target) || !context.ignored(relative)) return false;
  const safety = context.observe([...new Set([target, before.resolved])]);
  if (!safety || !Array.isArray(safety.errors) || !Array.isArray(safety.references) || !Array.isArray(safety.retainedBorrowers) ||
      !Number.isSafeInteger(safety.observedAt) || safety.observedAt > Date.now() || Date.now() - safety.observedAt > 60000 ||
      safety.errors.length || safety.references.length || safety.retainedBorrowers.length) return false;
  // Do not unlink a replacement or a path reached through a replaced ancestor.
  if (context.tracked(target) || !context.ignored(relative) || JSON.stringify(snapshot()) !== JSON.stringify(before)) return false;
  context.invalidateCapacity();
  fs.unlinkSync(target);
  return true;
}

// Installed consumers of a canonical dependency tree do not borrow every other
// symlink to it. Only an installed lexical alias reference depends on the entry
// being unlinked. Process/queue/qualification target observations remain strict.
export function cacheAliasInstalledReferences(alias, snapshot) {
  if (!path.isAbsolute(alias) || !Array.isArray(snapshot)) throw new Error('exact cache alias and installed snapshot required');
  return snapshot.filter(row => typeof row.path === 'string' &&
    (row.path === alias || row.path.startsWith(alias + path.sep)));
}
