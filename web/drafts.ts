import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

type Values = Record<string, string>;

/** Drafts are shared by the normal composer, quick panel, dictation and Android sharing. Only the fields
 * showing the changed chat subscribe: a keystroke must not redraw the app or its conversation history. */
export function createDrafts(initial: Values) {
  let values = initial;
  const listeners = new Map<string, Set<() => void>>();
  const set: Dispatch<SetStateAction<Values>> = change => {
    const next = typeof change === 'function' ? change(values) : change;
    const previous = values;
    values = next;
    for (const [id, callbacks] of listeners) {
      if ((previous[id] ?? '') !== (next[id] ?? '')) for (const callback of callbacks) callback();
    }
  };
  return {
    get: () => values,
    set,
    subscribe(id: string, callback: () => void) {
      let callbacks = listeners.get(id);
      if (!callbacks) listeners.set(id, callbacks = new Set());
      callbacks.add(callback);
      return () => { callbacks.delete(callback); if (!callbacks.size) listeners.delete(id); };
    },
  };
}
export type Drafts = ReturnType<typeof createDrafts>;
export function useDraft(drafts: Drafts, id: string): string {
  return useSyncExternalStore(callback => drafts.subscribe(id, callback), () => drafts.get()[id] ?? '');
}
