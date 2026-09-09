import { useCallback } from 'react';
import type { FeedId } from '../lib/types';
import { COLLAPSED_FEEDS_KEY } from '../lib/userCache';
import { createPersistentStore } from '../lib/persistentStore';
import { usePersistentStore } from './usePersistentStore';

// Per-device set of collapsed feed sections for the group-by-feed view, persisted
// in localStorage as a JSON array of feed ids and shared across tabs and every
// mounted component via createPersistentStore. A collapsed feed's header stays
// visible but its rows are hidden; the choice survives reloads and navigation.
//
// The storage key lives in userCache.ts so clearUserCaches purges it on account
// changes — the set is subscription-derived, so it must not leak across accounts
// on a shared device (guardrail #8).

export { COLLAPSED_FEEDS_KEY };
const CHANGE_EVENT = 'readmo:collapsed-feeds-changed';

const EMPTY: Set<FeedId> = new Set();

const collapsedStore = createPersistentStore<Set<FeedId>>({
  storageKey: COLLAPSED_FEEDS_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: EMPTY,
  parse: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === 'string')
          : [],
      );
    } catch {
      return undefined;
    }
  },
  serialize: (set) => JSON.stringify([...set]),
});

export interface CollapsedFeeds {
  /** The set of currently-collapsed feed ids (stable reference between reads). */
  collapsed: Set<FeedId>;
  isCollapsed: (feedId: FeedId) => boolean;
  /** Toggle one feed's collapsed state. */
  toggle: (feedId: FeedId) => void;
  /** Collapse every given feed (Collapse all over the feeds currently in view). */
  collapseAll: (feedIds: FeedId[]) => void;
  /** Expand the given feeds (Expand all over the feeds currently in view). Feeds
   * outside the list — other folders, not-yet-loaded pages — keep their state. */
  expand: (feedIds: FeedId[]) => void;
}

/** Per-device collapsed-feed-sections state for the group-by-feed view. */
export function useCollapsedFeeds(): CollapsedFeeds {
  const collapsed = usePersistentStore(collapsedStore);

  const toggle = useCallback((feedId: FeedId) => {
    const next = new Set(collapsedStore.get());
    if (next.has(feedId)) next.delete(feedId);
    else next.add(feedId);
    collapsedStore.set(next);
  }, []);

  const collapseAll = useCallback((feedIds: FeedId[]) => {
    const next = new Set(collapsedStore.get());
    for (const id of feedIds) next.add(id);
    collapsedStore.set(next);
  }, []);

  const expand = useCallback((feedIds: FeedId[]) => {
    const cur = collapsedStore.get();
    if (!feedIds.some((id) => cur.has(id))) return; // nothing collapsed in range
    const next = new Set(cur);
    for (const id of feedIds) next.delete(id);
    collapsedStore.set(next);
  }, []);

  return {
    collapsed,
    isCollapsed: (feedId) => collapsed.has(feedId),
    toggle,
    collapseAll,
    expand,
  };
}

/** Test-only: drop the store's parse memo so `localStorage.clear()` alone fully
 * resets state between cases. */
export function resetCollapsedFeedsCacheForTest(): void {
  collapsedStore.resetForTest();
}
