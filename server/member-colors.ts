import { MEMBER_COLORS } from '../shared/colors.js';
import { fail } from './db/errors.js';

/** A reader's patch of message colours: person id → a preset (its #rrggbb or its name, any case), or null to clear. */
export function parseMemberColors(v: unknown): Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('invalid_input', 'memberColors must be an object of person id to colour');
  return Object.fromEntries(Object.entries(v).map(([id, color]) => {
    if (!id || id.length > 64) fail('invalid_input', 'memberColors names a person by id');
    if (color === null) return [id, null];
    const preset = typeof color === 'string' ? MEMBER_COLORS.find(([hex, name]) => hex === color.toLowerCase() || name.toLowerCase() === color.toLowerCase()) : undefined;
    return [id, preset?.[0] ?? fail('invalid_input', `${id}: ${String(color)} is not one of the message colours (${MEMBER_COLORS.map(([, n]) => n).join(', ')})`)];
  }));
}
