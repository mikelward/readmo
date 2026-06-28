import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import type { FeedId } from '../lib/types';

/**
 * The set of feed ids the user has set to "open on newshacker" — their article
 * rows open the item's Hacker News discussion on newshacker.app instead of the
 * in-app reader (SPEC.md *Open original / Open on newshacker*). Sibling of
 * {@link useOpenOriginalFeeds}: reads the same shared `['subscriptions']` query,
 * so it's deduped with the drawer / Feeds page and re-derives the moment a
 * toggle invalidates that key. Returns an empty set until the subscriptions load
 * (or for callers with none), so every row defaults to the in-app reader.
 */
export function useOpenNewshackerFeeds(): ReadonlySet<FeedId> {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });
  return useMemo(() => {
    const ids = new Set<FeedId>();
    for (const { subscription } of data ?? []) {
      if (subscription.openNewshacker) ids.add(subscription.feedId);
    }
    return ids;
  }, [data]);
}
