import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const MAX_LOCAL = 50000, MAX_PINS = 4096, BATCH = 512;
const MAX_OUTPUT = 64 * 1024 * 1024, MAX_OBJECT = 16 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), {code: 'FROZEN_OBJECT_CUSTODY_UNAVAILABLE'}); };
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function canonical(file, directory = true) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) fail('Custody paths must be canonical and absolute.');
  let part = path.parse(file).root;
  for (const component of file.slice(part.length).split('/').filter(Boolean)) {
    part = path.join(part, component);
    if (fs.lstatSync(part).isSymbolicLink()) fail('Custody paths must not contain symbolic links.');
  }
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || (directory && !stat.isDirectory()) || (!directory && !stat.isFile())) fail('Custody requires a private, same-owner path.');
  return file;
}
function privateGit(directory) {
  canonical(directory);
  for (const name of ['commondir', 'gitdir', 'shallow', 'info/grafts']) {
    if (exists(path.join(directory, name))) fail('Shared Git directories, grafts and shallow repositories cannot be frozen.');
  }
  canonical(path.join(directory, 'objects'));
}
function readSmall(file) {
  canonical(file, false);
  if (fs.statSync(file).size > 16384) fail('Alternate metadata exceeds its bounded size.');
  return fs.readFileSync(file, 'utf8');
}

/** Preserve borrowed objects by permanent mirror refs. This never repacks, copies, or deletes objects.
 * The caller keeps its normal workspace/mirror mutation exclusion through freezing the source tree.
 */
export function prepareFrozenObjectCustody({path: source, head, id, statePath, dryRun = false}) {
  if (typeof dryRun !== 'boolean') fail('dryRun must be a boolean.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail('An exact head and a safe workspace identity are required.');
  const deadline = Date.now() + 120000;
  // Do not inherit an alternate object store, namespace, replacement map, or injected Git configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'});
  function git(directory, args, input, maxBuffer = MAX_OUTPUT, allowFailure = false) {
    const timeout = Math.min(30000, deadline - Date.now());
    if (timeout < 1) fail('Frozen object custody exceeded its total command budget.');
    const result = spawnSync('git', ['--git-dir', directory, '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', ...args], {env, input, timeout, maxBuffer, killSignal: 'SIGKILL'});
    if (result.error || result.signal || (!allowFailure && result.status !== 0)) fail('Git could not validate frozen object custody: ' + String(result.error?.code || result.stderr?.toString() || result.status).slice(0, 500));
    return result;
  }
  canonical(source);
  const sourceGit = path.join(source, '.git');
  const alternateFile = path.join(sourceGit, 'objects/info/alternates');
  let alternate = null, mirror = null, alternateBytes = null;
  function validateGit(directory) {
    privateGit(directory);
    if (git(directory, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/'], undefined, 16384).stdout.length) fail('Replacement refs cannot be frozen.');
    if (exists(path.join(directory, 'objects/info/http-alternates'))) fail('HTTP alternates cannot be frozen.');
  }
  function validateSource() {
    validateGit(sourceGit);
    if (git(sourceGit, ['rev-parse', '--verify', 'HEAD^{commit}'], undefined, 16384).stdout.toString().trim() !== head) fail('The source head changed.');
    if (alternate === null) {
      if (exists(alternateFile)) fail('Source alternate custody changed.');
    } else if (!exists(alternateFile) || readSmall(alternateFile) !== alternateBytes) fail('Source alternate custody changed.');
  }
  validateGit(sourceGit);
  if (exists(alternateFile)) {
    alternateBytes = readSmall(alternateFile);
    const lines = alternateBytes.replace(/\n$/, '').split('\n');
    if (lines.length !== 1 || !lines[0]) fail('Exactly one canonical managed alternate is required.');
    alternate = canonical(lines[0]);
    const managedRoot = canonical(path.join(path.dirname(statePath), 'mirrors'));
    mirror = path.dirname(alternate);
    if (path.basename(alternate) !== 'objects' || path.dirname(mirror) !== managedRoot || !/^[A-Za-z0-9._-]+\.git$/.test(path.basename(mirror))) fail('The alternate is outside managed mirror custody.');
    validateGit(mirror);
    if (exists(path.join(alternate, 'info/alternates'))) fail('Nested alternates cannot preserve frozen source.');
  }
  validateSource();
  const oid = value => { if (!new RegExp(`^[a-f0-9]{${head.length}}$`).test(value)) fail('Invalid object identity in Git graph.'); return value; };
  function metadata(directory, objects) {
    const lines = git(directory, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], objects.join('\n') + '\n', 1024 * 1024).stdout.toString().trimEnd().split('\n');
    if (lines.length !== objects.length) fail('Incomplete object metadata.');
    return lines.map((line, i) => {
      const [object, type, size] = line.split(' ');
      if (object !== objects[i]) fail('Git returned an unexpected object.');
      if (type === 'missing') return null;
      if (!['commit', 'tree', 'blob'].includes(type) || !/^\d+$/.test(size)) fail('Unsupported object type in source closure.');
      return {type, size: Number(size)};
    });
  }
  function links(objects, types) {
    if (!objects.length) return [];
    if (types.some(item => item.size > MAX_OBJECT)) fail('A graph object exceeds its bounded size.');
    const bytes = git(sourceGit, ['cat-file', '--batch'], objects.join('\n') + '\n').stdout;
    let offset = 0; const children = [];
    for (let i = 0; i < objects.length; i++) {
      const end = bytes.indexOf(10, offset);
      const expected = `${objects[i]} ${types[i].type} ${types[i].size}`;
      if (end < 0 || bytes.subarray(offset, end).toString() !== expected) fail('Object content metadata changed.');
      const start = end + 1, stop = start + types[i].size;
      if (stop >= bytes.length || bytes[stop] !== 10) fail('Incomplete object content.');
      const body = bytes.subarray(start, stop); offset = stop + 1;
      if (types[i].type === 'commit') {
        const headers = body.toString('utf8').split('\n\n', 1)[0].split('\n');
        if (!headers[0]?.startsWith('tree ')) fail('Commit tree is missing.');
        children.push(oid(headers[0].slice(5)));
        for (const header of headers.slice(1)) if (header.startsWith('parent ')) children.push(oid(header.slice(7)));
      } else {
        let cursor = 0;
        while (cursor < body.length) {
          const space = body.indexOf(32, cursor), nul = body.indexOf(0, space + 1);
          if (space < cursor || nul < space || nul + 1 + head.length / 2 > body.length) fail('Invalid tree encoding.');
          const mode = body.subarray(cursor, space).toString();
          if (!['100644', '100755', '120000', '40000', '160000'].includes(mode)) fail('Unsupported tree mode.');
          if (mode !== '160000') children.push(oid(body.subarray(nul + 1, nul + 1 + head.length / 2).toString('hex')));
          cursor = nul + 1 + head.length / 2;
        }
      }
    }
    if (offset !== bytes.length) fail('Unexpected object content output.');
    return children;
  }
  const seen = new Set(), boundary = new Set();
  let queue = [head], localCount = 0;
  for (let cursor = 0; cursor < queue.length;) {
    const batch = [];
    while (cursor < queue.length && batch.length < BATCH) {
      const object = queue[cursor++];
      if (!seen.has(object)) { seen.add(object); batch.push(object); }
    }
    if (!batch.length) continue;
    const borrowed = mirror ? metadata(mirror, batch) : batch.map(() => null);
    const local = batch.filter((object, i) => {
      if (!borrowed[i]) return true;
      boundary.add(object);
      if (boundary.size > MAX_PINS) fail('Frozen custody exceeds 4096 boundary pins.');
      return false;
    });
    localCount += local.length;
    if (localCount > MAX_LOCAL) fail('Frozen custody exceeds 50000 local graph nodes.');
    if (!local.length) continue;
    const types = metadata(sourceGit, local);
    if (types.some(item => item === null)) fail('Source closure contains a missing object.');
    const structural = local.flatMap((object, i) => types[i].type === 'blob' ? [] : [{object, ...types[i]}]);
    for (const child of links(structural.map(item => item.object), structural)) queue.push(child);
    // Bound queued duplicate edges as well as unique nodes, independently of object sizes.
    if (queue.length > 1000000) fail('Source graph exceeds its bounded edge count.');
  }
  function closure(directory, objects) {
    if (objects.length) git(directory, ['rev-list', '--objects', '--no-object-names', '--missing=error', ...objects, '--']);
  }
  const objects = [...boundary].sort();
  const prefix = `refs/pi-workspace-frozen/${id}/${head}/`;
  const pins = objects.map(object => ({ref: prefix + object, object}));
  function checkClosures() {
    validateSource();
    if (mirror) {
      validateGit(mirror);
      if (exists(path.join(alternate, 'info/alternates'))) fail('Mirror alternate custody changed.');
    }
    closure(sourceGit, [head]);
    if (mirror) closure(mirror, objects);
  }
  checkClosures();
  if (pins.length) {
    // Verify existing refs and create absent ones in one compare-and-swap transaction.
    // A concurrent identical creator is harmless; re-read once and verify its exact objects.
    let committed = false;
    for (let attempt = 0; attempt < 2 && !committed; attempt++) {
      const refs = new Map();
      const output = git(mirror, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', prefix], undefined, 2 * 1024 * 1024).stdout.toString();
      for (const line of output.trimEnd().split('\n').filter(Boolean)) {
        const [ref, object, symbolic] = line.split(' ');
        if (symbolic) fail('Frozen boundary refs must not be symbolic.');
        refs.set(ref, object);
      }
      const commands = ['start', 'option no-deref'];
      for (const pin of pins) {
        if (refs.has(pin.ref) && refs.get(pin.ref) !== pin.object) fail('An existing frozen boundary ref names the wrong object.');
        commands.push(refs.has(pin.ref) ? `verify ${pin.ref} ${pin.object}` : `create ${pin.ref} ${pin.object}`);
      }
      commands.push('prepare', 'commit', '');
      committed = dryRun || git(mirror, ['-c', 'core.fsync=reference', '-c', 'core.fsyncMethod=fsync', 'update-ref', '--stdin'], commands.join('\n'), 1024 * 1024, true).status === 0;
    }
    if (!committed) fail('Concurrent mirror ref changes prevented atomic custody.');
  }
  // Failed post-pin validation intentionally leaves permanent preservation refs in place.
  checkClosures();
  return mirror ? {kind: 'managed-mirror-pins', alternate, pins} : {kind: 'private-git'};
}
