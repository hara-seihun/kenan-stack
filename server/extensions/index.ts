import { contentCadenceExtension } from './content-cadence.js';
import type { Extension } from '../types.js';
import { meetingExtension } from './meeting.js';
import { voiceExtension } from './voice.js';
import { calendarExtension } from './calendar.js';
import { mailExtension } from './mail.js';
import { browserExtension } from './browser.js';
import { textsExtension } from './texts.js';
import { organizedExtension, roomsExtension } from './organized.js';
export function loadExtensions(): Extension[] { return [voiceExtension, calendarExtension, mailExtension, browserExtension, textsExtension, meetingExtension, contentCadenceExtension, organizedExtension, roomsExtension]; }
