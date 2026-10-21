// Bound each history-size query independently of total history length. All
// objects remain charged; batching is not a sampling or truncation allowance.
export const HISTORY_SIZE_BATCH = 4096;
export function commandFailureDetail(result) {
 const reason = [result.error?.code, result.error?.message, `status=${result.status ?? 'unknown'}`, result.signal ? `signal=${result.signal}` : null].filter(Boolean).join(' ');
 const diagnostic = String(result.stderr || '').slice(0, 1024);
 // stdout may be a huge partial machine protocol; never turn it into an error.
 return `${reason}${diagnostic ? `: ${diagnostic}` : ''} (stdoutBytes=${Buffer.byteLength(result.stdout || '')})`;
}
export function historyImportBytes(objects, inspect) {
 const ids = objects.trim() ? objects.trim().split('\n') : [];
 if (ids.some(id => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id))) throw Error('source capacity estimate unknown: invalid history object identity');
 let bytes = 16 * 1024 ** 2;
 for (let at = 0; at < ids.length; at += HISTORY_SIZE_BATCH) {
  const batch = ids.slice(at, at + HISTORY_SIZE_BATCH);
  const result = inspect(batch.join('\n') + '\n');
  if (result.status !== 0 || result.error || result.signal) throw Error(`source history size query failed batch=${at / HISTORY_SIZE_BATCH} objects=${batch.length}: ${commandFailureDetail(result)}`);
  const sizes = result.stdout.trim().split('\n');
  if (sizes.length !== batch.length || sizes.some(size => !/^\d+$/u.test(size) || !Number.isSafeInteger(Number(size)))) throw Error('source capacity estimate unknown: incomplete or invalid history size response');
  for (const size of sizes) bytes += 2 * (Number(size) + Math.ceil(Number(size) / 1000) + 128);
  if (!Number.isSafeInteger(bytes)) throw Error('source history capacity exceeds supported byte range');
 }
 return bytes;
}
