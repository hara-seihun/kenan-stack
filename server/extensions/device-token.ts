import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import type { DeviceToken, PersonConfig } from '../config.js';

/** The person and device a bearer token belongs to among `devicesOf` each person, or null. Every configured hash is compared, in constant time. */
export function deviceFor(people: readonly PersonConfig[], authorization: string | undefined, devicesOf: (person: PersonConfig) => readonly DeviceToken[] | undefined): { person: PersonConfig; device: DeviceToken } | null {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
  if (!token) return null;
  const digest = createHash('sha256').update(token).digest();
  let found: { person: PersonConfig; device: DeviceToken } | null = null;
  for (const person of people) for (const device of devicesOf(person) ?? []) {
    if (timingSafeEqual(digest, Buffer.from(device.tokenSha256, 'hex'))) found = { person, device };
  }
  return found;
}

/** Writes a file the person owns (0600), fsynced, replacing any earlier one atomically. */
export async function writeOwned(person: Pick<PersonConfig, 'uid' | 'gid'>, path: string, data: string | Buffer) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(data); await handle.sync(); await handle.chown(person.uid, person.gid); } finally { await handle.close(); }
  await rename(temp, path);
}
