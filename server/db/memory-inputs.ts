import type { AgentInput, Store, StoredInput } from '../types.js';

/** The stored-input part of Store kept in memory, for runtime tests that fake the rest of the store. */
export function memoryInputs(): Pick<Store, 'storeInput' | 'storedInputs' | 'deleteInputs' | 'moveInput'> & { inputs(): AgentInput[] } {
  let next = 0;
  const keys = new Set<string>();
  const rows = new Map<string, { input: AgentInput; at: number }>();
  return {
    async storeInput(input) { if (input.deliveryKey !== undefined && keys.has(input.deliveryKey)) return null; const copy = structuredClone(input); const id = String(++next); rows.set(id, { input: copy, at: Date.now() }); if (input.deliveryKey !== undefined) keys.add(input.deliveryKey); return id; },
    async storedInputs(): Promise<StoredInput[]> { return [...rows].map(([id, row]) => ({ id, input: structuredClone(row.input), at: row.at })); },
    async deleteInputs(ids) { for (const id of ids) rows.delete(id); },
    async moveInput(from, input) { const moved = rows.get(from); if (!moved || !rows.delete(from)) return null; const id = String(++next); rows.set(id, { input: structuredClone(input), at: moved.at }); return id; },
    inputs: () => [...rows.values()].map(row => row.input),
  };
}
