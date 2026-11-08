// Server configuration: /etc/kenan/<channel>.json. Owned by lead.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUNDS, TRAY_TILES, isTray, type Background, type TrayTile } from '../shared/contract.js';
import { BUBBLE_MIN_CONTRAST, isBubbleColor } from '../shared/bubble.js';
import { parseChannels, type ChannelsConfig } from './channels/setup.js';

export const DEFAULT_SWARM_MAX_ACTIVE = 20;
export const swarmMaxActive = (person: Pick<PersonConfig, 'swarmMaxActive'>): number => person.swarmMaxActive ?? DEFAULT_SWARM_MAX_ACTIVE;

export type ModelProvider = 'anthropic' | 'openai-codex' | 'openrouter' | 'xai' | 'nvidia' | 'google-cli';

export function assertAllowedProvider(allowedProviders: readonly ModelProvider[], provider: string): void {
  if (!Array.isArray(allowedProviders) || !allowedProviders.includes(provider as ModelProvider)) {
    throw new Error(`Provider ${provider} is not allowed on this host`);
  }
}

export interface PersonConfig {
  id: string;                       // e.g. 'alice' (also the login account id)
  name: string;
  unixUser: string;                 // tools run as this user, e.g. 'kenan' for alice
  uid: number;
  gid: number;
  home: string;                     // cwd for tools, e.g. /home/kenan
  brokerPort: number;               // kenan-model-broker loopback listener for this person
  heartbeatFile: string | null;     // e.g. /home/kenan/alice/HEARTBEAT.md (optional file)
  alertDir: string | null;          // host condition inbox (one *.md file per open condition) listed in this person's manager heartbeat
  identityBriefRenderer?: string;   // explicit owner-specific command: reads a brief on stdin, writes rendered brief on stdout; no default
  threadsFile?: string;             // set: kenan-threads' threads.json, whose "waiting on others" lists the manager heartbeat shows; unset: none
  signalStore: string | null;       // signal-receiver's receive.sqlite3 for this person's linked Signal account; null = no Signal wakes
  pronouns: string | null;          // e.g. 'she/her'; null = not known, so agents speaking about the person use no gendered words
  phones: string[];                 // the person's own phone numbers (E.164); [] = none known. Calls and texts to a Kenan line from them are that person's
  extensionConfigPath?: string;       // existing per-account extension settings
  extensions: string[];             // e.g. ['mail','voice','calendar','browser']
  composerVoice?: true;             // set: the composer shows the live voice button (needs 'voice'); unset: it doesn't, though 'voice' still places phone calls
  background?: Background;          // set: this art is drawn behind the app (e.g. 'starfield'); unset: the plain page colour
  trayTiles?: TrayTile[];           // set: the footer tray shows exactly these tiles in this order until the person chooses their own; unset: every tile that applies
  bubbleColor?: string;             // set: the person's own message bubbles in this #RRGGBB, white text on it (≥ 4.5:1); unset: the app's bubble colour
  afterHours?: AfterHoursConfig;    // set exactly when 'after-hours' is in extensions: the devices whose voice memos it takes
  health?: HealthConfig;            // set exactly when 'health' is in extensions: the devices whose Apple Health days it takes
  channels?: ChannelsConfig;        // set only with 'channels' in extensions: its watcher and modes (else the extension config's `channels` entry holds them)
  clientHome?: string;             // explicit account movement; other-channel manager placement alone does not move clients
  manager: ManagerPlacement;        // where this person's Kenaznia runs
  peers: PeerConfig[];              // Kenaznias on other hosts this person's agents can message; [] = none
  worker: AgentProfile;            // default profile for every worker and sub-agent
  swarmMaxActive?: number;          // Active descendants per top-level worker; unset: DEFAULT_SWARM_MAX_ACTIVE.
  isolated?: true;                 // private employee: no cross-owner agents or communication tools
  budget?: { dailyUsd: number; claude: boolean }; // rolling 24-hour API-equivalent allowance
}
/** A device that posts to a hook with a bearer token; only the token's sha256 (hex) is configured, the token lives on the device. */
export interface DeviceToken { id: string; tokenSha256: string }
/** Kenan After Hours (Dave 2026-10-23): a one-way voice-memo device (his Apple Watch) and when its memos may reach Kenaznia.
 * quietHours: local "HH:MM" span (in the person's zone) during which memos wait for its end before Kenaznia hears of them; null: never wait. */
export interface AfterHoursConfig { devices: DeviceToken[]; quietHours: { from: string; until: string } | null }
/** Apple Health sync (Dave 2026-10-26): the devices (his iPhone's Shortcut) that post a day's Health samples. */
export interface HealthConfig { devices: DeviceToken[] }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** people[].KEY is set exactly when EXTENSION is enabled, as an object with exactly `keys`; returns it for further checks. */
function extensionSection(person: PersonConfig, extension: string, key: 'afterHours' | 'health', keys: readonly string[], shape: string, path: string): Record<string, unknown> | null {
  const enabled = Array.isArray(person.extensions) && person.extensions.includes(extension);
  if (!(key in person)) { if (enabled) throw new Error(`people[${person.id}].${key} must be set with the ${extension} extension: ${shape} in ${path}`); return null; }
  if (!enabled) throw new Error(`people[${person.id}].${key} is set but the ${extension} extension is not in extensions in ${path}`);
  const section = person[key] as unknown as Record<string, unknown>;
  if (!section || typeof section !== 'object' || Object.keys(section).length !== keys.length || keys.some(k => !(k in section))) throw new Error(`people[${person.id}].${key} must be ${shape} in ${path}`);
  const devices = section.devices as unknown[];
  if (!Array.isArray(devices) || !devices.length
    || devices.some(d => { const r = d as Record<string, unknown>; return !r || Object.keys(r).length !== 2 || typeof r.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(r.id) || typeof r.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.tokenSha256); })
    || new Set(devices.map(d => (d as DeviceToken).id)).size !== devices.length) throw new Error(`people[${person.id}].${key}.devices must be a non-empty list of distinct {"id": a-z0-9-, "tokenSha256": 64 hex} in ${path}`);
  return section;
}
function assertAfterHours(person: PersonConfig, path: string): void {
  const a = extensionSection(person, 'after-hours', 'afterHours', ['devices', 'quietHours'], '{"devices": [{"id", "tokenSha256"}], "quietHours": {"from": "HH:MM", "until": "HH:MM"} or null}', path);
  if (!a) return;
  const q = a.quietHours as Record<string, unknown> | null;
  if (q !== null && (typeof q !== 'object' || Object.keys(q).length !== 2 || typeof q.from !== 'string' || !HHMM.test(q.from) || typeof q.until !== 'string' || !HHMM.test(q.until) || q.from === q.until)) throw new Error(`people[${person.id}].afterHours.quietHours must be {"from": "HH:MM", "until": "HH:MM"} (different times) or null in ${path}`);
}
const assertHealth = (person: PersonConfig, path: string) => { extensionSection(person, 'health', 'health', ['devices'], '{"devices": [{"id", "tokenSha256"}]}', path); };
/** Another Kenaznia: another person's on this host (possibly on the other channel) or one on another host. id: how this side names it (the peer tool's `peer`, the relay's `peer` field); name and about: what agents are told about it. */
export interface PeerConfig { id: string; name: string; about: string; relay?: true }
/** A profile hosts the person's Kenaznia on this channel; `elsewhere` names the app URL of the channel that hosts it; null: the person has workers only. */
export type ManagerPlacement = AgentProfile | { elsewhere: string } | null;
const E164 = /^\+[1-9]\d{6,14}$/;
/** The person whose own phone `number` is, or null when it is nobody's here. */
export const phoneOwner = (people: readonly PersonConfig[], number: string) => people.find(p => p.phones.includes(number)) ?? null;
export function hostedManager(person: Pick<PersonConfig, 'manager'>): AgentProfile | null {
  return person.manager && 'provider' in person.manager ? person.manager : null;
}
/** HOME/ID/NAME on the channel hosting the person's Kenaznia; any other channel keeps NAME-CHANNEL, so the two never mix. */
export function hostFolder(person: Pick<PersonConfig, 'home' | 'id' | 'manager'>, channel: ServerConfig['channel'], name: string): string {
  return join(person.home, person.id, hostedManager(person) ? name : `${name}-${channel}`);
}
export interface AgentProfile {
  name: string;                     // display name, e.g. 'Kenaznia'
  provider: ModelProvider;
  model: string;                    // e.g. claude-opus-5-5, gpt-6.1-sol
  thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  systemPrompt: string;             // short base prompt
  contextFiles: string[];           // manager: the person's own context files; worker: AGENTS.md only
  refusalFallbackModels: string[];  // same-provider models a refused context summary is retried on, in order; [] = none
}
function assertProfile(allowedProviders: readonly ModelProvider[], profile: AgentProfile, where: string, path: string): void {
  if (typeof profile.name !== 'string' || typeof profile.model !== 'string' || typeof profile.systemPrompt !== 'string' || !Array.isArray(profile.contextFiles)) throw new Error(`${where} is not a complete agent profile in ${path}`);
  if (!Array.isArray(profile.refusalFallbackModels) || profile.refusalFallbackModels.some(model => typeof model !== 'string' || !model)) throw new Error(`${where}.refusalFallbackModels must be a list of model ids (or []) in ${path}`);
  assertAllowedProvider(allowedProviders, profile.provider);
}
/** parallel: Parallel's search API with the key file at keyPath. openai-codex: the subscription model's built-in web search through each person's own broker (no key). */
export type WebSearchRoute = { provider: 'parallel'; keyPath: string } | { provider: 'openai-codex'; model: string };
export const DEFAULT_WEB_SEARCH = { provider: 'openai-codex' as const, model: 'gpt-6-luna' };
function assertWebSearch(raw: ServerConfig, path: string): void {
  if (!Object.hasOwn(raw, 'webSearch')) raw.webSearch = { ...DEFAULT_WEB_SEARCH };
  const route = raw.webSearch as unknown;
  if (route === null) return;
  const r = route as Record<string, unknown>;
  if (typeof route !== 'object' || Array.isArray(route)) throw new Error(`webSearch must be {provider, keyPath|model} or null in ${path}`);
  if (r.provider === 'openai-codex' && !('model' in r)) r.model = DEFAULT_WEB_SEARCH.model;
  if (Object.keys(r).length !== 2) throw new Error(`webSearch must be {provider, keyPath|model} or null in ${path}`);
  if (r.provider === 'parallel' && typeof r.keyPath === 'string' && r.keyPath.startsWith('/')) return;
  if (r.provider === 'openai-codex' && typeof r.model === 'string' && r.model) {
    assertAllowedProvider(raw.allowedProviders, 'openai-codex');
    const source = JSON.parse(readFileSync(raw.modelsPath, 'utf8'));
    const models: { id: string }[] = (source.catalog?.providers ?? source.providers)?.['openai-codex']?.models ?? [];
    if (!models.some(m => m.id === r.model)) throw new Error(`webSearch.model ${r.model} is not in the openai-codex catalog ${raw.modelsPath}`);
    return;
  }
  throw new Error(`webSearch must be {"provider":"parallel","keyPath":ABSOLUTE_PATH} or {"provider":"openai-codex","model":ID} in ${path}`);
}
export interface ServerConfig {
  allowedProviders: ModelProvider[]; // Explicit host policy; disallowed models never launch or fall back.
  channel: 'beta' | 'production';
  listen: string;                   // unix socket path or host:port
  databaseUrl: string;              // postgresql:///kenan_beta?host=/run/kenan/pg
  dataDir: string;                  // /var/lib/kenan/<channel>: sessions/, files/
  origins: string[];                // allowed Origin values for non-GET requests
  sessionKeyPath: string;           // 32-byte HMAC key
  verifierDir: string;              // /etc/kenan/verifiers (scrypt {salt,digest} per account)
  modelsPath: string;               // Pi models.json catalog (shared-models.json format, baseUrl rewritten per person)
  heartbeatMinutes: number;         // 30
  /** Model families excluded from the agent room stream; mentions still arrive. Default: Luna and Haiku. */
  claudeWorkerReservePercent?: number; // Below this shared Claude pool level only Kenaznias may launch on Claude; unset: 12.
  webRoot: string;                  // built web app (dist/web)
  plansPath?: string;               // Absolute path of the AI plan-prices JSON (example-data/admin/ai-plans.json); left out: the Usage screen shows no plan prices.
  webSearch: WebSearchRoute | null; // Omitted: subscription search on gpt-6-luna. null: explicitly disabled.
  people: PersonConfig[];
  /** Private application links (server/channels/link.ts), local or SSH-forwarded mesh sockets. forwardEvents names remote
   *  people whose old-host event inbox this ONE instance must continue forwarding after they move. */
  link?: { listen: string; siblings: string[]; forwardEvents?: string[] };
  /** When an agent's bound cloud browser stops itself (server/extensions/browser.ts): minutes after its last browser command,
   *  and minutes idle once the agent's turn has ended. Left out: the household policy, 5 and 1. */
  cloudBrowserIdleStop?: { idleMinutes: number; afterTurnMinutes: number };
}

function assertManagerPlacement(allowedProviders: readonly ModelProvider[], person: PersonConfig, path: string): void {
  const manager = person.manager as unknown;
  if (manager === null) return;
  if (typeof manager !== 'object' || manager === undefined) throw new Error(`people[${person.id}].manager must be a profile, {"elsewhere": URL} or null in ${path}`);
  if ('elsewhere' in manager) {
    const url = (manager as { elsewhere: unknown }).elsewhere;
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+/.test(url) || Object.keys(manager).length !== 1) throw new Error(`people[${person.id}].manager.elsewhere must be the app URL of the channel hosting this person's manager in ${path}`);
    return;
  }
  assertProfile(allowedProviders, manager as AgentProfile, `people[${person.id}].manager`, path);
}

/** The same validation is used at startup and by root's live enrollment socket. */
export function validatePerson(raw: ServerConfig, person: PersonConfig, path: string): PersonConfig {
  if (!person || typeof person !== 'object' || typeof person.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(person.id)) throw new Error(`people[].id must be a person id in ${path}`);
  if ('isolated' in person && person.isolated !== true) throw new Error(`people[${person.id}].isolated must be true or left out in ${path}`);
  if ('budget' in person) {
    const b = person.budget;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join() !== 'claude,dailyUsd' || typeof b.dailyUsd !== 'number' || !Number.isFinite(b.dailyUsd) || b.dailyUsd <= 0 || b.dailyUsd > 1000 || typeof b.claude !== 'boolean') throw new Error(`people[${person.id}].budget must be exactly {dailyUsd: a finite number greater than 0 and at most 1000, claude: boolean} in ${path}`);
    if (!b.claude && [hostedManager(person), person.worker].some(p => p && (p.provider === 'anthropic' || p.model?.startsWith('claude-') || p.refusalFallbackModels?.some(m => m.startsWith('claude-'))))) throw new Error(`claude_not_enabled_for_person: people[${person.id}] cannot use a Claude manager or worker profile in ${path}`);
  }
  if ('swarmMaxActive' in person && (!Number.isSafeInteger(person.swarmMaxActive) || person.swarmMaxActive! < 1)) throw new Error(`people[${person.id}].swarmMaxActive must be a positive safe integer, or left out (${DEFAULT_SWARM_MAX_ACTIVE}) in ${path}`);
  if (typeof person.alertDir !== 'string' && person.alertDir !== null) throw new Error(`people[${person.id}].alertDir must be a path or null in ${path}`);
  if ('identityBriefRenderer' in person && (typeof person.identityBriefRenderer !== 'string' || !person.identityBriefRenderer.startsWith('/'))) throw new Error(`people[${person.id}].identityBriefRenderer must be an absolute executable path, or left out (identity placeholders unavailable) in ${path}`);
  if ('threadsFile' in person && (typeof person.threadsFile !== 'string' || !person.threadsFile.startsWith('/'))) throw new Error(`people[${person.id}].threadsFile must be an absolute path to threads.json, or left out (no waiting-on-others list) in ${path}`);
  if (typeof person.signalStore !== 'string' && person.signalStore !== null) throw new Error(`people[${person.id}].signalStore must be a path or null in ${path}`);
  if ((typeof person.pronouns !== 'string' || !/^\w+\/\w+$/.test(person.pronouns)) && person.pronouns !== null) throw new Error(`people[${person.id}].pronouns must be like "she/her" or null in ${path}`);
  if (!Array.isArray(person.phones) || person.phones.some(n => typeof n !== 'string' || !E164.test(n))) throw new Error(`people[${person.id}].phones must be a list of E.164 numbers like "+12025550122" (or []) in ${path}`);
  if (!Array.isArray(person.peers) || person.peers.some(p => typeof p?.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.about !== 'string' || ('relay' in p && p.relay !== true) || Object.keys(p).some(k => !['id', 'name', 'about', 'relay'].includes(k)))
    || new Set(person.peers.map(p => p.id)).size !== person.peers.length) throw new Error(`people[${person.id}].peers must be a list of distinct {id (a-z0-9-), name, about, relay?: true} (or []) in ${path}`);
  if (person.peers.length && !hostedManager(person)) throw new Error(`people[${person.id}].peers needs the person's Kenaznia on this channel (manager is not hosted here) in ${path}`);
  if ('composerVoice' in person && (person.composerVoice !== true || !person.extensions.includes('voice'))) throw new Error(`people[${person.id}].composerVoice must be true with the voice extension, or left out (no composer voice button) in ${path}`);
  if ('background' in person && !(BACKGROUNDS as readonly unknown[]).includes(person.background)) throw new Error(`people[${person.id}].background must be one of ${BACKGROUNDS.map(b => `"${b}"`).join(', ')}, or left out (no background) in ${path}`);
  if (person.clientHome !== undefined) {
    let url: URL; try { url = new URL(person.clientHome); } catch { throw new Error(`people[${person.id}].clientHome must be an https origin`); }
    if (url.protocol !== 'https:' || url.origin !== person.clientHome || !person.manager || !('elsewhere' in person.manager) || person.manager.elsewhere !== person.clientHome) throw new Error(`people[${person.id}].clientHome must equal manager.elsewhere and be an exact https origin`);
  }
  if ('trayTiles' in person && !isTray(person.trayTiles)) throw new Error(`people[${person.id}].trayTiles must be distinct names from ${TRAY_TILES.join(', ')}, or left out (every tile) in ${path}`);
  if ('bubbleColor' in person && !isBubbleColor(person.bubbleColor)) throw new Error(`people[${person.id}].bubbleColor must be "#RRGGBB" dark enough for white text (contrast ${BUBBLE_MIN_CONTRAST}:1 or more), or left out (the app's bubble colour) in ${path}`);
  assertProfile(raw.allowedProviders, person.worker, `people[${person.id}].worker`, path);
  assertManagerPlacement(raw.allowedProviders, person, path);
  assertAfterHours(person, path);
  assertHealth(person, path);
  if ('channels' in person) {
    if (!person.extensions.includes('channels')) throw new Error(`people[${person.id}].channels is set but the channels extension is not in extensions in ${path}`);
    const parsed = parseChannels(person, person.channels);
    if (!parsed.ok) throw new Error(`people[${person.id}].${parsed.error} in ${path}`);
  }
  return person;
}

export function loadConfig(path: string): ServerConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ServerConfig;
  if (!raw.channel || !raw.listen || !raw.databaseUrl || !Array.isArray(raw.people)) throw new Error(`Invalid config ${path}`);
  if (!Array.isArray(raw.allowedProviders) || raw.allowedProviders.length === 0 || raw.allowedProviders.some(p => p !== 'anthropic' && p !== 'openai-codex' && p !== 'openrouter' && p !== 'xai' && p !== 'nvidia' && p !== 'google-cli')) throw new Error(`Invalid allowedProviders in ${path}`);
  if ('claudeWorkerReservePercent' in raw && (typeof raw.claudeWorkerReservePercent !== 'number' || !Number.isFinite(raw.claudeWorkerReservePercent) || raw.claudeWorkerReservePercent < 0 || raw.claudeWorkerReservePercent > 100)) throw new Error(`claudeWorkerReservePercent must be a number from 0 to 100, or left out (12) in ${path}`);
  for (const person of raw.people) validatePerson(raw, person, path);
  if (new Set(raw.people.map(p => p.id)).size !== raw.people.length) throw new Error(`people must have distinct ids in ${path}`);
  const owners = new Map<string, string>();
  for (const person of raw.people) for (const n of person.phones) {
    const other = owners.get(n);
    if (other) throw new Error(`phone ${n} is listed for both people[${other}] and people[${person.id}] in ${path}; a number belongs to one person`);
    owners.set(n, person.id);
  }
  const tokens = raw.people.flatMap(p => [...p.afterHours?.devices ?? [], ...p.health?.devices ?? []].map(d => d.tokenSha256));
  if (new Set(tokens).size !== tokens.length) throw new Error(`device tokens (afterHours, health) must be distinct across people and extensions in ${path}`);
  assertWebSearch(raw, path);
  if ('plansPath' in raw && (typeof raw.plansPath !== 'string' || !raw.plansPath.startsWith('/'))) throw new Error(`plansPath must be an absolute path to the AI plan-prices JSON, or left out (no plan prices on the Usage screen) in ${path}`);
  if ('cloudBrowserIdleStop' in raw) {
    const c = raw.cloudBrowserIdleStop as unknown as Record<string, unknown> | null;
    const minutes = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 240;
    if (typeof c !== 'object' || c === null || Object.keys(c).sort().join() !== 'afterTurnMinutes,idleMinutes' || !minutes(c.idleMinutes) || !minutes(c.afterTurnMinutes) || (c.afterTurnMinutes as number) > (c.idleMinutes as number))
      throw new Error(`cloudBrowserIdleStop must be {"idleMinutes": N, "afterTurnMinutes": M} with whole minutes 1 ≤ M ≤ N ≤ 240, or left out (5 and 1) in ${path}`);
  }
  if ('link' in raw) {
    const l = raw.link as unknown as Record<string, unknown>;
    if (!l || typeof l.listen !== 'string' || !l.listen.startsWith('/') || !Array.isArray(l.siblings) || l.siblings.some(x => typeof x !== 'string' || !x.startsWith('/') || x === l.listen) || Object.keys(l).some(k => !['listen', 'siblings', 'forwardEvents'].includes(k)) || (l.forwardEvents !== undefined && (!Array.isArray(l.forwardEvents) || l.forwardEvents.some(id => typeof id !== 'string' || !raw.people.some(p => p.id === id && p.manager && 'elsewhere' in p.manager))))) throw new Error(`link must be {"listen": SOCKET_PATH, "siblings": [SOCKET_PATH, ...], optional "forwardEvents": [ELSEWHERE_PERSON_ID, ...]} or left out in ${path}`);
  }
  return raw;
}
