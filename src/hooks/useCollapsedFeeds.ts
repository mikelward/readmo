import { useCallback, useSyncExternalStore } from 'react';
import type { FeedId } from '../lib/types';
import { COLLAPSED_FEEDS_KEY } from '../lib/userCache';

// Per-device set of collapsed feed sections for the group-by-feed view, persisted
// in localStorage as a JSON array of feed ids and shared across tabs and every
// mounted component via an external store (same shape as the reading prefs).
// A collapsed feed's header stays visible but its rows are hidden; the choice
// survives reloads and navigation between grouped views.
//
// The storage key lives in userCache.ts so clearUserCaches purges it on account
// changes — the set is subscription-derived, so it must not leak across accounts
// on a shared device (guardrail #8).

export { COLLAPSED_FEEDS_KEY };
const CHANGE_EVENT = 'readmo:collapsed-feeds-changed';

// Cached snapshot so useSyncExternalStore gets an Object.is-stable reference when
// the underlying stored string hasn't changed — parsing a fresh Set on every
// getSnapshot call would loop the store forever.
let cachedRaw: string | null = null;
let cachedSet = new Set<FeedId>();

function readSet(): Set<FeedId> {
  if (typeof window === 'undefined') return cachedSet;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(COLLAPSED_FEEDS_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedSet;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    cachedSet = new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    cachedSet = new Set();
  }
  return cachedSet;
}

function writeSet(next: Set<FeedId>): void {
  try {
    window.localStorage.setItem(COLLAPSED_FEEDS_KEY, JSON.stringify([...next]));
  } catch {
    // ignore storage failures — the toggle just reverts on next load
  }
  // Notify same-tab subscribers; getSnapshot re-reads the now-updated string and
  // produces a fresh Set reference. Cross-tab updates arrive via 'storage'.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

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
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener(CHANGE_EVENT, cb);
    window.addEventListener('storage', cb);
    return () => {
      window.removeEventListener(CHANGE_EVENT, cb);
      window.removeEventListener('storage', cb);
    };
  }, []);

  const collapsed = useSyncExternalStore(subscribe, readSet, readSet);

  const toggle = useCallback((feedId: FeedId) => {
    const next = new Set(readSet());
    if (next.has(feedId)) next.delete(feedId);
    else next.add(feedId);
    writeSet(next);
  }, []);

  const collapseAll = useCallback((feedIds: FeedId[]) => {
    const next = new Set(readSet());
    for (const id of feedIds) next.add(id);
    writeSet(next);
  }, []);

  const expand = useCallback((feedIds: FeedId[]) => {
    const cur = readSet();
    if (!feedIds.some((id) => cur.has(id))) return; // nothing collapsed in range
    const next = new Set(cur);
    for (const id of feedIds) next.delete(id);
    writeSet(next);
  }, []);

  return {
    collapsed,
    isCollapsed: (feedId) => collapsed.has(feedId),
    toggle,
    collapseAll,
    expand,
  };
}

/** Test-only: drop the module-level snapshot cache so `localStorage.clear()`
 * alone fully resets state between cases. */
export function resetCollapsedFeedsCacheForTest(): void {
  cachedRaw = null;
  cachedSet = new Set();
}
