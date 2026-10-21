// The last screen this device showed, kept so the next open draws it at once while the stream connects.
// It is shown as not yet live (the topbar says Connecting…) and is replaced by the stream's `ready` snapshot.
// A screen belongs to the build that saved it: another build's (older or newer contract) is discarded, never drawn.
import type { Bootstrap, StartupPage } from '../shared/contract.js';
import { PAGE_SIZE } from './history.js';

const SNAPSHOT_KEY = 'kenan-startup-v3';
/** Read by index.html's early stream script before the app loads: the conversation to open on. */
export const OPEN_KEY = 'kenan-open';

export type Snapshot = { bootstrap: Bootstrap; page: StartupPage | null };
/** The running build's identity (its entry script); null when unknown (a dev server), which keeps no saved screen. */
export type Build = string | null;
export type SnapshotRead = { kind: 'none' } | { kind: 'found'; snapshot: Snapshot } | { kind: 'invalid'; reason: string };

type Saved = Snapshot & { build: string };
const isSaved = (value: unknown): value is Saved => {
  const v = value as Partial<Saved> | null;
  return !!v && typeof v === 'object' && typeof v.build === 'string' && !!v.bootstrap && typeof v.bootstrap === 'object' && Array.isArray(v.bootstrap.conversations) && Array.isArray(v.bootstrap.agents)
    && (v.page === null || (!!v.page && typeof v.page.conversationId === 'string' && Array.isArray(v.page.page?.messages)));
};

export function readSnapshot(storage: Storage, build: Build): SnapshotRead {
  if (build === null) return { kind: 'none' };
  const raw = storage.getItem(SNAPSHOT_KEY);
  if (raw === null) return { kind: 'none' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { storage.removeItem(SNAPSHOT_KEY); return { kind: 'invalid', reason: String(e) }; }
  if (!isSaved(parsed)) { storage.removeItem(SNAPSHOT_KEY); return { kind: 'invalid', reason: 'unexpected shape' }; }
  if (parsed.build !== build) { storage.removeItem(SNAPSHOT_KEY); return { kind: 'invalid', reason: `saved by build ${parsed.build}, running ${build}` }; }
  return { kind: 'found', snapshot: { bootstrap: parsed.bootstrap, page: parsed.page } };
}

/** Keeps the newest page of the open conversation. A window scrolled back from the newest messages is not a
 *  startup screen, so it keeps the previous snapshot; so does full or unavailable storage. */
export function writeSnapshot(storage: Storage, build: Build, snapshot: Snapshot): { ok: true; written: boolean } | { ok: false; reason: string } {
  const open = snapshot.page;
  if (build === null || open?.page.hasNewer) return { ok: true, written: false };
  const page: StartupPage | null = open && { conversationId: open.conversationId, page: {
    messages: open.page.messages.slice(-PAGE_SIZE), hasOlder: open.page.hasOlder || open.page.messages.length > PAGE_SIZE, hasNewer: false,
  } };
  try { storage.setItem(SNAPSHOT_KEY, JSON.stringify({ build, bootstrap: snapshot.bootstrap, page } satisfies Saved)); return { ok: true, written: true }; }
  catch (e) { return { ok: false, reason: String(e) }; }
}

export function clearSnapshot(storage: Storage) { storage.removeItem(SNAPSHOT_KEY); storage.removeItem(OPEN_KEY); }
