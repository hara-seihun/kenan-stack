// Bounded reader/writer observation of checkout roots through /proc.
// A process counts as an active growth writer only when it holds a writable (O_WRONLY or O_RDWR) file
// descriptor on a path inside a checkout root. Read-only descriptors, working directories, executables and
// command-line mentions are recorded as read-only references. Anything that cannot be proven (permission
// errors, malformed fd flags, unstable process identity, exceeded bounds, unresolved units) is reported as
// an error so the caller classifies it as unknown. This module never deletes or changes anything.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const DEFAULT_BOUNDS = Object.freeze({maxPids: 20000, maxFdsPerPid: 4096, maxReferences: 512, maxErrors: 64});
const O_ACCMODE = 3;
const stripDeleted = target => target.replace(/ \(deleted\)$/, '');
const within = (target, root) => target === root || target.startsWith(root.endsWith('/') ? root : root + '/');

function normalizeRoots(roots, io) {
  const out = new Set();
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('growth roots must be absolute paths');
    out.add(path.resolve(root));
    try { out.add(io.realpathSync(root)); } catch { /* an absent root has no descriptors to match */ }
  }
  return [...out];
}
const matchRoot = (target, roots) => {
  const t = stripDeleted(target);
  return roots.find(root => within(t, root));
};

// Field 22 of /proc/PID/stat (starttime); the comm field may contain spaces and parentheses.
export function parseStartIdentity(stat) {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).split(' ');
  const start = fields[19];
  return /^\d+$/.test(start ?? '') ? start : null;
}
export function parseFdFlags(fdinfo) {
  const match = /^flags:\s*([0-7]+)\s*$/m.exec(fdinfo);
  if (!match) return null;
  const flags = parseInt(match[1], 8);
  return Number.isSafeInteger(flags) ? flags : null;
}
const accessOf = flags => ({0: 'read-only', 1: 'write', 2: 'write'})[flags & O_ACCMODE] ?? 'unknown';

const defaultIo = {readdirSync: fs.readdirSync, readlinkSync: fs.readlinkSync, readFileSync: fs.readFileSync, realpathSync: fs.realpathSync};
const code = error => error?.code ?? String(error?.message ?? error);

// Resolve a systemd unit to its actual MainPID and cgroup processes. Anything that cannot be resolved
// is returned as state "unknown" for that unit only; it never fails the whole observation.
export function resolveUnitPids(unit, {systemctl = defaultSystemctl, io = defaultIo, cgroupRoot = '/sys/fs/cgroup'} = {}) {
  let props;
  try { props = systemctl(unit); } catch (error) { return {id: unit, state: 'unknown', pids: [], error: `systemctl ${code(error)}`}; }
  if (!props || props.LoadState === 'not-found') return {id: unit, state: 'unknown', pids: [], error: 'unit not found'};
  const pids = new Set();
  const main = Number(props.MainPID);
  if (Number.isSafeInteger(main) && main > 0) pids.add(main);
  const group = props.ControlGroup;
  if (props.ActiveState === 'inactive' && !pids.size && !group) return {id: unit, state: 'resolved', pids: []};
  if (group) {
    try {
      for (const line of String(io.readFileSync(path.join(cgroupRoot, group, 'cgroup.procs'), 'utf8')).split('\n')) {
        if (/^\d+$/.test(line)) pids.add(Number(line));
      }
    } catch (error) {
      if (code(error) !== 'ENOENT') return {id: unit, state: 'unknown', pids: [...pids], error: `cgroup ${code(error)}`};
    }
  }
  return {id: unit, state: 'resolved', pids: [...pids].sort((a, b) => a - b)};
}
function defaultSystemctl(unit) {
  const r = spawnSync('systemctl', ['show', unit, '-p', 'LoadState,ActiveState,MainPID,ControlGroup'], {encoding: 'utf8', timeout: 10_000});
  if (r.status !== 0) throw Object.assign(new Error(r.stderr || 'systemctl failed'), {code: `exit${r.status}`});
  return Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

/**
 * observeGrowthWriters({roots, pids?, units?, procRoot?, bounds?, io?, resolveUnit?})
 * Returns {complete, references, errors, units, observedPids, scannedPids, bounds, observedAtMs} where each reference is
 * {pid, root, kind: 'fd'|'cwd'|'exe'|'cmdline', access: 'write'|'read-only'|'unknown', path, fd?, startIdentity}.
 * With pids omitted every numeric /proc entry is scanned. With pids given only those are scanned (integration API for
 * callers that already know the candidates); units are resolved to their actual processes and added to the scan.
 */
export function observeGrowthWriters({roots, pids, units = [], procRoot = '/proc', bounds = {}, io = defaultIo, resolveUnit = resolveUnitPids, now = Date.now} = {}) {
  const limit = {...DEFAULT_BOUNDS, ...bounds};
  const errors = [];
  const references = [];
  const addError = message => { if (errors.length < limit.maxErrors) errors.push(message); else if (errors.length === limit.maxErrors) errors.push('further errors truncated'); };
  const normalized = normalizeRoots(roots ?? [], io);
  if (!normalized.length) return {complete: false, references, errors: ['no growth roots supplied'], units: [], observedPids: [], scannedPids: 0, bounds: limit, observedAtMs: now()};
  const unitResults = [];
  const candidates = new Set();
  if (pids === undefined) {
    try { for (const name of io.readdirSync(procRoot)) if (/^\d+$/.test(name)) candidates.add(Number(name)); }
    catch (error) { addError(`cannot list ${procRoot}: ${code(error)}`); }
  } else for (const pid of pids) candidates.add(Number(pid));
  for (const unit of units) {
    const result = resolveUnit(unit);
    unitResults.push(result);
    if (result.state !== 'resolved') addError(`unit ${result.id ?? unit} unknown: ${result.error ?? 'unresolved'}`);
    for (const pid of result.pids ?? []) candidates.add(pid);
  }
  if (candidates.size > limit.maxPids) addError(`process bound exceeded: ${candidates.size} > ${limit.maxPids}`);
  const scanned = [...candidates].sort((a, b) => a - b).slice(0, limit.maxPids);
  const identityOf = pid => { try { return parseStartIdentity(String(io.readFileSync(`${procRoot}/${pid}/stat`, 'utf8'))); } catch (error) { return error; } };
  const add = ref => { if (references.length < limit.maxReferences) references.push(ref); else if (!references.truncated) { references.truncated = true; addError('reference bound exceeded'); } };
  for (const pid of scanned) {
    if (!Number.isSafeInteger(pid) || pid <= 0) { addError(`invalid pid ${pid}`); continue; }
    const before = identityOf(pid);
    if (before instanceof Error) { if (code(before) !== 'ENOENT' && code(before) !== 'ESRCH') addError(`pid ${pid} identity ${code(before)}`); continue; }
    if (before === null) { addError(`pid ${pid} identity unparseable`); continue; }
    const mine = [];
    let fdNames = [];
    let listed = true;
    try { fdNames = io.readdirSync(`${procRoot}/${pid}/fd`); }
    catch (error) {
      listed = false;
      if (code(error) !== 'ENOENT' && code(error) !== 'ESRCH') addError(`pid ${pid} fd list ${code(error)}`);
      else continue;
    }
    if (fdNames.length > limit.maxFdsPerPid) { addError(`pid ${pid} fd bound exceeded: ${fdNames.length}`); fdNames = fdNames.slice(0, limit.maxFdsPerPid); }
    for (const fd of fdNames) {
      let target;
      try { target = io.readlinkSync(`${procRoot}/${pid}/fd/${fd}`); }
      catch (error) { if (code(error) !== 'ENOENT') addError(`pid ${pid} fd ${fd} link ${code(error)}`); continue; }
      const root = matchRoot(target, normalized);
      if (!root) continue;
      let access = 'unknown';
      try {
        const flags = parseFdFlags(String(io.readFileSync(`${procRoot}/${pid}/fdinfo/${fd}`, 'utf8')));
        if (flags === null) addError(`pid ${pid} fd ${fd} flags malformed`); else access = accessOf(flags);
      } catch (error) { if (code(error) === 'ENOENT') continue; addError(`pid ${pid} fd ${fd} flags ${code(error)}`); }
      mine.push({pid, root, kind: 'fd', access, path: stripDeleted(target), fd: Number(fd), startIdentity: before});
    }
    for (const kind of ['cwd', 'exe']) {
      try {
        const target = io.readlinkSync(`${procRoot}/${pid}/${kind}`);
        const root = matchRoot(target, normalized);
        if (root) mine.push({pid, root, kind, access: 'read-only', path: stripDeleted(target), startIdentity: before});
      } catch (error) { if (code(error) !== 'ENOENT' && !listed) addError(`pid ${pid} ${kind} ${code(error)}`); }
    }
    try {
      const argv = String(io.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      for (const arg of argv) { const root = matchRoot(arg, normalized); if (root) { mine.push({pid, root, kind: 'cmdline', access: 'read-only', path: arg.slice(0, 512), startIdentity: before}); break; } }
    } catch { /* cmdline is advisory; descriptors decide writing */ }
    const after = identityOf(pid);
    if (after instanceof Error) {
      if (code(after) === 'ENOENT' || code(after) === 'ESRCH') { for (const ref of mine) add({...ref, exited: true}); continue; }
      addError(`pid ${pid} identity after scan ${code(after)}`);
    } else if (after !== before) {
      addError(`pid ${pid} identity changed during observation (${before} -> ${after})`);
      for (const ref of mine) add({...ref, access: 'unknown'});
      continue;
    }
    for (const ref of mine) add(ref);
  }
  return {complete: errors.length === 0, references: [...references], errors, units: unitResults, observedPids: scanned, scannedPids: scanned.length, bounds: limit, observedAtMs: now()};
}
