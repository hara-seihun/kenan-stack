// Existing request/tool closures keep this one store identity while new calls use the latest implementation.
import type { Store } from './types.js';

export function liveStore(initial: Store): { store: Store; replaceStore(next: Store): Promise<void> } {
  let current = { store: initial, calls: new Set<Promise<unknown>>() };
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const store = new Proxy(initial, {
    get(_target, property) {
      const value = Reflect.get(current.store, property);
      if (typeof value !== 'function') return value;
      let method = methods.get(property);
      if (!method) {
        method = (...args) => {
          const selected = current;
          const result = Reflect.get(selected.store, property).apply(selected.store, args);
          if (!result || typeof result.then !== 'function') return result;
          const done = Promise.resolve(result).finally(() => selected.calls.delete(done));
          selected.calls.add(done);
          return done;
        };
        methods.set(property, method);
      }
      return method;
    },
  });
  return { store, async replaceStore(next) {
    const previous = current;
    current = { store: next, calls: new Set() };
    await Promise.allSettled([...previous.calls]);
    await previous.store.close();
  } };
}
