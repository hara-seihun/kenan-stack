// Apple Health sync (Dave 2026-10-26): Health keeps no server API, so a daily Shortcut on his iPhone finds the last day's
// samples (sleep stages, resting heart rate, HRV, respiratory rate, steps, weight...) and posts them as one line each,
// `TYPE|START|END|VALUE|UNIT|SOURCE` with ISO 8601 times, to POST /hooks/health/days/YYYY-MM-DD (the day he woke up) with
// a per-device bearer token whose sha256 is in people[].health. The day is the idempotency key: a later sync of the same
// day replaces it. Everything lands only in his own folder (HOME/ID/health, 0600): the raw lines, the day's summary as
// JSON, and the generated table in sleep-log.md his Kenaznia reads for trends. Nothing is logged but counts.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { todayIn, zoneOrHome } from '../../shared/zone.js';
import { hostFolder, type PersonConfig, type ServerConfig } from '../config.js';
import { fail } from '../db/errors.js';
import type { Deps, Extension } from '../types.js';
import { deviceFor, writeOwned } from './device-token.js';
import { ownedDir } from './texts.js';

export const MAX_BYTES = 2 * 1024 * 1024;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/** Sleep samples further apart than this belong to different sleeps. */
const SESSION_GAP_MS = 2 * 3600_000;
/** A break in sleep at least this long counts as a waking. */
const WAKING_MS = 2 * 60_000;
const AROUND_SLEEP_MS = 3600_000;
const MARK_START = '<!-- health-sync:start (generated from health/days/*.json on every sync; edit outside these marks) -->';
const MARK_END = '<!-- health-sync:end -->';

export type Stage = 'inbed' | 'asleep' | 'awake' | 'core' | 'deep' | 'rem';
export type Metric = 'heart_rate' | 'resting_heart_rate' | 'hrv' | 'respiratory_rate' | 'steps' | 'weight' | 'blood_oxygen' | 'wrist_temperature';
interface Span { start: number; end: number; source: string }
export type Sample = Span & ({ kind: 'sleep'; stage: Stage } | { kind: 'metric'; metric: Metric; value: number; unit: string } | { kind: 'other'; name: string; value: string; unit: string });
export interface Rejected { line: number; error: string }

const METRICS: Record<string, Metric> = {
  'heart rate': 'heart_rate', 'resting heart rate': 'resting_heart_rate', 'heart rate variability': 'hrv', 'heart rate variability sdnn': 'hrv',
  'respiratory rate': 'respiratory_rate', steps: 'steps', 'step count': 'steps', weight: 'weight', 'body mass': 'weight',
  'blood oxygen': 'blood_oxygen', 'oxygen saturation': 'blood_oxygen', 'wrist temperature': 'wrist_temperature', 'sleeping wrist temperature': 'wrist_temperature',
};
const SLEEP_TYPES = new Set(['sleep analysis', 'sleep']);
/** HKCategoryValueSleepAnalysis raw values, and the words Shortcuts shows (e.g. "Core", "Asleep Core", "In Bed", "Asleep (Unspecified)"). */
const RAW_STAGES: readonly Stage[] = ['inbed', 'asleep', 'awake', 'core', 'deep', 'rem'];
export function stageOf(value: string): Stage | null {
  const v = value.trim().toLowerCase();
  if (/^[0-5]$/.test(v)) return RAW_STAGES[Number(v)]!;
  if (v.includes('deep')) return 'deep';
  if (/\brem\b/.test(v)) return 'rem';
  if (v.includes('core')) return 'core';
  if (v.includes('awake')) return 'awake';
  if (/in ?bed/.test(v)) return 'inbed';
  if (v.includes('asleep') || v.includes('unspecified')) return 'asleep';
  return null;
}

const timeOf = (text: string): number | null => {
  const v = text.trim();
  if (!ISO.test(v)) return null;
  const at = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(at) ? at : null;
};

/** A number as Shortcuts writes it ("62", "48.5", "48,5" with a decimal comma, "8,123" steps with a grouping comma), with any unit it carries after it. */
function numberOf(text: string, metric: Metric): { value: number; unit: string } | null {
  const m = text.trim().match(/^(-?\d+(?:[.,]\d+)*)\s*(.*)$/);
  if (!m) return null;
  const value = Number(metric === 'steps' ? m[1]!.replaceAll(',', '') : m[1]!.replace(',', '.'));
  return Number.isFinite(value) ? { value, unit: m[2]!.trim() } : null;
}

/** Reads the body's lines; a line it can't read is reported, never guessed at. Blank lines and `#` lines are skipped. */
export function parseLines(body: string): { samples: Sample[]; rejected: Rejected[] } {
  const samples: Sample[] = [], rejected: Rejected[] = [];
  body.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim(), n = index + 1;
    if (!line || line.startsWith('#')) return;
    const fields = line.split('|').map(f => f.trim());
    if (fields.length < 5) { rejected.push({ line: n, error: 'expected TYPE|START|END|VALUE|UNIT|SOURCE' }); return; }
    const [type, startText, endText, value, unit] = fields as [string, string, string, string, string];
    const source = fields.slice(5).join('|');
    const start = timeOf(startText), end = timeOf(endText);
    if (start === null || end === null) { rejected.push({ line: n, error: `times must be ISO 8601 with an offset (Date Format: ISO 8601), got "${start === null ? startText : endText}"` }); return; }
    if (end < start) { rejected.push({ line: n, error: 'END is before START' }); return; }
    const name = type.toLowerCase();
    if (SLEEP_TYPES.has(name)) {
      const stage = stageOf(value);
      if (!stage) { rejected.push({ line: n, error: `unknown sleep value "${value}"` }); return; }
      samples.push({ kind: 'sleep', start, end, source, stage });
      return;
    }
    const metric = METRICS[name];
    if (!metric) { samples.push({ kind: 'other', name: type, start, end, source, value, unit }); return; }
    const parsed = numberOf(value, metric);
    if (!parsed) { rejected.push({ line: n, error: `"${value}" is not a number` }); return; }
    samples.push({ kind: 'metric', metric, start, end, source, value: parsed.value, unit: unit || parsed.unit });
  });
  return { samples, rejected };
}

type Interval = [number, number];
const union = (spans: readonly Interval[]): Interval[] => {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]), out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
};
const minutes = (spans: readonly Interval[]) => Math.round(union(spans).reduce((t, [s, e]) => t + e - s, 0) / 60_000);

export interface Night {
  bed: number; wake: number; asleepMin: number; inBedMin: number | null;
  deepMin: number; remMin: number; coreMin: number; awakeMin: number;
  /** Whether the Watch wrote stages (core/deep/REM); without them only "asleep" is known. */
  stages: boolean; wakings: number; sources: string[];
}
const ASLEEP: ReadonlySet<Stage> = new Set(['asleep', 'core', 'deep', 'rem']);

/** The main sleep that ended on `date` in `zone` (the one with the most sleep), or null when none did. */
export function nightOf(samples: readonly Sample[], date: string, zone: string): Night | null {
  const sleep = samples.filter((s): s is Span & { kind: 'sleep'; stage: Stage } => s.kind === 'sleep').sort((a, b) => a.start - b.start);
  const sessions: (typeof sleep)[] = [];
  let end = -Infinity;
  for (const s of sleep) {
    if (s.start > end + SESSION_GAP_MS) sessions.push([]);
    sessions[sessions.length - 1]!.push(s);
    end = Math.max(end, s.end);
  }
  let best: Night | null = null;
  for (const session of sessions) {
    const of = (stages: readonly Stage[]) => session.filter(s => stages.includes(s.stage)).map(s => [s.start, s.end] as Interval);
    const asleep = union(session.filter(s => ASLEEP.has(s.stage)).map(s => [s.start, s.end]));
    if (!asleep.length) continue;
    const wake = asleep[asleep.length - 1]![1];
    if (todayIn(wake, zone) !== date) continue;
    const inBed = of(['inbed']);
    const night: Night = {
      bed: Math.min(...session.map(s => s.start)), wake, asleepMin: minutes(asleep), inBedMin: inBed.length ? minutes(inBed) : null,
      deepMin: minutes(of(['deep'])), remMin: minutes(of(['rem'])), coreMin: minutes(of(['core'])), awakeMin: minutes(of(['awake'])),
      stages: session.some(s => s.stage === 'core' || s.stage === 'deep' || s.stage === 'rem'),
      wakings: asleep.slice(1).filter(([s], i) => s - asleep[i]![1] >= WAKING_MS).length,
      sources: [...new Set(session.map(s => s.source).filter(Boolean))].sort(),
    };
    if (!best || night.asleepMin > best.asleepMin) best = night;
  }
  return best;
}

export interface Measure { value: number; unit: string; samples: number }
export interface DayMetrics {
  restingHeartRate: Measure | null; hrv: Measure | null; respiratoryRate: Measure | null; heartRate: (Measure & { min: number }) | null;
  bloodOxygen: Measure | null; wristTemperature: Measure | null; weight: Measure | null;
  /** Steps per local day the samples cover. */
  steps: Record<string, number>; other: string[];
}

/** Night-time measures are averaged over the main sleep (an hour either side); the rest are the latest sample. */
export function metricsOf(samples: readonly Sample[], night: Night | null, zone: string): DayMetrics {
  const of = (metric: Metric) => samples.filter((s): s is Span & { kind: 'metric'; metric: Metric; value: number; unit: string } => s.kind === 'metric' && s.metric === metric).sort((a, b) => a.start - b.start);
  const latest = (metric: Metric): Measure | null => { const all = of(metric), last = all[all.length - 1]; return last ? { value: last.value, unit: last.unit, samples: all.length } : null; };
  const overnight = (metric: Metric) => night ? of(metric).filter(s => s.start >= night.bed - AROUND_SLEEP_MS && s.start <= night.wake + AROUND_SLEEP_MS) : [];
  const mean = (metric: Metric): Measure | null => {
    const all = overnight(metric);
    return all.length ? { value: Math.round(all.reduce((t, s) => t + s.value, 0) / all.length * 10) / 10, unit: all[0]!.unit, samples: all.length } : null;
  };
  const hr = mean('heart_rate');
  const steps: Record<string, number> = {};
  for (const s of of('steps')) { const day = todayIn(s.start, zone); steps[day] = (steps[day] ?? 0) + s.value; }
  return {
    restingHeartRate: latest('resting_heart_rate'), hrv: mean('hrv'), respiratoryRate: mean('respiratory_rate'),
    heartRate: hr ? { ...hr, min: Math.min(...overnight('heart_rate').map(s => s.value)) } : null,
    bloodOxygen: mean('blood_oxygen'), wristTemperature: latest('wrist_temperature'), weight: latest('weight'), steps,
    other: [...new Set(samples.flatMap(s => s.kind === 'other' ? [s.name] : []))].sort(),
  };
}

export interface Day { date: string; receivedAt: number; device: string; samples: number; rejected: Rejected[]; night: Night | null; metrics: DayMetrics }


const hm = (min: number) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
const clock = (at: number, zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
const dayBefore = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const measure = (m: Measure | null, digits = 0) => m ? m.value.toFixed(digits) : '–';

export function row(day: Day, zone: string): string {
  const n = day.night, m = day.metrics, before = dayBefore(day.date);
  const steps = m.steps[before];
  const notes = [
    ...(n && !n.stages ? ['no stages (iPhone only?)'] : []),
    ...(m.heartRate ? [`HR ${m.heartRate.min}–${Math.round(m.heartRate.value)} asleep`] : []),
    ...(m.bloodOxygen ? [`SpO₂ ${m.bloodOxygen.value}`] : []),
    ...(m.weight ? [`weight ${m.weight.value} ${m.weight.unit}`] : []),
    ...(day.rejected.length ? [`${day.rejected.length} lines not read`] : []),
  ].join('; ');
  const cells = n
    ? [hm(n.asleepMin), n.inBedMin === null ? '–' : hm(n.inBedMin), n.stages ? hm(n.deepMin) : '–', n.stages ? hm(n.remMin) : '–', n.stages ? hm(n.coreMin) : '–', hm(n.awakeMin), String(n.wakings), `${clock(n.bed, zone)} → ${clock(n.wake, zone)}`]
    : ['no sleep recorded', '', '', '', '', '', '', ''];
  return `| ${before} → ${day.date.slice(8)} | ${cells.join(' | ')} | ${measure(m.restingHeartRate)} | ${measure(m.hrv)} | ${measure(m.respiratoryRate, 1)} | ${steps === undefined ? '–' : Math.round(steps)} | ${notes} |`;
}

/** sleep-log.md with the generated table (every kept day, oldest first) between the marks; everything outside them is kept. */
export function sleepLog(existing: string | null, days: readonly Day[], zone: string): string {
  const table = [MARK_START, '## Synced from Apple Health', '',
    '| Night of | Asleep | In bed | Deep | REM | Core | Awake | Wakings | Bed → wake | Resting HR | HRV ms | Resp /min | Steps (day before) | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...[...days].sort((a, b) => a.date.localeCompare(b.date)).map(d => row(d, zone)), MARK_END].join('\n');
  if (existing === null) return `# Dave's sleep log (private)\n\n${table}\n`;
  const from = existing.indexOf(MARK_START), to = existing.indexOf(MARK_END);
  if (from >= 0 && to > from) return existing.slice(0, from) + table + existing.slice(to + MARK_END.length);
  return `${existing.trimEnd()}\n\n${table}\n`;
}

const folders = new Map<string, Promise<unknown>>();
function inFolder<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const run = (folders.get(dir) ?? Promise.resolve()).then(work);
  folders.set(dir, run.catch(() => {}));
  return run;
}
const readOr = (path: string) => readFile(path, 'utf8').catch(e => (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(e));

/** Keeps one day: its raw lines and summary replace any earlier sync of that day, then the log is written again. */
export async function storeDay(deps: Pick<Deps, 'config' | 'now' | 'store'>, person: PersonConfig, device: string, date: string, body: string): Promise<Day> {
  const zone = zoneOrHome(await deps.store.zoneOf(person.id));
  const { samples, rejected } = parseLines(body);
  if (!samples.length) fail('invalid_input', `health_empty: no sample could be read${rejected.length ? ` (line ${rejected[0]!.line}: ${rejected[0]!.error})` : ''}`);
  const night = nightOf(samples, date, zone);
  const day: Day = { date, receivedAt: deps.now(), device, samples: samples.length, rejected, night, metrics: metricsOf(samples, night, zone) };
  const dir = hostFolder(person, deps.config.channel, 'health'), days = await ownedDir(person, join(dir, 'days'));
  return inFolder(dir, async () => {
    await writeOwned(person, join(days, `${date}.txt`), body);
    await writeOwned(person, join(days, `${date}.json`), JSON.stringify(day, null, 1) + '\n');
    const kept = await Promise.all((await readdir(days)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(async n => JSON.parse(await readFile(join(days, n), 'utf8')) as Day));
    const log = join(dir, 'sleep-log.md');
    await writeOwned(person, log, sleepLog(await readOr(log), kept, zone));
    return day;
  });
}

export const healthExtension: Extension = {
  id: 'health', name: 'Apple Health',
  hooks(app, deps) {
    app.post('/days/:date', async c => {
      const found = deviceFor(deps.config.people, c.req.header('authorization'), p => p.health?.devices);
      if (!found) return fail('unauthenticated', 'health_token: send the device\'s token as Authorization: Bearer TOKEN');
      const date = c.req.param('date');
      if (!DAY.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return fail('invalid_input', 'health_date: the path ends in the day as YYYY-MM-DD');
      const type = c.req.header('content-type')?.split(';', 1)[0]!.trim().toLowerCase();
      if (type !== 'text/plain') return fail('invalid_input', 'health_type: Content-Type must be text/plain (one sample per line: TYPE|START|END|VALUE|UNIT|SOURCE)');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) return fail('invalid_input', `health_too_large: at most ${MAX_BYTES / 1024 / 1024} MiB a day`);
      let body: string;
      try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('invalid_input', 'health_text: the body must be UTF-8 text'); }
      const day = await storeDay(deps, found.person, found.device.id, date, body);
      console.log(JSON.stringify({ type: 'health_ingest', person: found.person.id, device: found.device.id, samples: day.samples, rejected: day.rejected.length }));
      const n = day.night;
      return c.json({ ok: true, value: {
        date, samples: day.samples, rejected: day.rejected.length, errors: day.rejected.slice(0, 5),
        sleep: n ? `${hm(n.asleepMin)} asleep, ${n.wakings} wakings${n.stages ? `, deep ${hm(n.deepMin)}, REM ${hm(n.remMin)}` : ''}` : 'no sleep ending that day',
      } });
    });
  },
};
