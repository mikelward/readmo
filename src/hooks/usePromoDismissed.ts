import { useCallback } from 'react';
import {
  createPersistentStore,
  type PersistentStore,
} from '../lib/persistentStore';
import { usePersistentStore } from './usePersistentStore';

// Per-device dismissal flags for promotional / onboarding bars. Once a bar is
// dismissed it stays gone on that device (localStorage), surviving reloads.
// Every mounted copy of a bar — and other tabs — react to a dismissal immediately.

const KEY_PREFIX = 'readmo:promo-dismissed:';
const CHANGE_EVENT = 'readmo:promo-dismissed-changed';

function storageKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

// One store per promo id (they all share CHANGE_EVENT; each store re-reads its
// own key on the signal, so an unrelated id's snapshot stays Object.is-stable
// and that consumer doesn't re-render).
const stores = new Map<string, PersistentStore<boolean>>();

function storeFor(id: string): PersistentStore<boolean> {
  let store = stores.get(id);
  if (!store) {
    store = createPersistentStore<boolean>({
      storageKey: storageKey(id),
      changeEvent: CHANGE_EVENT,
      defaultValue: false,
      parse: (raw) => raw === '1',
      serialize: (value) => (value ? '1' : '0'),
    });
    stores.set(id, store);
  }
  return store;
}

/** Tracks whether a one-off promo bar (`id`) has been dismissed on this device.
 * Returns the current flag plus a `dismiss` that hides it for good. */
export function usePromoDismissed(id: string): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const store = storeFor(id);
  const dismissed = usePersistentStore(store);
  const dismiss = useCallback(() => store.set(true), [store]);
  return { dismissed, dismiss };
}

/** Test-only: drop the in-memory promo stores so a test can start from a clean
 * slate. Pair with `localStorage.clear()` to also reset the persisted flag. */
export function resetPromoDismissedCacheForTest(): void {
  stores.clear();
}
