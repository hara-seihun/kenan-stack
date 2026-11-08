// Stateful extension services have one owner across live code upgrades. Tools resolve their owner at each call.
import type { Extension, KenanTool, ToolContext, Deps } from './types.js';

type Call = { agentId: string; done: Promise<void>; finish(): void; tool?: KenanTool; executing: boolean };
type Slot = { current: Extension | null; calls: Map<string, Call>; changing?: Promise<void>; desired?: Extension | null };
const stateKey = Symbol.for('kenan.live-extensions');
const shared = globalThis as typeof globalThis & { [stateKey]?: WeakMap<Deps, Map<string, Slot>> };
const owners = shared[stateKey] ??= new WeakMap<Deps, Map<string, Slot>>();
function slotFor(deps: Deps, extension: Extension): Slot {
  let slots = owners.get(deps);
  if (!slots) owners.set(deps, slots = new Map());
  let slot = slots.get(extension.id);
  if (!slot) slots.set(extension.id, slot = { current: extension, calls: new Map() });
  return slot;
}
function callFor(slot: Slot, id: string, agentId: string): Call {
  let call = slot.calls.get(id);
  if (!call) {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    slot.calls.set(id, call = { agentId, done, finish, executing: false });
  }
  return call;
}
function finishCall(slot: Slot, id: string, call: Call): void {
  if (slot.calls.get(id) === call) slot.calls.delete(id);
  call.finish();
}
export function liveExtensionTool(extension: Extension, ctx: ToolContext): KenanTool | undefined {
  const initial = extension.tool?.(ctx);
  if (!initial) return undefined;
  const slot = slotFor(ctx.deps, extension);
  const tools = new Map<Extension, KenanTool>([[extension, initial]]);
  const currentTool = (): KenanTool => {
    const extensionOwner = slot.current;
    if (!extensionOwner) throw new Error(`extension_tool_removed: ${extension.id}`);
    let tool = tools.get(extensionOwner);
    if (!tool) {
      tool = extensionOwner.tool?.(ctx);
      if (!tool) throw new Error(`extension_tool_removed: ${extension.id}`);
      tools.set(extensionOwner, tool);
    }
    return tool;
  };
  return {
    ...initial,
    streamArgs(id, args) {
      const call = callFor(slot, id, ctx.agent.id);
      const send = () => { if (slot.calls.get(id) === call) { call.tool ??= currentTool(); call.tool.streamArgs?.(id, args); } };
      if (slot.changing) void slot.changing.then(send).catch(error => ctx.deps.store.logError('extension_stream', String(error)));
      else send();
    },
    async execute(...args) {
      const id = args[0];
      const call = callFor(slot, id, ctx.agent.id);
      call.executing = true;
      try {
        // Calls already streaming hold their original owner; new calls wait only for that service's handover.
        if (!call.tool) { await slot.changing; call.tool = currentTool(); }
        return await call.tool.execute(...args);
      } finally { finishCall(slot, id, call); }
    },
  };
}
/** Aborted partial tool arguments never execute, but must release their service owner. */
export function releaseLiveExtensionCalls(deps: Deps, agentId: string): void {
  for (const slot of owners.get(deps)?.values() ?? []) for (const [id, call] of slot.calls) {
    if (call.agentId === agentId && !call.executing) finishCall(slot, id, call);
  }
}
/** Returns immediately; each changed service swaps as soon as its own in-flight calls finish. */
export function updateLiveExtensions(deps: Deps, extensions: Extension[], changed: () => void): void {
  const desired = new Map(extensions.map(extension => [extension.id, extension]));
  const ids = new Set([...deps.extensions.map(extension => extension.id), ...desired.keys(), ...owners.get(deps)?.keys() ?? []]);
  for (const id of ids) {
    const old = deps.extensions.find(item => item.id === id);
    const extension = desired.get(id) ?? null;
    const slot = owners.get(deps)?.get(id) ?? slotFor(deps, old ?? extension!);
    if (!old && !slot.changing) slot.current = null;
    slot.desired = extension;
    if (slot.changing || slot.current === slot.desired) continue;
    const work = (async () => {
      while (slot.desired !== undefined && slot.desired !== slot.current) {
        // Only calls which already selected the previous service must finish. New ones wait at the barrier.
        await Promise.all([...slot.calls.values()].filter(call => call.tool).map(call => call.done));
        const next = slot.desired;
        const previous = slot.current;
        if (next === previous) continue;
        await previous?.stop?.();
        try { await next?.start?.(deps); }
        catch (error) { await previous?.start?.(deps); throw error; }
        slot.current = next;
        const index = deps.extensions.findIndex(item => item.id === id);
        if (!next) { if (index >= 0) deps.extensions.splice(index, 1); }
        else if (index < 0) deps.extensions.push(next);
        else deps.extensions[index] = next;
        changed();
      }
    })();
    // Install the barrier synchronously, before a new call can select the previous owner.
    const settled = work.catch(error => deps.store.logError('live_reload_extension', `${id}: ${String(error)}`)).then(() => {});
    slot.changing = settled;
    void settled.then(() => { if (slot.changing === settled) slot.changing = undefined; });
  }
}
