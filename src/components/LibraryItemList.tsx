import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  });

  // Full error to the console (desktop); the panel below shows the friendly
  // headline + curated detail for the mobile case.
  useEffect(() => {
    if (query.error) console.error('[readmo] loading the library view failed:', query.error);
  }, [query.error]);

  const libraryItems = query.data ?? [];
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
        onRetry={() => query.refetch()}
      />
    );
  }

  return (
    <ItemRows
      items={libraryItems}
      isLoading={query.isLoading}
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
