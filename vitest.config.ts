import { existsSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';
import { preactAliases } from './build/preact.js';

// Kenan hosts run kenan-postgres with a throwaway kenan_test database; use it so database suites run instead of skipping.
const hostTestDatabase = existsSync('/run/kenan/pg/.s.PGSQL.5432') ? { KENAN_TEST_DATABASE_URL: `postgresql:///kenan_test?host=/run/kenan/pg&user=${process.env.USER}` } : {};
const suites = ['server/**/*.test.ts', 'web/**/*.test.ts', 'deploy/**/*.test.ts'];
const timing = suites.map(glob => glob.replace('*.test.ts', '*.timing.test.ts'));

// Wall-clock bounds (*.timing.test.ts) form a second group that starts only after every other suite has finished,
// and runs one file at a time, so parallel suites never compete with them for CPU.
export default defineConfig({ resolve: { alias: preactAliases }, test: {
  testTimeout: 15000, env: process.env.KENAN_TEST_DATABASE_URL ? {} : hostTestDatabase,
  projects: [
    { extends: true, test: { name: 'suites', include: suites, exclude: [...configDefaults.exclude, ...timing], maxWorkers: 4, sequence: { groupOrder: 0 } } },
    { extends: true, test: { name: 'timing', include: timing, maxWorkers: 1, sequence: { groupOrder: 1 } } },
  ],
} });
