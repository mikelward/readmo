import { useSyncExternalStore } from 'react';
import type { PersistentStore } from '../lib/persistentStore';

// Read a createPersistentStore value reactively: re-renders on the store's
// same-tab change event and cross-tab `storage` writes, and is SSR-safe
// (getServerSnapshot returns the store's default). The store memoizes its
// snapshot by the raw stored string, so an object/Set value stays Object.is
// stable between reads.
export function usePersistentStore<T>(store: PersistentStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
