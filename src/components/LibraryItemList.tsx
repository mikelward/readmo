import { useEffect, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useStateBucket } from '../hooks/useItemState';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { resolveSavedItems } from '../lib/offlineItems';
import { loadFailureCopy } from '../lib/loadErrorCopy';
import type { ItemStateField } from '../lib/types';
import { ItemRows } from './ItemRows';
import { LoadError } from './LoadError';

interface Props {
  /** Which state bucket this view lists. */
  field: ItemStateField;
  /** Accessible label + tooltip for the right-side inverse button. */
  actionLabel: string;
  /** Filled, accent-colored icon for the inverse action. */
  actionIcon: ReactNode;
  emptyLabel: string;
}

/** A library view (/pinned, /favorites, /done, /hidden, /opened): the same
 * item row with the right-side button swapped to the view's inverse action
 * (SPEC.md *Library views*). Swipe is disabled here. */
export function LibraryItemList({
  field,
  actionLabel,
  actionIcon,
  emptyLabel,
}: Props) {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const status = useConnectivityStatus();
  const store = ds.stateStore;
  const ids = useStateBucket(field);

  const query = useQuery({
    queryKey: ['library', field, ids.join(',')],
    // Falls back to the per-item caches warmed by useOfflineCacheLock when the
    // batch fetch fails offline, so /pinned and /favorites list their items
    // without connectivity (same as /offline).
    queryFn: () => resolveSavedItems(ds, queryClient, ids),
    // A row's inverse action mutates the bucket, which is a NEW query key;
    // without placeholder data the whole list blanks behind "Loading…" for a
    // network round-trip on every purely local, optimistic toggle. The
    // previous list is held through the refetch and the bucket filter below
    // removes the toggled row immediately.
    placeholderData: keepPreviousData,
  });

  // Full error to the console (desktop); the panel below shows the friendly
  // headline + curated detail for the mobile case.
  useEffect(() => {
    if (query.error) console.error('[readmo] loading the library view failed:', query.error);
  }, [query.error]);

  // Filter to the CURRENT bucket so a just-toggled row disappears at once even
  // while the held previous page (which still contains it) is on screen.
  const bucketIds = new Set(ids);
  const libraryItems = (query.data ?? []).filter((fi) => bucketIds.has(fi.item.id));
  // An empty placeholder reads as a settled success (isLoading false), so a
  // bucket growing out of a previously-empty view (a cross-device pin landing
  // via hydrate) must not present the stale empty label as this fetch's
  // result. A non-empty held list stays visible — that's the point above.
  const loading =
    query.isLoading ||
    (query.isFetching && query.isPlaceholderData && libraryItems.length === 0);
  // A genuine failure with nothing to fall back to (resolveSavedItems already
  // recovers from the offline caches, so reaching here means even that was
  // empty). Show the same accurate miss-state the feed views use rather than a
  // misleading empty label.
  if (query.isError && libraryItems.length === 0) {
    const copy = loadFailureCopy(status, query.error, {
      action: 'loading your library',
      noun: 'saved items',
    });
    return (
      <LoadError
        headline={copy.headline}
        detail={copy.detail}
        offlineLink={copy.offlineLink}
        onRetry={() => query.refetch()}
      />
    );
  }

  return (
    <ItemRows
      items={libraryItems}
      isLoading={loading}
      emptyLabel={emptyLabel}
      rightAction={(fi) => ({
        label: actionLabel,
        icon: actionIcon,
        testId: `library-action-${field}`,
        onToggle: () => store.set(fi.item.id, field, false),
      })}
    />
  );
}
