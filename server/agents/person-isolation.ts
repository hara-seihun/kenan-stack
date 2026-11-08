import type { PersonConfig } from '../config.js';

/** Isolation is symmetric: neither side may cross this boundary, even if only one side opted into it. */
export function ownersVisible(person: Pick<PersonConfig, 'id' | 'isolated'>, other: Pick<PersonConfig, 'id' | 'isolated'> | undefined, ownerId: string): boolean {
  return person.id === ownerId || (!person.isolated && !other?.isolated);
}
const PRIVATE_TOOLS = new Set(['browser', 'send', 'peer', 'mail', 'signal', 'discord', 'inbox', 'channels', 'voice', 'phone', 'phone_settings', 'notify', 'meeting']);
export const personToolAllowed = (person: Pick<PersonConfig, 'isolated'>, name: string): boolean => !person.isolated || !PRIVATE_TOOLS.has(name);
