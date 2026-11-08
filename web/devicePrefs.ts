// Per-device two-way choices kept in localStorage. Unset means the first value (the layout nobody chose to change);
// storage that throws (private mode) keeps the choice for this session only.
type Storage2 = Pick<Storage, 'getItem' | 'setItem'> | undefined;

function devicePref(key: string, off: string, on: string) {
  return {
    read(storage: Storage2 = globalThis.localStorage): boolean { try { return storage?.getItem(key) === on; } catch { return false; } },
    save(value: boolean, storage: Storage2 = globalThis.localStorage): void { try { storage?.setItem(key, value ? on : off); } catch { /* session only */ } },
  };
}

/** Hide the Classic sidebar on desktop (Dave 2026-10-23); phones keep their slide-in menu. */
export const sidebarHiddenPref = devicePref('kenan.sidebar', 'shown', 'hidden');
/** The background art always moves (unset), or stands still while the system asks for reduced motion (Alice 2026-10-25:
 *  her sky looked frozen; a phone's "Remove animations" shouldn't stop art she chose to watch move). */
export const skyMotionPref = devicePref('kenan.skyMotion', 'always', 'system');
