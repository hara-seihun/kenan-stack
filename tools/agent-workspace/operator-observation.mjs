// Privileged read-only observations for every caller of the installed tools.
// Root observes in process. A member of the release's operator group (household
// operators, who have no general root grant) goes through the installed operator
// observer (operator-observe.mjs), which sudoers admits for that group and which answers
// only for paths the caller owns. Everyone else, including the tools' owner, runs the
// observer module directly through its own root grant, as before.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedCommand} from './bounded-command.mjs';
import {qualificationReferences} from './qualification-references.mjs';

const QUALIFICATION_MODULE = new URL('./qualification-references.mjs', import.meta.url);

export class ObserverUnavailable extends Error {
  constructor(message) { super(message); this.code = 'operator-observer-unavailable'; }
}

// {kind:'root'} | {kind:'direct'} | {kind:'operator', node, entry}.
export function observerRoute(moduleUrl, {uid = process.getuid(), groups = process.getgroups(), stat = fs.statSync, read = fs.readFileSync} = {}) {
  if (uid === 0) return {kind: 'root'};
  const modulePath = fileURLToPath(moduleUrl);
  if (stat(modulePath).uid === uid) return {kind: 'direct'};
  let receipt;
  try { receipt = JSON.parse(read(path.join(path.dirname(modulePath), '.component-release.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {kind: 'direct'};
    throw new ObserverUnavailable(`unreadable tools release receipt in ${path.dirname(modulePath)}: ${error.message}`);
  }
  const observer = receipt?.operatorObserver;
  if (observer === undefined) return {kind: 'direct'};
  if (!Number.isSafeInteger(observer?.gid) || typeof observer.node !== 'string' || !path.isAbsolute(observer.node) || typeof observer.entry !== 'string' || !path.isAbsolute(observer.entry))
    throw new ObserverUnavailable(`tools release ${path.dirname(modulePath)} records a malformed operator observer`);
  return groups.includes(observer.gid) ? {kind: 'operator', node: observer.node, entry: observer.entry} : {kind: 'direct'};
}

// The sudo argv that runs MODULE ARGS as root for this caller.
export function privilegedCommand(moduleUrl, args, options = {}) {
  const route = observerRoute(moduleUrl, options);
  const modulePath = fileURLToPath(moduleUrl);
  if (route.kind === 'operator') return ['-n', route.node, route.entry, path.basename(modulePath), ...args];
  return ['-n', process.execPath, modulePath, ...args];
}

// The Converge qualification census. Its records live in the tools owner's private
// data; an operator receives only the part that concerns roots it owns.
export function stackQualificationReferences(roots, {timeout = 15000, execute = boundedCommand, ...options} = {}) {
  let route;
  try { route = observerRoute(QUALIFICATION_MODULE, options); }
  catch (error) { return unavailable(error.message); }
  if (route.kind !== 'operator') return qualificationReferences(roots);
  if (!Array.isArray(roots) || !roots.length) return unavailable('exact absolute reference roots required');
  const result = execute('sudo', privilegedCommand(QUALIFICATION_MODULE, ['--census', JSON.stringify(roots)], options),
    {encoding: 'utf8', timeout, maxBuffer: 32 << 20});
  if (result.status !== 0 || result.error)
    return unavailable(`operator qualification census failed: ${String(result.error?.code ?? result.stderr ?? result.status).trim().slice(0, 1000)}`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { return unavailable('operator qualification census returned invalid JSON'); }
  if (!value || typeof value.complete !== 'boolean' || !['errors', 'references', 'released', 'observations'].every(key => Array.isArray(value[key])))
    return unavailable('operator qualification census returned a malformed result');
  return value;
}

const unavailable = message => ({errors: [message], references: [], released: [], observations: [], complete: false, observedAt: Date.now()});
