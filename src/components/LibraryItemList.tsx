import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useStateBucket } from '../hooks/useItemState';
import { resolveSavedItems } from '../lib/offlineItems';
import type { ItemStateField } from '../lib/types';
import { ItemRows } from './ItemRows';

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
  const store = ds.stateStore;
  const ids = useStateBucket(field);

  const query = useQuery({
    queryKey: ['library', field, ids.join(',')],
    // Falls back to the per-item caches warmed by useOfflineCacheLock when the
    // batch fetch fails offline, so /pinned and /favorites list their items
    // without connectivity (same as /offline).
    queryFn: () => resolveSavedItems(ds, queryClient, ids),
  });

  return (
    <ItemRows
      items={query.data ?? []}
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
