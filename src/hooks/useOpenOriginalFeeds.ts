import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import type { FeedId } from '../lib/types';

/**
 * The set of feed ids the user has set to "open original" — their article rows
 * open the source website directly instead of the in-app reader (SPEC.md *Open
 * original*). Reads the shared `['subscriptions']` query, so it's deduped with
 * the drawer / Feeds page and re-derives the moment a toggle invalidates that
 * key. Returns an empty set until the subscriptions load (or for callers with
 * none), so every row defaults to the in-app reader.
 */
export function useOpenOriginalFeeds(): ReadonlySet<FeedId> {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });
  return useMemo(() => {
    const ids = new Set<FeedId>();
    for (const { subscription } of data ?? []) {
      if (subscription.openOriginal) ids.add(subscription.feedId);
    }
    return ids;
  }, [data]);
}
