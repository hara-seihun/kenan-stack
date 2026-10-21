import type { FileAccess, KenanTool } from '../types.js';

/**
 * Pi runs the tool calls of one assistant message concurrently, but a model writes them in the order it means them:
 * a Bash that saves crop.png followed by a Read of crop.png raced, and the Read failed with ENOENT before the Bash ran
 * (manager:alice 2026-10-19 16:03Z; a Write then `python3 thatfile.py` the same way). Calls that touch the owner's files
 * therefore start in message order: a writer after every earlier file call, a reader after every earlier writer, so
 * independent reads (and calls that touch no files) still run together. Pi invokes `execute` synchronously in message
 * order, and a turn's batch settles before the next one starts, so one gate per agent session orders each batch.
 */
export function orderedByFiles(tools: KenanTool[]): KenanTool[] {
  let everything: Promise<void> = Promise.resolve();
  let writes: Promise<void> = Promise.resolve();
  const after = <T>(files: Exclude<FileAccess, 'none'>, run: () => Promise<T>): Promise<T> => {
    const started = (files === 'writes' ? everything : writes).then(run);
    const settled = started.then(() => {}, () => {});
    everything = Promise.all([everything, settled]).then(() => {});
    if (files === 'writes') writes = everything;
    return started;
  };
  return tools.map(tool => {
    const files = tool.files;
    switch (files) {
      case 'none': return tool;
      case 'reads': case 'writes': return { ...tool, execute: (...args: Parameters<KenanTool['execute']>) => after(files, () => tool.execute(...args)) };
    }
  });
}
