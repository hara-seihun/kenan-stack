// Server configuration: /etc/kenan/<channel>.json. Owned by lead.
import { readFileSync } from 'node:fs';

export type ModelProvider = 'anthropic' | 'openai-codex';

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
  signalStore: string | null;       // signal-receiver's receive.sqlite3 for this person's linked Signal account; null = no Signal wakes
  pronouns: string | null;          // e.g. 'she/her'; null = not known, so agents speaking about the person use no gendered words
  extensionConfigPath?: string;       // existing per-account extension settings
  extensions: string[];             // e.g. ['mail','voice','calendar','browser']
  manager: ManagerPlacement;        // where this person's Kenaznia runs
  peers: PeerConfig[];              // Kenaznias on other hosts this person's agents can message; [] = none
  worker: AgentProfile;             // default worker profile
}
/** Another Kenaznia: another person's on this host (possibly on the other channel) or one on another host. id: how this side names it (the peer tool's `peer`, the relay's `peer` field); name and about: what agents are told about it. */
export interface PeerConfig { id: string; name: string; about: string }
/** A profile hosts the person's Kenaznia on this channel; `elsewhere` names the app URL of the channel that hosts it; null: the person has workers only. */
export type ManagerPlacement = AgentProfile | { elsewhere: string } | null;
export function hostedManager(person: PersonConfig): AgentProfile | null {
  return person.manager && 'provider' in person.manager ? person.manager : null;
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
  webRoot: string;                  // built web app (dist/web)
  parallelApiKeyPath: string | null;// web_search provider credential
  people: PersonConfig[];
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

export function loadConfig(path: string): ServerConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ServerConfig;
  if (!raw.channel || !raw.listen || !raw.databaseUrl || !Array.isArray(raw.people)) throw new Error(`Invalid config ${path}`);
  if (!Array.isArray(raw.allowedProviders) || raw.allowedProviders.length === 0 || raw.allowedProviders.some(p => p !== 'anthropic' && p !== 'openai-codex')) throw new Error(`Invalid allowedProviders in ${path}`);
  for (const person of raw.people) {
    if (typeof person.alertDir !== 'string' && person.alertDir !== null) throw new Error(`people[${person.id}].alertDir must be a path or null in ${path}`);
    if (typeof person.signalStore !== 'string' && person.signalStore !== null) throw new Error(`people[${person.id}].signalStore must be a path or null in ${path}`);
    if ((typeof person.pronouns !== 'string' || !/^\w+\/\w+$/.test(person.pronouns)) && person.pronouns !== null) throw new Error(`people[${person.id}].pronouns must be like "she/her" or null in ${path}`);
    if (!Array.isArray(person.peers) || person.peers.some(p => typeof p?.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.about !== 'string' || Object.keys(p).length !== 3)
      || new Set(person.peers.map(p => p.id)).size !== person.peers.length) throw new Error(`people[${person.id}].peers must be a list of distinct {id (a-z0-9-), name, about} (or []) in ${path}`);
    if (person.peers.length && !hostedManager(person)) throw new Error(`people[${person.id}].peers needs the person's Kenaznia on this channel (manager is not hosted here) in ${path}`);
    assertProfile(raw.allowedProviders, person.worker, `people[${person.id}].worker`, path);
    assertManagerPlacement(raw.allowedProviders, person, path);
  }
  return raw;
}
