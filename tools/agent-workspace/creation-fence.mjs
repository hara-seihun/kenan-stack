import {spawnSync} from 'node:child_process';

// This is a scheduler/exec budget, not a lock wait: flock remains nonblocking.
// One second incorrectly treated ordinary process startup delays as unknown
// capacity. Keep a finite budget and never interpret failed execution as free.
export const CREATION_FENCE_PROBE_MS = 10_000;
export function probeCreationFence(descriptor, {run = spawnSync} = {}) {
  const result = run('flock', ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', descriptor],
    timeout: CREATION_FENCE_PROBE_MS, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  if (!result.error && !result.signal) {
    if (result.status === 0) return false;
    if (result.status === 1) return true;
  }
  const detail = result.error?.code === 'ETIMEDOUT'
    ? `probe deadline exhausted after ${CREATION_FENCE_PROBE_MS} ms`
    : `probe failed (error=${result.error?.code ?? 'none'}, status=${result.status ?? 'none'}, signal=${result.signal ?? 'none'})`;
  const stderr = String(result.stderr ?? '').trim().slice(0, 512);
  throw new Error(`capacity estimate unknown: cannot inspect pending creation fence: ${detail}${stderr ? `: ${stderr}` : ''}`);
}
