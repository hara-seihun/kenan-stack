import { useSyncExternalStore } from 'react';

export type EnterAction = 'send' | 'newline';

const touchQuery = '(pointer: coarse)';

function subscribe(change: () => void) {
  const query = window.matchMedia(touchQuery);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}

const snapshot = (): EnterAction => window.matchMedia(touchQuery).matches ? 'newline' : 'send';

export const useEnterAction = () => useSyncExternalStore(subscribe, snapshot);
