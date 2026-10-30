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
  // Checkout-level references were inspected just before caches are stripped; the
  // alias spelling attributes a reader of the real target to this checkout.
  const safety = context.observe([...new Set([target, before.resolved])]);
  if (!safety || !Array.isArray(safety.errors) || !Array.isArray(safety.references) || !Array.isArray(safety.retainedBorrowers) ||
      !Number.isSafeInteger(safety.observedAt) || safety.observedAt > Date.now() || Date.now() - safety.observedAt > 60000 ||
      safety.errors.length || aliasBlockingReferences(safety.references, {root, target, resolved:before.resolved}).length ||
      safety.retainedBorrowers.length) return false;
  // Do not unlink a replacement or a path reached through a replaced ancestor.
  if (context.tracked(target) || !context.ignored(relative) || JSON.stringify(snapshot()) !== JSON.stringify(before)) return false;
  context.invalidateCapacity();
  fs.unlinkSync(target);
  return true;
}

// Unlinking an alias never touches its real target: open descriptors, mappings and cwds
// in that tree stay valid, and Node and Bun load later modules by real path. A process
// whose only observed reference is the shared real target (another agent's test run in
// the canonical node_modules, for example) therefore does not depend on this alias, and
// counting it left every checkout that links a busy shared tree repair-required.
// Such a reference still blocks when the same process also references the alias, when
// the target lies inside the checkout, or when it carries no process id. Release has
// already refused a checkout that any process references by cwd, argument or descriptor.
export function aliasBlockingReferences(references, {root, target, resolved}) {
  if (!Array.isArray(references)) throw new Error('references required');
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  const attributed = new Set(references.filter(ref => Number.isSafeInteger(ref?.pid) && ref.root !== resolved).map(ref => ref.pid));
  return references.filter(ref => inside || !Number.isSafeInteger(ref?.pid) || ref.root !== resolved || attributed.has(ref.pid));
}

// Installed consumers of a canonical dependency tree do not borrow every other
// symlink to it. Only an installed lexical alias reference depends on the entry
// being unlinked. Process/queue/qualification target observations remain strict.
export function cacheAliasInstalledReferences(alias, snapshot) {
  if (!path.isAbsolute(alias) || !Array.isArray(snapshot)) throw new Error('exact cache alias and installed snapshot required');
  return snapshot.filter(row => typeof row.path === 'string' &&
    (row.path === alias || row.path.startsWith(alias + path.sep)));
}
