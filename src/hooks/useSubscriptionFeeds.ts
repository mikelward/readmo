import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import type { FeedId, ListLayout } from '../lib/types';

// Per-feed settings derived from the subscription list. Every hook here reads
// the same shared `['subscriptions']` query, so they're deduped with the
// drawer / Feeds page and re-derive the moment a settings toggle invalidates
// that key. Each returns an empty collection until the subscriptions load (or
// for callers with none), so every feature defaults to off.

function useSubscriptionRows() {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });
  return data;
}

/** The set of feed ids whose subscription has `flag` switched on. */
function useFlaggedFeedIds(
  flag: 'openNewshacker' | 'openOriginal' | 'markDoneOnOpen',
): ReadonlySet<FeedId> {
  const data = useSubscriptionRows();
  return useMemo(() => {
    const ids = new Set<FeedId>();
    for (const { subscription } of data ?? []) {
      if (subscription[flag]) ids.add(subscription.feedId);
    }
    return ids;
  }, [data, flag]);
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
