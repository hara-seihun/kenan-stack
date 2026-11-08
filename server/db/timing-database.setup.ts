import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

// Start this in Vitest's process, not through the host's shared database service: the
// server inherits the benchmark's CPU affinity. Keep data off the RAM-backed /tmp.
export default function setup(project: Pick<TestProject, 'config'>): () => void {
  let bin: string;
  try {
    bin = process.env.TEST_POSTGRES_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (!bin) throw new Error('pg_config returned an empty binary directory');
    for (const name of ['initdb', 'pg_ctl']) {
      execFileSync(join(bin, name), ['--version'], { stdio: 'pipe' });
    }
  } catch (error) {
    throw new Error('Timing tests need local PostgreSQL initdb and pg_ctl; install them or set TEST_POSTGRES_BIN to their directory', { cause: error });
  }

  const dir = mkdtempSync('/var/tmp/kenan-timing-pg-');
  const data = join(dir, 'data');
  const ctl = join(bin, 'pg_ctl');
  const priorUrl = project.config.env.KENAN_TEST_DATABASE_URL;
  const cleanup = () => {
    // Even a failed start can leave a server behind; never delete its data while it runs.
    if (existsSync(join(data, 'postmaster.pid'))) {
      execFileSync(ctl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    }
    rmSync(dir, { recursive: true, force: true });
    if (priorUrl === undefined) delete project.config.env.KENAN_TEST_DATABASE_URL;
    else project.config.env.KENAN_TEST_DATABASE_URL = priorUrl;
  };
  try {
    execFileSync(join(bin, 'initdb'), ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust'], { stdio: 'pipe' });
    execFileSync(ctl, ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-c listen_addresses='' -c unix_socket_directories=${dir} -c shared_buffers=32MB`, '-w', 'start'], { stdio: 'pipe' });
    const url = new URL('postgresql://localhost/postgres');
    url.searchParams.set('host', dir);
    url.searchParams.set('user', userInfo().username);
    project.config.env.KENAN_TEST_DATABASE_URL = url.toString();
    return cleanup;
  } catch (error) {
    try { cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Could not start or clean up timing PostgreSQL at ${dir}`);
    }
    throw new Error('Could not start private PostgreSQL for timing tests', { cause: error });
  }
}
