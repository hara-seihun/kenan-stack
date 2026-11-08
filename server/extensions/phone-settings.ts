// Phone settings and screen commands use only the Kenan app.
import { appendFile, chown, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { PersonConfig } from '../config.js';
import { fail } from '../db/errors.js';
import { EVENT_INBOX_ROOT, queueHostEvent } from '../event-inbox.js';
import { personOf } from '../http/app.js';
import type { Extension } from '../types.js';
import { currentLocation, receivePosition, receiveWifi } from './phone-location.js';
import { receiveSettingsResult, requestSettings, startSettingsCommands } from './phone-settings-commands.js';
import { saveReport, startWatch, stopWatch } from './texts-watch.js';

/** The phone's network diagnostics (NetworkDiag.kt), one JSON entry per line with the server's receipt time. */
export const networkFile = (person: Pick<PersonConfig, 'home'>) => join(person.home, '.local/share/kenan/phone-settings/network.jsonl');
const NETWORK_ROTATE_BYTES = 32 * 1024 * 1024;

const ACTIONS = ['location', 'network', 'status', 'packages', 'remove', 'disable', 'set', 'get', 'appop', 'unrestrict', 'grant', 'shell', 'read', 'start', 'end', 'ui', 'tap', 'tap_text', 'screenshot', 'note', 'log', 'undo'] as const;
export async function appendNetwork(person: PersonConfig, entries: unknown[], at: number) {
  const file = networkFile(person), dir = join(file, '..');
  await mkdir(dir, { recursive: true });
  await chown(dir, person.uid, person.gid);
  const size = await stat(file).then(s => s.size, () => 0);
  if (size > NETWORK_ROTATE_BYTES) await rename(file, `${file}.1`);
  await appendFile(file, entries.map(e => JSON.stringify({ received: at, ...(e as object) })).join('\n') + '\n', { mode: 0o600 });
  await chown(file, person.uid, person.gid);
  await saveReport(person, entries, at);
}

/** The newest `limit` network entries, oldest first. */
export async function readNetwork(person: PersonConfig, limit: number): Promise<string> {
  const text = await readFile(networkFile(person), 'utf8').catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (text === null) return 'No network diagnostics yet: the Kenan app batches them every 15 minutes and sends connection failures promptly.';
  return text.trimEnd().split('\n').slice(-limit).join('\n');
}

let stopCommands: (() => void) | undefined;
let locationPruner: ReturnType<typeof setInterval> | undefined;

export const phoneSettingsExtension: Extension = {
  id: 'phone-settings', name: 'Phone settings',
  promptSnippet: 'Phone settings: phone_settings operates through the Kenan Android app, including settings, package lists and screens. Changes have a log and undo. Start a visible screen session before ui/tap/screenshot and end it when finished. Android privilege errors never require debugging.',
  async start(deps) {
    await startWatch(deps);
    stopCommands = await startSettingsCommands(deps.config.people.filter(p => p.extensions.includes('phone-settings')), deps);
    const prune = () => deps.store.prunePhoneLocations(deps.now()).catch(e => deps.store.logError('phone-location-retention', String(e)));
    await prune(); locationPruner = setInterval(() => { void prune(); }, 3600_000); locationPruner.unref?.();
  },
  async stop() { stopCommands?.(); stopCommands = undefined; await stopWatch(); if (locationPruner) clearInterval(locationPruner); locationPruner = undefined; },
  routes(app, deps) {
    app.use('*', async (c, next) => { if (!deps.person(personOf(c))?.extensions.includes('phone-settings')) fail('forbidden', 'Phone settings are not enabled'); await next(); });
    app.post('/location', async c => {
      const person = deps.person(personOf(c))!;
      await receivePosition(deps.store, person, await c.req.json().catch(() => null), deps.now());
      const position = await currentLocation(deps.store, person, deps.now());
      if (position.available) await queueHostEvent(EVENT_INBOX_ROOT, person.id, {
        topic: 'phone-location', id: `phone-location:${person.id}:${position.measured_at}`,
        body: { place: position.place, at_home: position.at_home },
      });
      return c.json({ ok: true, value: null });
    });
    app.get('/location', async c => c.json({ ok: true, value: await currentLocation(deps.store, deps.person(personOf(c))!, deps.now()) }));
    app.post('/results', async c => {
      const outcome = await receiveSettingsResult(deps.person(personOf(c))!, await c.req.json().catch(() => null));
      return c.json(outcome, outcome.ok ? 200 : 400);
    });
    app.post('/network', async c => {
      const body = await c.req.json().catch(() => null) as { entries?: unknown } | null;
      const entries = body?.entries;
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > 3000 || !entries.every(e => typeof e === 'object' && e !== null && !Array.isArray(e)))
        return fail('invalid_input', 'entries: 1–3000 JSON objects');
      await appendNetwork(deps.person(personOf(c))!, entries, deps.now());
      await receiveWifi(deps.person(personOf(c))!, entries, deps.now());
      return c.json({ ok: true, value: null });
    });
  },
  tool: ({ person, deps }) => ({
    name: 'phone_settings', files: 'none', records: 'none', label: 'Phone settings',
    description: `Operate ${person.name}'s Android phone through the Kenan app's connection (cellular or Wi-Fi, no debugging). location returns latest place, position, age, accuracy, at_home and stale; a stale fix is not current whereabouts. network (limit required) reads recent network diagnostics. status reports app/device capabilities, texts forwarding diagnostics (permissions and upload results), and battery, CPU, UID traffic and callback counters when the app supports them; battery readings are device-wide, not app attribution. packages lists visible installed packages (scope third-party, removed, all; completeness reported). get/set reads or writes system/secure/global settings; value null deletes a key. Every mutation is logged with its id and captured undo where Android supports it. log reads changes (limit default 50); undo takes ids; note records text and optional undo as a JSON app command. grant/appop/unrestrict/remove/disable use Android APIs where allowed; otherwise return a typed permission or privilege error. Android cannot silently grant other apps permissions, change other apps' AppOps, remove system packages, or run privileged shell commands without device-owner/system powers. shell/read do not run shell commands. Screens: tell the person first, start begins a visible session with Stop; ui lists elements; tap uses x/y; tap_text uses text and optional index; screenshot saves an image and returns its server-managed path; end finishes. Coordinates are screenshot pixels (long side at most 1568). A stopped or idle session needs an explicit start; never infer the person stopped it. SMS/RCS forwarding needs no screen session or accessibility service. The app requests Android SMS, notification access and other user-tap-only permissions once inside the app. Never enable or ask for Wireless debugging or adb.`,
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map(a => Type.Literal(a))),
      packages: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$' }), { minItems: 1 })),
      namespace: Type.Optional(Type.Union([Type.Literal('system'), Type.Literal('secure'), Type.Literal('global')])),
      key: Type.Optional(Type.String({ minLength: 1 })), value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      op: Type.Optional(Type.String({ minLength: 1 })), mode: Type.Optional(Type.String({ minLength: 1 })),
      permission: Type.Optional(Type.String({ minLength: 1 })),
      command: Type.Optional(Type.String({ minLength: 1 })), undo: Type.Optional(Type.String({ minLength: 1 })),
      force: Type.Optional(Type.Boolean()),
      scope: Type.Optional(Type.Union([Type.Literal('third-party'), Type.Literal('removed'), Type.Literal('all')])),
      x: Type.Optional(Type.Integer({ minimum: 0 })), y: Type.Optional(Type.Integer({ minimum: 0 })),
      text: Type.Optional(Type.String({ minLength: 1 })), index: Type.Optional(Type.Integer({ minimum: 0 })),
      ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    async execute(_id, raw: unknown, signal) {
      const args = raw as { action: string; limit?: number; [key: string]: unknown };
      if (args.action === 'location') return { content: [{ type: 'text' as const, text: JSON.stringify(await currentLocation(deps.store, person, deps.now())) }], details: {} };
      if (args.action === 'network') {
        if (args.limit === undefined) throw new Error('network needs limit');
        return { content: [{ type: 'text' as const, text: await readNetwork(person, args.limit) }], details: {} };
      }
      const result = await requestSettings(person, args, deps.now(), signal);
      if (result.ok && args.action === 'screenshot' && typeof result.value.path === 'string') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }, { type: 'image' as const, data: (await readFile(result.value.path)).toString('base64'), mimeType: String(result.value.mime) }], details: {} };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {}, ...(!result.ok ? { isError: true } : {}) };
    },
  }),
};
