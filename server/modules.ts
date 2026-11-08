// Optional feature modules, one folder each under modules/ (source) and dist/modules/ (build). A deployment includes a module
// by having its folder in the build (deploy/prepare-build.sh prunes the folders its host does not list in /etc/kenan/modules)
// and enables it for a person by listing the module's id in their `extensions`. Core never imports a module statically: it
// loads whatever folders the build contains, and a person's extension list naming a module the build lacks is refused at startup.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TSchema } from 'typebox';
import type { PersonConfig } from './config.js';
import type { ConversationSummary } from '../shared/contract.js';
import type { Deps, Extension, RoomPatch, ToolContext } from './types.js';

/** What a module adds to one of core's tools for the people who have the module: more actions with their parameters and docs. */
export interface ToolAddition<Helpers = undefined> {
  /** Appended to the tool's description. */
  description: string;
  actions: readonly string[];
  properties: Record<string, TSchema>;
  run(action: string, args: Record<string, unknown>, ctx: ToolContext, helpers: Helpers): Promise<unknown>;
}
/** The rooms tool's own helpers, handed to a module's actions so they edit rooms exactly as the tool's own actions do. */
export interface RoomHelpers {
  owner: string;
  /** The room a reference (full id or unique prefix) names, one the person is in. */
  room(ref: string | null | undefined): Promise<ConversationSummary>;
  /** Applies a patch to the room and announces it; answers the tool's room summary. */
  change(room: ConversationSummary, patch: RoomPatch): Promise<unknown>;
}
export interface RoomsAddition extends ToolAddition<RoomHelpers> {
  /** Extra fields of a room's summary in the tool's answers. */
  summary(c: ConversationSummary): Record<string, unknown>;
  /** Extra fields for `create` (a new chat's group, project) from the call's arguments. */
  create(args: Record<string, unknown>, helpers: RoomHelpers): Promise<{ groupId: string | null; patch: RoomPatch }>;
}

export interface Module {
  /** Matches the entry in people[].extensions that turns the module on for a person. */
  id: string;
  extensions: Extension[];
  additions?: { todos?: ToolAddition; rooms?: RoomsAddition };
  /** Whether background answers for this person go to the chat they were asked from (server/agents/origin.ts). */
  routesByChat?(deps: Pick<Deps, 'store'>, person: PersonConfig): Promise<boolean>;
}

let loaded: Module[] = [];

/** Loads every module folder the build contains. */
export async function loadModules(root = new URL('../modules', import.meta.url).pathname): Promise<Module[]> {
  const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() : [];
  loaded = [];
  for (const id of ids) {
    // The build holds compiled index.js; a source checkout (tests, tsx) holds index.ts.
    const entry = ['index.js', 'index.ts'].map(f => join(root, id, 'server', f)).find(existsSync);
    if (!entry) continue;
    const found = (await import(pathToFileURL(entry).href) as { module: Module }).module;
    if (found.id !== id) throw new Error(`module_id_mismatch: ${entry} declares ${found.id}`);
    loaded.push(found);
  }
  return loaded;
}
export const loadedModules = (): readonly Module[] => loaded;
export const withModule = (person: PersonConfig, ...ids: string[]): Module[] => loaded.filter(m => person.extensions.includes(m.id) && (ids.length === 0 || ids.includes(m.id)));
