// What kind of device the app runs on, told to agents with the person's clock ("from their phone"). No single signal is
// reliable: Mac Safari and iPadOS Safari send the same desktop user agent, Android Chrome asking for the desktop site sends
// a Linux one, and touch laptops have touchscreens. The user agent's explicit tokens decide first; otherwise the pointer,
// hover, touch points and screen size must agree, and when they don't the answer is unknown rather than a guess.
import { validZone, type Device, type ZoneReport } from '../shared/zone.js';

export interface DeviceSignals {
  userAgent: string;
  /** navigator.userAgentData.mobile where the browser has it (Chromium), else null. */
  uaMobile: boolean | null;
  maxTouchPoints: number;
  /** The primary pointer is coarse (a finger): (pointer: coarse). */
  coarse: boolean;
  /** Some pointer is fine (mouse, trackpad, pen): (any-pointer: fine). */
  anyFine: boolean;
  /** The primary pointer can hover: (hover: hover). */
  hover: boolean;
  /** The screen's shorter side in CSS pixels. */
  shortSide: number;
}

/** Android's tablet line (sw600dp): a touch-only screen narrower than this is a phone. */
const TABLET_SIDE = 600;

export function classifyDevice(s: DeviceSignals): Device {
  const ua = s.userAgent;
  if (/\b(iPhone|iPod)\b/.test(ua)) return 'phone';
  if (/\biPad\b/.test(ua)) return 'tablet';
  if (/\bAndroid\b/.test(ua)) return /\bMobile\b/.test(ua) || s.uaMobile === true ? 'phone' : 'tablet';
  const bySize: Device = s.shortSide < TABLET_SIDE ? 'phone' : 'tablet';
  const mouse = !s.coarse && s.hover, touchOnly = s.coarse && !s.hover && !s.anyFine;
  // No Mac has a touchscreen: touch points on a Mac user agent are iPadOS, or an iPhone asking for the desktop site.
  if (/\bMacintosh\b/.test(ua)) return s.maxTouchPoints === 0 ? 'computer' : s.maxTouchPoints > 1 ? bySize : 'unknown';
  if (/\b(Windows NT|CrOS|X11|Linux)\b/.test(ua)) return mouse ? 'computer' : touchOnly && s.maxTouchPoints > 0 ? bySize : 'unknown';
  return mouse && s.maxTouchPoints === 0 ? 'computer' : 'unknown';
}

export function deviceSignals(): DeviceSignals {
  const media = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: unknown } };
  const mobile = nav.userAgentData?.mobile;
  return {
    userAgent: nav.userAgent, uaMobile: typeof mobile === 'boolean' ? mobile : null, maxTouchPoints: nav.maxTouchPoints,
    coarse: media('(pointer: coarse)'), anyFine: media('(any-pointer: fine)'), hover: media('(hover: hover)'),
    shortSide: Math.min(screen.width, screen.height),
  };
}

/** This device's IANA zone and kind, or null when the runtime reports no zone it could name. */
export function deviceZone(): ZoneReport | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validZone(zone) ? { zone, device: classifyDevice(deviceSignals()) } : null;
}
