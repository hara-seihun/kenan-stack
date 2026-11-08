import type { Server } from 'node:http';
import type { AgentRuntime } from './agents/runtime.js';
import type { PersonConfig } from './config.js';
import type { createApp } from './http/app.js';
import type { Deps, Store } from './types.js';

export type Reload = () => Promise<{ ok: true; liveReload: true }>;
export interface LiveServices {
  stop(): Promise<void>;
  wakes: { pauseOwner(ownerId: string): Promise<void> };
}
export interface LiveHost {
  deps: Deps;
  configPath: string;
  server: Server;
  readonly runtime: AgentRuntime;
  setRuntime(runtime: AgentRuntime): void;
  setApp(app: ReturnType<typeof createApp>): void;
  setPeople(people: PersonConfig[]): void;
  replaceStore(store: Store): Promise<void>;
  readonly services: LiveServices;
  setServices(services: LiveServices): void;
  fetch: ReturnType<typeof createApp>['fetch'];
}
export interface LiveGeneration {
  start(configPath: string, reload: Reload): Promise<LiveHost>;
  upgrade(host: LiveHost): Promise<void>;
}
