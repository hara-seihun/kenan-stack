// Process-wide ESM identities for immutable releases. Register before importing application code.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks, type ModuleHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Module = { path: string; url: string; source: string; dependencies: Set<string> };
type Generation = { root: string; dependenciesKey: string; modules: Map<string, Module>; urls: Map<string, string> };
type Parent = { generation: Generation; module: Module };
type Registry = {
  generations: Map<string, Generation>;
  identities: Map<string, string>;
  parents: Map<string, Parent>;
  entries: Set<string>;
  hooks?: ModuleHooks;
  resolver?: typeof registry;
};
const registryKey = Symbol.for('kenan.live-modules');
const processState = globalThis as typeof globalThis & { [registryKey]?: Registry };
const entry = 'server/live-generation.js';
const localPath = (path: string) => !!path && !path.startsWith('../') && !path.startsWith('/') && !/^(web|bench)\//.test(path);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function registry(): Registry {
  const state: Registry = processState[registryKey] ??= { generations: new Map(), identities: new Map(), parents: new Map(), entries: new Set() };
  if (state.resolver === registry) return state;
  state.hooks?.deregister();
  state.hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // Bootstrap and importLiveGeneration explicitly import this registered URL;
      // this is not an edge from the bootstrap's original application graph.
      if (state.entries.has(specifier)) return { url: specifier, shortCircuit: true };
      const parent = context.parentURL && state.parents.get(context.parentURL);
      if (!parent) return nextResolve(specifier, context);
      // The canonical parent's original release, never the most recently registered one,
      // owns both late dynamic imports and npm resolution.
      const { generation, module } = parent;
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
        const target = new URL(specifier, module.url);
        if (target.protocol === 'file:') {
          const path = relative(join(generation.root, 'dist'), fileURLToPath(target));
          if (localPath(path)) {
            if (target.search || target.hash) throw new Error(`live_modules_local_url_suffix: ${specifier}`);
            if (!module.dependencies.has(path)) {
              throw new Error(`live_modules_untracked_import: ${module.path} -> ${specifier}; use a literal import`);
            }
            const url = generation.urls.get(path);
            if (!url) throw new Error(`live_modules_missing_module: ${path}`);
            return { url, shortCircuit: true };
          }
        }
      }
      return nextResolve(specifier, { ...context, parentURL: module.url });
    },
  });
  state.resolver = registry;
  return state;
}

type Token = { kind: 'word' | 'string' | 'template' | 'punct'; text: string };

// A small lexer, not a JavaScript parser: imports are recognized only outside comments,
// strings, template text and regexes. Template expressions are scanned as code too.
function tokens(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  let expressionStart = true;
  const controlParens: boolean[] = [];
  const push = (kind: Token['kind'], text: string) => {
    result.push({ kind, text });
    expressionStart = kind === 'word'
      ? /^(return|throw|case|delete|void|typeof|yield|await|in|of|else|do)$/.test(text)
      : kind === 'punct' && !/^(\)|\]|\}|\+\+|--|\.)$/.test(text);
  };
  function string(quote: string): string {
    i++;
    let text = '';
    while (i < source.length) {
      const c = source[i++]!;
      if (c === quote) return text;
      if (c !== '\\') { text += c; continue; }
      const escape = source[i++]!;
      if (escape === '\n') continue;
      if (escape === '\r') { if (source[i] === '\n') i++; continue; }
      if (escape === 'u' || escape === 'x') {
        if (escape === 'u' && source[i] === '{') {
          const end = source.indexOf('}', ++i);
          text += String.fromCodePoint(parseInt(source.slice(i, end), 16));
          i = end + 1;
        } else {
          const length = escape === 'u' ? 4 : 2;
          text += String.fromCharCode(parseInt(source.slice(i, i + length), 16));
          i += length;
        }
      } else {
        text += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[escape] ?? escape;
      }
    }
    throw new Error('live_modules_unterminated_string');
  }
  function code(templateExpression = false): void {
    let braces = 0;
    while (i < source.length) {
      const c = source[i]!;
      if (/\s/.test(c)) { i++; continue; }
      if (source.startsWith('//', i) || (i === 0 && source.startsWith('#!', i))) {
        const end = source.indexOf('\n', i);
        i = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) throw new Error('live_modules_unterminated_comment');
        i = end + 2;
        continue;
      }
      if (c === '"' || c === "'") { push('string', string(c)); continue; }
      if (c === '`') {
        i++;
        let text = '';
        const start = result.length;
        push('template', '');
        while (i < source.length) {
          const t = source[i++]!;
          if (t === '`') break;
          if (t === '\\') { text += t + source[i++]; continue; }
          if (t === '$' && source[i] === '{') {
            i++;
            result[start]!.text = text;
            expressionStart = true;
            code(true);
          } else text += t;
        }
        result[start]!.text = text;
        expressionStart = false;
        continue;
      }
      if (c === '/' && expressionStart) {
        i++;
        let bracket = false;
        while (i < source.length) {
          const r = source[i++]!;
          if (r === '\\') { i++; continue; }
          if (r === '[') bracket = true;
          if (r === ']') bracket = false;
          if (r === '/' && !bracket) break;
        }
        while (/[a-z]/i.test(source[i] ?? '')) i++;
        push('string', '');
        continue;
      }
      if (/[\w$]/.test(c)) {
        const start = i++;
        while (/[\w$]/.test(source[i] ?? '')) i++;
        push('word', source.slice(start, i));
        continue;
      }
      i++;
      if (c === '}' && templateExpression && braces === 0) return;
      if (c === '{') braces++;
      if (c === '}') braces--;
      // A regex may begin a statement immediately after `if (...)`, whereas
      // a slash after a function call is division.
      if (c === '(') controlParens.push(/^(if|while|for|with|switch|catch)$/.test(result.at(-1)?.text ?? ''));
      const afterControl = c === ')' && controlParens.pop();
      if ((c === '+' || c === '-') && source[i] === c) { i++; push('punct', c + c); }
      else push('punct', c);
      if (afterControl) expressionStart = true;
    }
  }
  code();
  return result;
}

function imports(source: string, path: string): string[] {
  const ts = tokens(source);
  const found: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i]!;
    if (token.kind !== 'word' || !/^(import|export)$/.test(token.text) || ts[i - 1]?.text === '.') continue;
    const next = ts[i + 1];
    if (token.text === 'import' && next?.text === '.') continue; // import.meta
    if (token.text === 'import' && next?.text === '(') {
      const argument = ts[i + 2];
      if (argument?.kind === 'string' && /^(\)|,)$/.test(ts[i + 3]?.text ?? '')) {
        found.push(argument.text);
      } else {
        // Computed external imports remain external. Local computed imports must
        // be covered by a literal import.meta directory resource below.
        let depth = 1;
        for (let j = i + 2; j < ts.length && depth; j++) {
          const t = ts[j]!;
          if (t.text === '(') depth++;
          if (t.text === ')') depth--;
          if ((t.kind === 'string' || t.kind === 'template') && /^\.{1,2}\//.test(t.text)) {
            throw new Error(`live_modules_computed_relative_import: ${path}; use a literal import`);
          }
        }
      }
      continue;
    }
    if (token.text === 'import' && next?.kind === 'string') { found.push(next.text); continue; }
    // Emitted imports and export-from declarations end in `from "specifier"`.
    if (next?.text !== '{' && next?.text !== '*' && token.text === 'export') continue;
    for (let j = i + 1; j < ts.length; j++) {
      const t = ts[j]!;
      if (t.text === ';' || t.text === '=') break;
      if (t.kind === 'word' && t.text === 'from' && ts[j + 1]?.kind === 'string') {
        found.push(ts[j + 1]!.text);
        break;
      }
    }
  }
  return found;
}

function readGeneration(root: string): Generation {
  const modules = new Map<string, Module>();
  function walk(directory: string): void {
    for (const file of readdirSync(join(root, 'dist', directory), { withFileTypes: true })) {
      const path = `${directory}/${file.name}`;
      if (file.isDirectory()) walk(path);
      else if (file.isFile() && !file.name.endsWith('.map') && !/\.test\.[cm]?js$/.test(file.name)) {
        const url = pathToFileURL(join(root, 'dist', path)).href;
        modules.set(path, { path, url, source: readFileSync(fileURLToPath(url), file.name.endsWith('.js') ? 'utf8' : 'latin1'), dependencies: new Set() });
      }
    }
  }
  for (const item of readdirSync(join(root, 'dist'), { withFileTypes: true })) {
    if (item.isDirectory() && !['web', 'bench'].includes(item.name)) walk(item.name);
  }
  if (!modules.has(entry)) throw new Error(`live_modules_missing_entry: ${root}/dist/${entry}`);
  for (const module of modules.values()) {
    if (!module.path.endsWith('.js')) continue;
    for (const specifier of imports(module.source, module.path)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) continue;
      const target = new URL(specifier, module.url);
      if (target.protocol !== 'file:') continue;
      const path = relative(join(root, 'dist'), fileURLToPath(target));
      if (!localPath(path)) continue;
      if (target.search || target.hash) throw new Error(`live_modules_local_url_suffix: ${module.path} -> ${specifier}`);
      if (!modules.has(path)) throw new Error(`live_modules_missing_module: ${module.path} -> ${specifier}`);
      module.dependencies.add(path);
    }
    // Literal import.meta resources change their reader's identity too. Directory resources
    // declare all descendants, including entries discovered by optional-module loaders.
    const parts = tokens(module.source);
    for (let i = 0; i < parts.length - 2; i++) {
      if (parts[i]?.text !== 'new' || parts[i + 1]?.text !== 'URL' || parts[i + 2]?.text !== '(') continue;
      let depth = 1;
      const values: string[] = [];
      let local = false;
      for (let j = i + 3; j < parts.length && depth; j++) {
        const part = parts[j]!;
        if (part.text === '(') depth++;
        if (part.text === ')') depth--;
        if (part.kind === 'string' && part.text.startsWith('.')) values.push(part.text);
        if (part.text === 'import' && parts.slice(j + 1, j + 5).map(t => t.text).join('') === '.meta.url') local = true;
      }
      if (local) for (const specifier of values) {
        const path = relative(join(root, 'dist'), fileURLToPath(new URL(specifier, module.url)));
        if (modules.has(path)) module.dependencies.add(path);
        else {
          const prefix = path.replace(/\/$/, '') + '/';
          for (const child of modules.keys()) if (child.startsWith(prefix)) module.dependencies.add(child);
        }
      }
    }
  }
  return { root, dependenciesKey: hash(JSON.stringify([readFileSync(join(root, 'package-lock.json'), 'utf8'), existsSync(join(root, 'node_modules/.kenan-deps-key')) ? readFileSync(join(root, 'node_modules/.kenan-deps-key'), 'utf8') : ''])), modules, urls: new Map() };
}

// Tarjan components make a cycle one identity. Component keys include outgoing
// component identities, so a changed leaf invalidates every transitive importer.
function identities(generation: Generation): Map<string, string> {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const active = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const componentFor = new Map<string, number>();
  function visit(path: string): void {
    indices.set(path, index);
    low.set(path, index++);
    stack.push(path);
    active.add(path);
    for (const child of generation.modules.get(path)!.dependencies) {
      if (!indices.has(child)) { visit(child); low.set(path, Math.min(low.get(path)!, low.get(child)!)); }
      else if (active.has(child)) low.set(path, Math.min(low.get(path)!, indices.get(child)!));
    }
    if (low.get(path) !== indices.get(path)) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      members.push(member);
      componentFor.set(member, components.length);
    } while (member !== path);
    components.push(members.sort());
  }
  for (const path of [...generation.modules.keys()].sort()) if (!indices.has(path)) visit(path);
  const keys = new Map<number, string>();
  function key(component: number): string {
    const cached = keys.get(component);
    if (cached) return cached;
    const members = components[component]!.map(path => {
      const module = generation.modules.get(path)!;
      const edges = [...module.dependencies].sort().map(child => {
        const target = componentFor.get(child)!;
        return [child, target === component ? 'self' : key(target)];
      });
      return [path, hash(module.source), edges];
    });
    const value = hash(JSON.stringify([generation.dependenciesKey, members]));
    keys.set(component, value);
    return value;
  }
  return new Map([...generation.modules.keys()].map(path => [path, `${path}:${key(componentFor.get(path)!)}`]));
}

/** Register an immutable release before its first application import; returns its canonical entry URL. */
export function registerLiveModules(releaseRoot: string): string {
  const state = registry();
  const root = realpathSync(releaseRoot);
  const registered = state.generations.get(root);
  if (registered) return registered.urls.get(entry)!;
  const generation = readGeneration(root);
  const keys = identities(generation);
  for (const [path, module] of generation.modules) {
    const identity = keys.get(path)!;
    const canonical = state.identities.get(identity) ?? module.url;
    generation.urls.set(path, canonical);
  }
  // Publish only after the whole graph has been read successfully. Canonical URL
  // owners never change: old imports must keep resolving against their own graph.
  for (const [path, module] of generation.modules) {
    const canonical = generation.urls.get(path)!;
    state.identities.set(keys.get(path)!, canonical);
    if (!state.parents.has(canonical)) state.parents.set(canonical, { generation, module });
  }
  state.generations.set(root, generation);
  state.entries.add(generation.urls.get(entry)!);
  return generation.urls.get(entry)!;
}

/** Import a new runtime in this Node process, sharing graph-identical module instances. */
export async function importLiveGeneration<T>(releaseRoot: string): Promise<T> {
  return await import(registerLiveModules(releaseRoot)) as T;
}
