// The whole channel config as the server will read it: the channel file (loadConfig) and every person's media settings in
// their extension config, parsed by the same functions the extensions use. deploy.sh runs it against the new build and
// kenan-runtime-restart against the installed one, so a config the code can't read stops the deploy or restart.
// 2026-11-02: removing the meeting output gate also removed its gateHoldMs setting; Acme's meeting config still had it,
// so meeting voice failed to parse at every join, was logged and quietly switched off, and its meetings got the
// captions-only notetaker for hours.
import { loadConfig, type PersonConfig, type ServerConfig } from './config.js';
import { mediaSettings, telephoneConfig } from './extensions/phone.js';
import { readFileSync } from 'node:fs';
import { meetingVoiceConfig } from './extensions/meeting-voice.js';
import { calendarContextConfig } from './extensions/meeting-calendar-context.js';

/** Every media setting the given people's extensions would fail to read, one line each; [] when all parse. */
export function mediaConfigProblems(people: PersonConfig[]): string[] {
  const problems: string[] = [];
  for (const person of people) {
    if (!person.extensionConfigPath) continue;
    const at = `${person.id} (${person.extensionConfigPath})`;
    let media: Record<string, unknown>;
    try { media = mediaSettings(person) ?? {}; } catch (error) { problems.push(`${at}: ${message(error)}`); continue; }
    const check = (read: () => unknown) => { try { read(); } catch (error) { problems.push(`${at}: ${message(error)}`); } };
    if (person.extensions.includes('meeting')) check(() => meetingVoiceConfig(media.meeting));
    // tools.meeting.calendarContext (the agenda read for the meeting voice): optional, but a broken one is named here.
    if (person.extensions.includes('meeting')) check(() => calendarContextConfig((JSON.parse(readFileSync(person.extensionConfigPath!, 'utf8')) as { tools?: { meeting?: { calendarContext?: unknown } } }).tools?.meeting?.calendarContext));
    if (person.extensions.includes('voice')) check(() => telephoneConfig(media.telephone));
  }
  return problems;
}

/** Loads the channel config and checks every person's media settings; throws naming every problem. */
export function checkChannelConfig(path: string): ServerConfig {
  const config = loadConfig(path);
  const problems = mediaConfigProblems(config.people);
  if (problems.length) throw new Error(`config_unreadable: ${problems.length} media setting(s) this build can't read:\n${problems.join('\n')}`);
  return config;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
