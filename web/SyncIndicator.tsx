import { useSyncExternalStore } from 'react';
import { sync } from './sync.js';
import './sync.css';

/** An overlay in the header's top edge: it never moves or covers the content. Shared by web and Android. */
export function SyncIndicator() {
  const state = useSyncExternalStore(sync.subscribe, sync.read);
  return <span className="sync-indicator" data-state={state} role="status" aria-live="polite" aria-atomic="true"
    title={state === 'offline' ? 'Connection lost. Showing the last received state.' : state === 'failed' ? 'Could not refresh all server data. Showing the last received state.' : 'Showing saved state while fresh server data arrives.'}>
    {state === 'current' ? '' : state === 'offline' ? 'Offline · saved state' : state === 'failed' ? 'Sync failed · saved state' : 'Syncing…'}
  </span>;
}
