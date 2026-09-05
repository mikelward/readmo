import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import {
  readOpenModeSnapshot,
  subscribeOpenModeSnapshot,
  type OpenModeSnapshot,
  type RowOpenFlag,
} from '../lib/openModeSnapshot';
import type { FeedId, ListLayout } from '../lib/types';

// Per-feed settings a row acts on.
//
// The row-open flags (open mode, mark-done-on-open) come from what the DEVICE
// remembers — lib/openModeSnapshot, read synchronously, because a row's first
// frame is tappable and the query is not synchronous. The per-feed card style
// comes from the `['subscriptions']` query itself, deduped with the drawer /
// Feeds page and re-derived the moment a settings toggle invalidates that key:
// it only affects how a row looks, so having it a moment late costs nothing.

function useSubscriptionRows() {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });
  return data;
}

/** What this device knows about the row-open flags (lib/openModeSnapshot). */
function useOpenModeSnapshot(): OpenModeSnapshot {
  return useSyncExternalStore(
    subscribeOpenModeSnapshot,
    readOpenModeSnapshot,
    readOpenModeSnapshot,
  );
}

/** The set of feed ids carrying `flag`.
 *
 * Read from what the device remembers, not from the query — a row's first frame
 * is tappable, and the query is asynchronous, so deriving from it would render
 * every row in reader mode until it answered and a tap landing in that window
 * would open the wrong place. The remembered copy is kept level with the server
 * by useOpenModeSnapshotSync (completed reads) and by FeedsPage (settled
 * changes); the query is where the answer comes from, not a second opinion to
 * weigh against it. A device that has never read subscriptions remembers
 * nothing and starts in reader mode. */
function useFlaggedFeedIds(flag: RowOpenFlag): ReadonlySet<FeedId> {
  return useOpenModeSnapshot()[flag];
}

/**
 * The feeds set to "open original" — their article rows open the source
 * website directly instead of the in-app reader (SPEC.md *Open original*).
 */
export function useOpenOriginalFeeds(): ReadonlySet<FeedId> {
  return useFlaggedFeedIds('openOriginal');
}

/**
 * The feeds set to "open on newshacker" — their article rows open the item's
 * Hacker News discussion on newshacker.app instead of the in-app reader
 * (SPEC.md *Open original / Open on newshacker*).
 */
export function useOpenNewshackerFeeds(): ReadonlySet<FeedId> {
  return useFlaggedFeedIds('openNewshacker');
}

/**
 * The feeds set to "mark done when opening" — opening one of their items on
 * the original source website or the newshacker discussion also marks it Done
 * (SPEC.md *Mark done when opening*). Deliberately does NOT cover opening the
 * in-app reader (article view).
 */
export function useMarkDoneOnOpenFeeds(): ReadonlySet<FeedId> {
  return useFlaggedFeedIds('markDoneOnOpen');
}

/**
 * Per-feed "card style" overrides: a map from feed id → the {@link ListLayout}
 * the user chose for that feed, for the feeds that carry a non-null override
 * (`Subscription.listLayout`). A feed absent from the map uses the app-wide
 * Article layout setting (SPEC.md *Article layout → Per-feed override*).
 */
export function useListLayoutFeeds(): ReadonlyMap<FeedId, ListLayout> {
  const data = useSubscriptionRows();
  return useMemo(() => {
    const map = new Map<FeedId, ListLayout>();
    for (const { subscription } of data ?? []) {
      if (subscription.listLayout) map.set(subscription.feedId, subscription.listLayout);
    }
    return map;
  }, [data]);
}
