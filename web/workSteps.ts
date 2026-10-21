// Per-device choice to fold an agent's tool calls and thinking into one small line between messages.
// The default keeps every step shown, so nobody's layout changes unless they choose it.
const KEY = 'kenan.workSteps';

export function readFoldWork(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try { return storage?.getItem(KEY) === 'folded'; } catch { return false; }
}

export function saveFoldWork(fold: boolean, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, fold ? 'folded' : 'shown'); } catch { /* private mode: lasts for this session */ }
}
