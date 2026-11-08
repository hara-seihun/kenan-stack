// Private phone positions. The phone normally supplies Android's reverse-geocoded name; the server fills missing names.
import { chown, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonConfig } from '../config.js';
import { ownedDir } from './texts.js';
import { fail } from '../db/errors.js';
import type { PhoneLocation, Store } from '../types.js';

const DAY = 86400_000;
const FRESH = 5 * 60_000;
export interface HomeArea { latitude: number; longitude: number; radiusMeters: number; place: string; wifiSsids: string[] }
export const homeFile = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/phone-settings/home.json');
const wifiFile = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/phone-settings/wifi.json');
async function jsonFile(path: string): Promise<unknown> {
  return readFile(path, 'utf8').then(JSON.parse, (e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? null : Promise.reject(e));
}
async function ownedJson(person: PersonConfig, path: string, value: unknown) {
  await ownedDir(person, join(path, '..'));
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await chown(temp, person.uid, person.gid); await rename(temp, path);
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export async function readHome(person: Pick<PersonConfig, 'home'>): Promise<HomeArea | null> {
  const h = await jsonFile(homeFile(person)) as HomeArea | null;
  if (!h) return null;
  if (!finite(h.latitude) || Math.abs(h.latitude) > 90 || !finite(h.longitude) || Math.abs(h.longitude) > 180 || !finite(h.radiusMeters) || h.radiusMeters < 25 || h.radiusMeters > 2000 || typeof h.place !== 'string' || !Array.isArray(h.wifiSsids) || !h.wifiSsids.every(s => typeof s === 'string' && s.length > 0)) throw new Error('phone_location_home_invalid');
  return h;
}
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180, dlat = (b.latitude - a.latitude) * rad, dlon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const ssidName = (raw: unknown): string | null => typeof raw === 'string' && raw.length <= 128 && raw !== '<unknown ssid>' && raw !== '' ? raw.replace(/^"(.*)"$/, '$1') : null;
export type Position = Pick<PhoneLocation, 'latitude' | 'longitude' | 'accuracy' | 'measuredAt' | 'place' | 'wifiSsid'>;
export function parsePosition(raw: unknown, now: number): Position {
  const p = raw as Record<string, unknown> | null;
  if (!p || !finite(p.latitude) || Math.abs(p.latitude) > 90 || !finite(p.longitude) || Math.abs(p.longitude) > 180 || !finite(p.accuracy) || p.accuracy < 0 || p.accuracy > 100_000 || !Number.isSafeInteger(p.measuredAt) || (p.measuredAt as number) <= now - 30 * DAY || (p.measuredAt as number) > now + 60_000) return fail('invalid_input', 'location: valid coordinates, accuracy in meters and a measurement time within 30 days (not in the future)');
  if (p.place !== undefined && p.place !== null && (typeof p.place !== 'string' || p.place.length > 500)) return fail('invalid_input', 'place: at most 500 characters');
  if (p.wifiSsid !== undefined && p.wifiSsid !== null && (typeof p.wifiSsid !== 'string' || p.wifiSsid.length > 128)) return fail('invalid_input', 'wifiSsid: at most 128 characters');
  return { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, measuredAt: p.measuredAt as number, place: typeof p.place === 'string' && p.place.trim() ? p.place.trim() : null, wifiSsid: ssidName(p.wifiSsid) };
}
export function isHome(p: Position, home: HomeArea | null): boolean {
  return home !== null && ((p.wifiSsid !== null && home.wifiSsids.includes(p.wifiSsid)) || (p.accuracy <= home.radiusMeters && distanceMeters(p, home) <= home.radiusMeters));
}
async function placeOf(p: Position, previous: PhoneLocation | null): Promise<string | null> {
  if (p.place) return p.place;
  if (previous?.place && distanceMeters(p, previous) < 100) return previous.place;
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${p.latitude}&lon=${p.longitude}`, { headers: { 'User-Agent': 'Kenan personal location assistant', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const body = await response.json() as { display_name?: unknown };
    return typeof body.display_name === 'string' ? body.display_name.slice(0, 500) : null;
  } catch { return null; }
}
// One writer per person also orders Wi-Fi learning, network updates and location uploads.
const writers = new Map<string, Promise<unknown>>();
function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
  const task = (writers.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
  writers.set(id, task); void task.finally(() => { if (writers.get(id) === task) writers.delete(id); }).catch(() => undefined); return task;
}
export function receivePosition(store: Store, person: PersonConfig, raw: unknown, now: number): Promise<void> {
  const p = parsePosition(raw, now);
  return serial(person.id, async () => {
    const previous = await store.latestPhoneLocation(person.id, now), home = await readHome(person);
    // An upload may contain a cached fix alongside today's Wi-Fi association.
    const atHome = isHome({ ...p, wifiSsid: now - p.measuredAt <= FRESH ? p.wifiSsid : null }, home);
    // Learn the home SSID only from a precise, fresh fix well inside the home area. Never from an IP or an assumed address.
    if (home && p.wifiSsid && !home.wifiSsids.includes(p.wifiSsid) && now - p.measuredAt < 5 * 60_000 && p.accuracy <= 50 && distanceMeters(p, home) + p.accuracy <= home.radiusMeters / 2) {
      home.wifiSsids.push(p.wifiSsid); await ownedJson(person, homeFile(person), home);
    }
    const homeSince = atHome ? previous?.atHome && p.measuredAt >= previous.measuredAt && p.measuredAt - previous.measuredAt <= FRESH ? previous.homeSince ?? previous.measuredAt : p.measuredAt : null;
    await store.savePhoneLocation({ ...p, personId: person.id, receivedAt: now, place: atHome ? home!.place : await placeOf(p, previous), atHome, homeSince });
  });
}
interface Wifi { ssid: string | null; at: number; since: number }
export function receiveWifi(person: PersonConfig, entries: unknown[], now: number): Promise<void> {
  const snapshot = entries.filter((e): e is { kind: string; t: number; wifi?: { ssid?: unknown } } => e !== null && typeof e === 'object' && (e as { kind?: string }).kind === 'snapshot' && finite((e as { t?: unknown }).t))
    .filter(e => e.t <= now + 60_000 && e.t >= now - 120_000).sort((a,b) => b.t - a.t)[0];
  if (!snapshot) return Promise.resolve();
  return serial(person.id, async () => {
    const old = await jsonFile(wifiFile(person)) as Wifi | null, ssid = ssidName(snapshot.wifi?.ssid), at = Math.min(snapshot.t, now);
    if (old && old.at > at) return;
    await ownedJson(person, wifiFile(person), { ssid, at, since: old?.ssid === ssid && at - old.at < 120_000 ? old.since : at });
  });
}
export async function currentLocation(store: Store, person: PersonConfig, now: number) {
  const [position, home, wifi] = await Promise.all([store.latestPhoneLocation(person.id, now), readHome(person), jsonFile(wifiFile(person)) as Promise<Wifi | null>]);
  // Compare observation times, not arrival order or freshness windows. A home Wi-Fi
  // detection must not expire back into an older away fix: it becomes stale instead.
  // An unknown Wi-Fi name says nothing about where the phone is.
  const homeWifi = !!home && !!wifi?.ssid && home.wifiSsids.includes(wifi.ssid) && (!position || wifi.at > position.measuredAt);
  if (!position && !homeWifi) return { available: false as const, reason: 'No phone location received. Location permission or device location may be off.' };
  const measuredAt = homeWifi ? wifi!.at : position!.measuredAt;
  const ageSeconds = Math.max(0, Math.floor((now - measuredAt) / 1000));
  const atHome = homeWifi || position!.atHome;
  return { available: true as const, place: homeWifi ? home!.place : position!.place, at_home: atHome,
    home_since: atHome ? homeWifi ? position?.atHome ? Math.min(position.homeSince ?? position.measuredAt, wifi!.since) : wifi!.since : position!.homeSince : null,
    source: homeWifi ? 'home_wifi' : 'location', latitude: homeWifi ? null : position!.latitude, longitude: homeWifi ? null : position!.longitude,
    measured_at: measuredAt, age_seconds: ageSeconds, accuracy_meters: homeWifi ? null : position!.accuracy,
    stale: now - measuredAt > FRESH, home_configured: home !== null };
}
export function locationLine(value: Awaited<ReturnType<typeof currentLocation>>, zone: string): string {
  if (!value.available) return '';
  const time = (n: number) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(n);
  const place = value.at_home ? 'at home' : value.place ? `near ${value.place.replace(/[\r\n\[\]]/g, ' ').slice(0, 120)}` : 'away from home';
  return `[Phone location: ${place}${value.at_home && value.home_since ? ` since ${time(value.home_since)}` : ''}${value.stale ? `; last seen ${value.age_seconds === null ? 'unknown' : Math.floor(value.age_seconds / 60) + ' min'} ago, not a current fix` : ''}]`;
}
