import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
test('host preparation provisions the throwaway test DB used by the native runner', () => {
  const source = readFileSync(new URL('./prepare.sh', import.meta.url), 'utf8');
  expect(source).toContain("WHERE datname='kenan_test'");
  expect(source).toContain('createdb -h /run/kenan/pg kenan_test');
  expect(source).toContain('GRANT CONNECT, CREATE ON DATABASE kenan_test TO PUBLIC');
  expect(source).not.toContain('ALTER ROLE kenan SUPERUSER');
});
