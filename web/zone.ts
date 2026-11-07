// Keeps the server's record of the person's time zone and device kind (Bootstrap.zone) equal to this device's, so their day,
// morning check and agents' clock follow them when they travel or switch devices. Reads are free; a request goes out only
// when either differs.
import type { ZoneReport } from '../shared/zone.js';

/** Only the device in use reports: an open but unfocused window on a computer must not take the device back from a phone.
 *  The classifier loads on first use, outside the startup bundle. */
export const focusedZone = async (): Promise<ZoneReport | null> => document.hasFocus() ? (await import('./device.js')).deviceZone() : null;

export interface ZoneReporter {
  /** What the server holds (from a bootstrap), or null when it holds nothing; checks soon after. */
  known(report: ZoneReport | null): void;
  /** Compares the device with the server soon (on load, foreground, focus); bursts collapse into one check. */
  check(): void;
}

const same = (a: ZoneReport | null, b: ZoneReport | null) => a?.zone === b?.zone && a?.device === b?.device;

export function zoneReporter(send: (report: ZoneReport) => Promise<ZoneReport>, read: () => Promise<ZoneReport | null>, delayMs: number): ZoneReporter {
  let server: { report: ZoneReport | null } | null = null, sending: ZoneReport | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const report = await read().catch(() => null);
    if (!server || report === null || same(report, server.report) || same(report, sending)) return;
    sending = report;
    send(report).then(stored => { server = { report: stored }; }, () => {}).finally(() => { sending = null; });
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => void run(), delayMs); };
  return { known(report) { server = { report }; soon(); }, check: soon };
}
