import { contentCadenceExtension } from './content-cadence.js';
import type { Extension } from '../types.js';
import { meetingExtension, myMeetingsExtension } from './meeting.js';
import { voiceExtension } from './voice.js';
import { dictationExtension } from './dictation.js';
import { calendarExtension } from './calendar.js';
import { mailExtension } from './mail.js';
import { browserExtension } from './browser.js';
import { textsExtension } from './texts.js';
import { signalExtension } from './signal.js';
import { inboxExtension } from './inbox.js';
import { afterHoursExtension } from './after-hours.js';
import { healthExtension } from './health.js';
import { phoneExtension } from './phone-control.js';
import { phoneSettingsExtension } from './phone-settings.js';
import { discordExtension } from './discord.js';
import { channelsExtension } from './channels.js';
import { asksExtension } from './asks.js';
import { questionsExtension, todosExtension } from './todos.js';
import { roomsExtension } from './rooms.js';
import { loadModules } from '../modules.js';
/** Core's extensions, then those of every module the build contains. */
export async function loadExtensions(): Promise<Extension[]> { return [...core(), ...(await loadModules()).flatMap(m => m.extensions)]; }
const core = (): Extension[] => [voiceExtension, calendarExtension, mailExtension, browserExtension, textsExtension, signalExtension, inboxExtension, channelsExtension, discordExtension, phoneExtension, phoneSettingsExtension, meetingExtension, myMeetingsExtension, contentCadenceExtension, todosExtension, questionsExtension, roomsExtension, dictationExtension, afterHoursExtension, healthExtension, asksExtension];
