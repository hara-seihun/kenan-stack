import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { preactAliases } from './build/preact.js';
import { hostTestDatabaseUrl } from './server/db/host-test-database.js';

// Kenan hosts run kenan-postgres with a throwaway kenan_test database; use it so database suites run instead of skipping.
const hostTestDatabase = hostTestDatabaseUrl();
const suites = ['server/**/*.test.ts', 'web/**/*.test.ts', 'modules/**/*.test.ts', 'deploy/**/*.test.ts'];
const timing = suites.map(glob => glob.replace('*.test.ts', '*.timing.test.ts'));

// The app's `import { X } from 'lucide-react'` becomes one import per icon file, as the build's tree shaking leaves it:
// through the barrel, every suite that imports App transformed all 4,282 icon modules (web/classic.test.ts: 0.4 s → 10–19 s,
// past its 15 s timeout on a loaded host). A name lucide does not export is an error here, as it is in the build.
const lucideEsm = join(dirname(createRequire(import.meta.url).resolve('lucide-react/package.json')), 'dist/esm');
const lucideFiles = new Map([...readFileSync(join(lucideEsm, 'lucide-react.mjs'), 'utf8').matchAll(/^export \{ (.+) \} from '\.\/(icons\/[^']+)';$/gm)]
  .flatMap(([, names, file]) => names!.split(', ').map(name => [name.replace('default as ', ''), join(lucideEsm, file!)] as const)));
const lucidePerIcon: Plugin = {
  name: 'lucide-per-icon', enforce: 'pre',
  transform(code, id) {
    if (id.includes('/node_modules/') || !code.includes("from 'lucide-react'")) return null;
    return code.replace(/import \{([^}]+)\} from 'lucide-react';/g, (_, names: string) => names.split(',').map(n => n.trim()).filter(Boolean).map(entry => {
      const [name, local = name] = entry.split(/\s+as\s+/) as [string, string?];
      const file = lucideFiles.get(name);
      if (!file) this.error(`lucide-react exports no icon ${name} (imported in ${id})`);
      return `import ${local} from ${JSON.stringify(file)};`;
    }).join(' '));
  },
};

// Files run serially so another suite's imports and work do not contend with a wall-clock assertion.
// Timing checks use their own Postgres so other application traffic cannot change their database load.
// Positive group orders are intentional: Vitest 5 moves isolated maxWorkers:1 projects at order 0 to the end.
export default defineConfig({ plugins: [lucidePerIcon], resolve: { alias: [...preactAliases, { find: /^lucide-react$/, replacement: 'lucide-react/dist/esm/lucide-react.mjs' }] }, test: {
  // lucide-react's CommonJS main requires real React; its ESM build, inlined, goes through the Preact aliases like the app build.
  server: { deps: { inline: ['lucide-react'] } },
  testTimeout: 15000, env: process.env.KENAN_TEST_DATABASE_URL || !hostTestDatabase ? {} : { KENAN_TEST_DATABASE_URL: hostTestDatabase },
  projects: [
    { extends: true, test: { name: 'suites', include: suites, exclude: [...configDefaults.exclude, ...timing], maxWorkers: 1, globalSetup: ['./server/db/test-schemas.setup.ts'], sequence: { groupOrder: 1 } } },
    { extends: true, test: { name: 'timing', include: timing, maxWorkers: 1, globalSetup: ['./server/db/timing-database.setup.ts'], sequence: { groupOrder: 2 } } },
  ],
} });
