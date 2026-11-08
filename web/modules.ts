// Optional feature modules in the browser: one folder each under modules/NAME/web (see server/modules.ts). The build contains
// only the folders its host lists, so an absent module is simply not found here and its extension never reaches the app.
import type { ReactNode } from 'react';
import type { Bootstrap, BuyList, ConversationPatch, ConversationSummary, GoalSummary, Todo, TrayTile } from '../shared/contract.js';
import type { BlankStarted } from './blank.js';
import type { Drafts } from './drafts.js';
import type { History } from './history.js';
import type { Push } from './Settings.js';
import type { Page } from './screens.js';
import type { TodoActions } from './todo/TodoScreen.js';

/** Everything the app shell hands a module that replaces its screens. */
export interface HostProps {
  boot: Bootstrap; setBoot(change: (current: Bootstrap | null) => Bootstrap | null): void; showError(e: unknown): void;
  goals: GoalSummary[]; todos: Todo[] | null; todo: TodoActions; buy: BuyList | null; setBuy(list: BuyList): void;
  page: Page; setPage(page: Page): void; go(page: Page): void; active: string | null; open(id: string): void; openProject(id: string): void;
  /** One of the app's own pages (calendar, goals, usage, search, a chat). */
  detail(page: Page): ReactNode;
  banners: ReactNode; push: Push; wide: boolean; connected: boolean;
  skyMotion: { followsSystem: boolean; toggle(): void } | null; showSky: (() => void) | null;
  checkUpdate: (() => void) | null; chooseTray(tiles: TrayTile[] | null): void; signOut(): void;
  weeklyLeft: number | null; refreshUsage(): void;
  added(c: ConversationSummary): void; update(id: string, patch: ConversationPatch): Promise<ConversationSummary | null>; leave(id: string): Promise<void>;
  showClosed(include: boolean): void; closedLoaded: boolean;
  blank: { started(chat: BlankStarted): void; close(agentId: string): void };
  /** The live chat histories and what the quick panel needs to read and send. */
  history: Record<string, History>; setHistory(change: (all: Record<string, History>) => Record<string, History>): void;
  loadMessages(id: string, mode: 'open' | 'refresh'): Promise<unknown>; drafts: Drafts;
  /** A shared link or an update resume sets the place: the module's first screen must not replace it. */
  keepPlace: boolean;
}
export interface WebModule {
  id: string;
  /** Whether this account's screens are the module's (the app renders `Host` in place of its own). */
  takesOver(boot: Bootstrap): boolean;
  /** Whether the module keeps the selected chat beside this page (desktop). */
  chatBeside(page: Page, wide: boolean): boolean;
  Host(props: HostProps): ReactNode;
}

const found = import.meta.glob<{ module: WebModule }>('../modules/*/web/index.ts');
/** The module of this build that the person's extensions name, or null: none in the build, or none of theirs. */
export const moduleOf = (extensions: readonly { id: string }[]): string | null =>
  Object.keys(found).map(path => path.split('/')[2]!).find(id => extensions.some(e => e.id === id)) ?? null;
export async function loadWebModule(id: string): Promise<WebModule> {
  return (await found[`../modules/${id}/web/index.ts`]!()).module;
}
