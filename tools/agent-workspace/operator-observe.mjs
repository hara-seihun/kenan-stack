#!/usr/bin/env node
// Root read-only observer for household operators. tools/agent-workspace/deploy lets the
// operator group run exactly this file through sudo. It runs one of the existing root
// observers, and only for paths the invoking user owns: a path (or, while it does not
// exist yet, its nearest existing ancestor) must be its own real path, not a symlink,
// and owned by SUDO_UID. Anything else is refused before any observation.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const exactPath = value => typeof value === 'string' && path.isAbsolute(value) && value !== '/' && path.normalize(value) === value;
const roots = text => {
  let value;
  try { value = JSON.parse(text); } catch { throw new Refusal('roots must be a JSON array of absolute paths'); }
  if (!Array.isArray(value) || !value.length || value.length > 4096 || !value.every(exactPath)) throw new Refusal('roots must be a JSON array of absolute paths');
  return value;
};
const pathFlags = args => {
  if (!args.length || args.length % 2 || args.length > 130) throw new Refusal('expected --path PATH pairs');
  const paths = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== '--path' || !exactPath(args[index + 1])) throw new Refusal('expected --path PATH pairs');
    paths.push(args[index + 1]);
  }
  return paths;
};

// module -> first argument -> the paths that argument list asks about.
export const OBSERVATIONS = Object.freeze({
  'workspace.mjs': {
    'growth-process-snapshot': args => pathFlags(args),
    'materialization-process-snapshot': args => pathFlags(args),
  },
  'capacity-owner-forecast.mjs': {
    '--processes': args => {
      if (args.length !== 2 || !/^\d{1,16}$/.test(args[1])) throw new Refusal('expected ROOTS_JSON DEADLINE_MS');
      return roots(args[0]);
    },
  },
  'qualification-references.mjs': {
    '--census': args => {
      if (args.length !== 1) throw new Refusal('expected ROOTS_JSON');
      return roots(args[0]);
    },
  },
});

export class Refusal extends Error {}

export function callerUid(env = process.env) {
  if (!/^[1-9]\d{0,9}$/.test(env.SUDO_UID ?? '')) throw new Refusal('run through sudo by an ordinary user');
  return Number(env.SUDO_UID);
}

export function assertOwned(target, uid, {lstat = fs.lstatSync, realpath = fs.realpathSync} = {}) {
  for (let candidate = target; ; candidate = path.dirname(candidate)) {
    let stat;
    try { stat = lstat(candidate); } catch (error) {
      if (error.code !== 'ENOENT' || candidate === '/') throw new Refusal(`${target}: ${error.message}`);
      continue;
    }
    if (candidate === '/' || stat.isSymbolicLink() || realpath(candidate) !== candidate || stat.uid !== uid)
      throw new Refusal(`${target} is not a path its caller owns`);
    return;
  }
}

export function authorize(argv, uid, options = {}) {
  const [module, observation, ...args] = argv;
  const select = Object.hasOwn(OBSERVATIONS, module ?? '') && Object.hasOwn(OBSERVATIONS[module], observation ?? '') ? OBSERVATIONS[module][observation] : undefined;
  if (select === undefined) throw new Refusal(`no operator observation ${module} ${observation}`);
  for (const target of select(args)) assertOwned(target, uid, options);
  return [module, observation, ...args];
}

// Node uses "-" for stdin and omits argv[1] for eval; neither is a CLI file.
if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    if (process.getuid() !== 0) throw new Refusal('the operator observer runs as root through sudo');
    const [module, ...args] = authorize(process.argv.slice(2), callerUid());
    const result = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), module), ...args],
      {stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000, killSignal: 'SIGKILL'});
    process.exit(result.status ?? 1);
  } catch (error) {
    process.stderr.write(`operator-observe: ${error instanceof Refusal ? 'refused: ' : ''}${error.message}\n`);
    process.exit(error instanceof Refusal ? 77 : 1);
  }
}
