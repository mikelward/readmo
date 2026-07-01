import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import type { FeedId } from '../lib/types';

/**
 * The set of feed ids the user has set to "mark done when opening" — opening one
 * of their items on the original source website or the newshacker discussion also
 * marks it Done (SPEC.md *Mark done when opening*). Deliberately does NOT cover
 * opening the in-app reader (article view). Sibling of {@link useOpenOriginalFeeds}:
 * reads the same shared `['subscriptions']` query, so it's deduped with the
 * drawer / Feeds page and re-derives the moment a toggle invalidates that key.
 * Returns an empty set until the subscriptions load (or for callers with none),
 * so opening never marks done by default.
 */
export function useMarkDoneOnOpenFeeds(): ReadonlySet<FeedId> {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });
  return useMemo(() => {
    const ids = new Set<FeedId>();
    for (const { subscription } of data ?? []) {
      if (subscription.markDoneOnOpen) ids.add(subscription.feedId);
    }
    return ids;
  }, [data]);
}
