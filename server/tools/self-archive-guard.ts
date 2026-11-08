// Acme's restored-worker self-archive guard (worker_report_required), kept in its own module so control.ts stays
// identical to assistant-host's apart from one wrapped export: their promotions rewrite the workers tool often, and the
// guard used to sit inside it and conflict on every incoming merge.
import type { KenanTool, ToolContext } from '../types.js';

export const SELF_ARCHIVE_ANCHOR = 'Restore makes a run available without starting it;';
export const SELF_ARCHIVE_RULE = " a worker cannot archive itself without reporting the current run's outcome (worker_report_required); use report instead;";
export const WORKER_REPORT_REQUIRED = 'worker_report_required: This run has no report. Read any new assignment, then call report with its outcome instead of archiving yourself. A restore starts a new run; the previous run\'s completion does not complete this one.';

/** Whether a workers call archives the calling run itself: no id, or an id (or 8+ character prefix) naming the caller. */
export function archivesSelf(args: { action?: unknown; id?: unknown; ids?: unknown }, selfId: string): boolean {
  if (args.action !== 'archive') return false;
  const names = (value: unknown) => { const ref = String(value).trim(); return ref === '' || ref === selfId || (ref.length >= 8 && selfId.startsWith(ref)); };
  if (Array.isArray(args.ids)) return args.ids.some(names);
  if (args.id === undefined || args.id === null) return true;
  return names(args.id);
}

/**
 * A restored worker may receive a completion event from its previous run before the new assignment arrives. Its stale
 * decision to archive must not silently end the new run without returning an outcome to its parent. Any report on the
 * current run satisfies it, including the one the runtime files from a turn's last words when the turn ends without one.
 */
export function guardSelfArchive(ctx: ToolContext, tools: KenanTool[]): KenanTool[] {
  return tools.map(tool => {
    if (tool.name !== 'workers') return tool;
    const description = tool.description.includes(SELF_ARCHIVE_ANCHOR)
      ? tool.description.replace(SELF_ARCHIVE_ANCHOR, SELF_ARCHIVE_ANCHOR + SELF_ARCHIVE_RULE)
      : `${tool.description} A worker cannot archive itself without reporting the current run's outcome (worker_report_required); use report instead.`;
    const execute: KenanTool['execute'] = async (...call) => {
      const args = (call[1] ?? {}) as { action?: unknown; id?: unknown; ids?: unknown };
      if (ctx.agent.role === 'worker' && archivesSelf(args, ctx.agent.id)) {
        // The run's own record, read now: the context's copy dates from the session's start and misses reports since.
        const self = (await ctx.deps.store.getAgent(ctx.agent.id)) ?? ctx.agent;
        if (self.role === 'worker' && !self.lastReport) throw new Error(WORKER_REPORT_REQUIRED);
      }
      return tool.execute(...call);
    };
    return { ...tool, description, execute } as KenanTool;
  });
}
