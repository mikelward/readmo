import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import type { FeedId, ListLayout } from '../lib/types';

/**
 * Per-feed "card style" overrides: a map from feed id → the {@link ListLayout} the
 * user chose for that feed, for the feeds that carry a non-null override
 * (`Subscription.listLayout`). A feed absent from the map uses the app-wide
 * Article layout setting (SPEC.md *Article layout → Per-feed override*). Reads the
 * shared `['subscriptions']` query, so it's deduped with the drawer / Feeds page /
 * open-mode hooks and re-derives the moment a Card-style change invalidates that
 * key. Returns an empty map until the subscriptions load (or for callers with
 * none), so every row falls back to the app-wide setting.
 */
export function useListLayoutFeeds(): ReadonlyMap<FeedId, ListLayout> {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });
  return useMemo(() => {
    const map = new Map<FeedId, ListLayout>();
    for (const { subscription } of data ?? []) {
      if (subscription.listLayout) map.set(subscription.feedId, subscription.listLayout);
    }
    return map;
  }, [data]);
}
