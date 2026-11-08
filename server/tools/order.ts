import type { Access, KenanTool } from '../types.js';

type Gate = { before(access: Exclude<Access, 'none'>, key?: string): Promise<void>; record(access: Exclude<Access, 'none'>, settled: Promise<void>, key?: string): void };

function gate(pending: Promise<void> = Promise.resolve()): Gate {
  let everything = pending;
  let writes = pending;
  let group: { key: string; before: Promise<void> } | undefined;
  return {
    before: (access, key) => access === 'writes'
      ? (key !== undefined && group?.key === key ? group.before : everything)
      : writes,
    record: (access, settled, key) => {
      if (access === 'writes' && key !== undefined) {
        if (group?.key !== key) group = { key, before: everything };
      } else group = undefined;
      everything = Promise.all([everything, settled]).then(() => {});
      if (access === 'writes') writes = everything;
    },
  };
}

/** A call that took longer than this in all is logged with how long it waited for earlier calls and how long it ran. */
export const SLOW_CALL_MS = 5_000;
export type CallTiming = { tool: string; action: string | null; waitedMs: number; ranMs: number; ok: boolean };

/**
 * Pi runs the tool calls of one assistant message concurrently, but a model writes them in the order it means them.
 * A Bash that saves crop.png followed by a Read of crop.png raced, and the Read failed with ENOENT before the Bash ran
 * (manager:alice 2026-10-19 16:03Z). A goals update reopening a goal followed by a workers spawn for it raced the same
 * way, and the spawn failed with "Open goal not found" (manager:alice, 15 times Oct 18–24; Acme too). So calls that
 * touch the owner's files, and separately calls that touch the person's records, start in message order: a writer
 * after every earlier call of its kind, a reader after every earlier writer, and independent reads (and calls touching
 * neither) still run together. Contiguous record writes with the same explicit parallel key also run together. Pi invokes `execute` synchronously in message order, and a turn's batch settles before
 * the next one starts, so one pair of gates per agent session orders each batch.
 */
export function orderedCalls(tools: KenanTool[], slow: (timing: CallTiming) => void = () => {}, pending?: { files: Promise<void>; records: Promise<void> }): KenanTool[] {
  const files = gate(pending?.files), records = gate(pending?.records);
  return tools.map(tool => {
    const timed = (...args: Parameters<KenanTool['execute']>) => (waited: Promise<unknown>) => {
      const asked = performance.now();
      let ran = asked;
      const action = typeof (args[1] as { action?: unknown } | undefined)?.action === 'string' ? (args[1] as { action: string }).action : null;
      const done = waited.then(() => { ran = performance.now(); return tool.execute(...args); });
      const report = (ok: boolean) => { const end = performance.now(); if (end - asked > SLOW_CALL_MS) slow({ tool: tool.name, action, waitedMs: Math.round(ran - asked), ranMs: Math.round(end - ran), ok }); };
      done.then(() => report(true), () => report(false));
      return done;
    };
    return { ...tool, execute: (...args: Parameters<KenanTool['execute']>) => {
      const gates = ([[files, tool.files], [records, tool.records]] as const).flatMap(([g, access]) => access === 'none' ? [] : [{ g, access }]);
      const key = tool.records === 'writes' ? tool.parallelRecords?.(args[1]) : undefined;
      const started = timed(...args)(Promise.all(gates.map(({ g, access }) => g.before(access, g === records ? key : undefined))));
      const settled = started.then(() => {}, () => {});
      for (const { g, access } of gates) g.record(access, settled, g === records ? key : undefined);
      return started;
    } };
  });
}
