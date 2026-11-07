// Extension start-up. One extension failing to start (its migration, a config file, a remote service) must not take the
// whole channel down: on 2026-10-25 a phone migration failed on existing rows and Kenan Beta crash-looped for 15 minutes.
// A failed extension is stopped and left out; the channel runs without it, the failure goes to the error log, and each
// person who has the extension hears of it from the system in their manager's conversation.
import { routeBackground } from '../agents/origin.js';
import type { Deps, Extension } from '../types.js';

export type ExtensionStart = { id: string; outcome: 'started' } | { id: string; outcome: 'failed'; error: string };

const explain = (e: unknown) => e instanceof Error ? (e.stack ?? e.message) : String(e);

export async function startExtensions(deps: Deps, extensions: readonly Extension[]): Promise<ExtensionStart[]> {
  const results: ExtensionStart[] = [];
  for (const ext of extensions) {
    const started = Date.now();
    console.log(JSON.stringify({ type: 'extension_starting', extension: ext.id }));
    try {
      await ext.start?.(deps);
      results.push({ id: ext.id, outcome: 'started' });
    } catch (e) {
      const error = explain(e);
      results.push({ id: ext.id, outcome: 'failed', error });
      console.error(JSON.stringify({ type: 'extension_start_failed', extension: ext.id, error }));
      await deps.store.logError(ext.id, `extension_start_failed: ${error}`).catch(() => {});
      await Promise.resolve().then(() => ext.stop?.()).catch(() => {});
    }
    console.log(JSON.stringify({ type: 'extension_start_finished', extension: ext.id, outcome: results.at(-1)!.outcome, ms: Date.now() - started }));
  }
  return results;
}

/** Tells the manager of every person with a failed extension, once the runtime is running. */
export async function raiseFailedExtensions(deps: Deps, results: readonly ExtensionStart[]): Promise<void> {
  for (const result of results) {
    if (result.outcome !== 'failed') continue;
    for (const person of deps.config.people) {
      if (!person.extensions.includes(result.id)) continue;
      const manager = await deps.store.getAgent(`manager:${person.id}`);
      if (!manager || manager.archived) continue;
      deps.runtime.deliver({ agentId: manager.id, kind: 'agent', fromId: 'system', ...await routeBackground(deps, manager, null), text: `extension_start_failed: the ${result.id} extension failed to start on the ${deps.config.channel} channel, so this channel runs without it until it is fixed and the channel restarts. Fix it at the root. Error:\n${result.error.slice(0, 3000)}` });
    }
  }
}
