// Channel settings: where each channel's inbound messages go. A person with the `channels` extension sets a mode for
// every platform they have in their extension config (channels.modes) and may override single channels
// ("kenan:CHAT", "signal:group:ID") at run time, kept in ~/.local/share/kenan/channels.json. A person without it has
// one known behaviour: their Kenan shared chats reach their Kenaznia when addressed to it, and texts to Kenan's line
// reach it directly; nothing else is routed.
import { readFileSync } from 'node:fs';
import { chown, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ownedDir } from '../extensions/texts.js';
import type { PersonConfig } from '../config.js';
import { platformOf, type Mode } from './address.js';
import { CHANNELS_SHAPE, checkMode, parseChannels, type ChannelsConfig } from './setup.js';
export { checkMode, platformsOf, type ChannelsConfig, type FilterConfig } from './setup.js';

export const CHANNELS_EXTENSION = 'channels';

export type ChannelSetup = { kind: 'fixed' } | ({ kind: 'configured' } & ChannelsConfig);

/** The channels extension takes its settings from people[].channels in the channel config, or from the extension
 *  config's `channels` entry; exactly one of them. */
export function channelSetup(person: Pick<PersonConfig, 'id' | 'extensions' | 'signalStore' | 'extensionConfigPath' | 'channels'>): ChannelSetup {
  if (!person.extensions.includes(CHANNELS_EXTENSION)) return { kind: 'fixed' };
  const inline = person.channels;
  const fromFile = person.extensionConfigPath ? (JSON.parse(readFileSync(person.extensionConfigPath, 'utf8')) as { channels?: unknown }).channels : undefined;
  if (inline !== undefined && fromFile !== undefined) throw new Error(`channels_ambiguous: ${person.id} has channels both in people[].channels and in ${person.extensionConfigPath}; keep one`);
  const raw = inline ?? fromFile;
  if (raw === undefined) throw new Error(`channels_unconfigured: ${person.id} has the channels extension but no settings; ${CHANNELS_SHAPE} in people[].channels or the extension config`);
  const parsed = parseChannels(person, raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return { kind: 'configured', ...parsed.value };
}

const overridesFile = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/channels.json');
export type Overrides = Record<string, Mode>;
export async function readOverrides(person: Pick<PersonConfig, 'home'>): Promise<Overrides> {
  const data = await readFile(overridesFile(person), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{"overrides":{}}'; throw e; });
  return (JSON.parse(data) as { overrides: Overrides }).overrides;
}
let writing = Promise.resolve();
/** Sets (mode) or clears (null) one channel's override; returns every override after the change. */
export function setOverride(person: PersonConfig, channel: string, mode: Mode | null): Promise<Overrides> {
  const run = writing.then(async () => {
    const platform = platformOf(channel);
    if (!platform) throw new Error(`channels_invalid: "${channel}" names no platform`);
    if (mode !== null) { const checked = checkMode(platform, mode); if (!checked.ok) throw new Error(checked.error); }
    const all = await readOverrides(person);
    if (mode === null) delete all[channel]; else all[channel] = mode;
    const file = overridesFile(person), temp = `${file}.${process.pid}.tmp`;
    await ownedDir(person, dirname(file));
    await writeFile(temp, JSON.stringify({ overrides: all }, null, 2), { mode: 0o600 });
    await chown(temp, person.uid, person.gid);
    await rename(temp, file);
    return all;
  });
  writing = run.then(() => {}, () => {});
  return run;
}

/** Where a message on `channel` goes for this person. Overrides match the channel exactly or as a prefix ending in ":"
 *  ("signal:group:" covers every group), longest first. A platform the person doesn't have is off. */
export function modeFor(setup: ChannelSetup, overrides: Overrides, channel: string): Mode {
  const platform = platformOf(channel);
  if (!platform) return 'off';
  if (setup.kind === 'fixed') return platform === 'kenan' ? 'addressed' : platform === 'texts' ? 'direct' : 'off';
  const keys = Object.keys(overrides).filter(k => k === channel || (k.endsWith(':') && channel.startsWith(k))).sort((a, b) => b.length - a.length);
  return keys.length ? overrides[keys[0]!]! : setup.modes[platform] ?? 'off';
}

export async function modeOf(person: PersonConfig, channel: string): Promise<Mode> {
  const setup = channelSetup(person);
  return modeFor(setup, setup.kind === 'fixed' ? {} : await readOverrides(person), channel);
}
