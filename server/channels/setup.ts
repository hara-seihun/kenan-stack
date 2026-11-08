// What a person's channels are set to: the watcher (guide and model) and a mode for every platform they have. Pure, so
// the config loader checks a channel config's people[].channels before a deploy, with the same rules the server runs on.
import type { PersonConfig } from '../config.js';
import { MODES, PLATFORM_MODES, PLATFORMS, type Mode, type Parsed, type Platform } from './address.js';

/** The watcher that judges filtered channels: its guide (who the person is, what to pass on) and its model. */
export interface FilterConfig { guidePath: string; model: string }
export interface ChannelsConfig { filter: FilterConfig; modes: Partial<Record<Platform, Mode>> }

export const CHANNELS_SHAPE = 'channels must be {"filter": {"guidePath": FILE, "model": MODEL}, "modes": {PLATFORM: MODE, …}}';

/** Platforms a person has: Kenan chats always; the others with their extension (and Signal with a linked store). */
export function platformsOf(person: Pick<PersonConfig, 'extensions' | 'signalStore'>): Platform[] {
  return PLATFORMS.filter(p => p === 'kenan' || (p === 'signal' ? person.extensions.includes('signal') && person.signalStore !== null : person.extensions.includes(p)));
}

export function checkMode(platform: Platform, mode: unknown): Parsed<Mode> {
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return { ok: false, error: `channels_invalid_mode: ${JSON.stringify(mode)} is not one of ${MODES.join(', ')}` };
  if (!PLATFORM_MODES[platform].includes(mode as Mode)) return { ok: false, error: `channels_invalid_mode: ${platform} channels take ${PLATFORM_MODES[platform].join(', ')}` };
  return { ok: true, value: mode as Mode };
}

export function parseChannels(person: Pick<PersonConfig, 'id' | 'extensions' | 'signalStore'>, raw: unknown): Parsed<ChannelsConfig> {
  const bad = (error: string): Parsed<ChannelsConfig> => ({ ok: false, error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`channels_unconfigured: ${CHANNELS_SHAPE}`);
  const { filter, modes, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length) return bad(`channels_invalid: unknown keys ${Object.keys(extra).join(', ')}; ${CHANNELS_SHAPE}`);
  const f = filter as Record<string, unknown> | undefined;
  if (!f || typeof f.guidePath !== 'string' || !f.guidePath || typeof f.model !== 'string' || !f.model || Object.keys(f).length !== 2) return bad(`channels_invalid: filter; ${CHANNELS_SHAPE}`);
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return bad(`channels_invalid: modes; ${CHANNELS_SHAPE}`);
  const have = platformsOf(person), out: Partial<Record<Platform, Mode>> = {};
  for (const [platform, mode] of Object.entries(modes as Record<string, unknown>)) {
    if (!have.includes(platform as Platform)) return bad(`channels_invalid: modes.${platform}: ${person.id} has no such platform (has ${have.join(', ')})`);
    const checked = checkMode(platform as Platform, mode);
    if (!checked.ok) return bad(checked.error);
    out[platform as Platform] = checked.value;
  }
  const missing = have.filter(p => !(p in out));
  if (missing.length) return bad(`channels_invalid: modes needs a mode for ${missing.join(', ')}`);
  return { ok: true, value: { filter: { guidePath: f.guidePath, model: f.model }, modes: out } };
}
