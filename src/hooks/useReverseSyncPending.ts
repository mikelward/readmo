import { useSyncExternalStore } from 'react';
import {
  isReverseSyncPending,
  subscribeReverseSyncPending,
} from '../lib/newshackerReverseSyncPending';
import type { ItemId } from '../lib/types';

/**
 * Whether this list item is awaiting reverse-sync resolution after an
 * open-on-newshacker handoff — drives the "syncing" spinner in the row's right
 * slot until the next reverse pull resolves it. Backed by the sessionStorage
 * store so it survives the same-tab hop to newshacker.app and back.
 */
export function useReverseSyncPending(id: ItemId): boolean {
  return useSyncExternalStore(
    subscribeReverseSyncPending,
    () => isReverseSyncPending(id),
    () => false,
  );
}
