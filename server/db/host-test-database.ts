import { existsSync } from 'node:fs';

/** Kenan hosts run kenan-postgres with a throwaway kenan_test database: the URL of it here, or null on a host without one. */
export const hostTestDatabaseUrl = (): string | null =>
  existsSync('/run/kenan/pg/.s.PGSQL.5432') ? `postgresql:///kenan_test?host=/run/kenan/pg&user=${process.env.USER}` : null;
