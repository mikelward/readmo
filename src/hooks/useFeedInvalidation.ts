import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';

/**
 * Marks all ['feed', *] queries stale whenever item state changes — WITHOUT
 * refetching the active view. A mutation (Done, pin, hide, sweep) takes effect
 * locally and immediately: the feed view filters Done/Hidden out of its render
 * from the store overlay, and pins reorder from the same overlay, so nothing
 * waits on the server. What we deliberately DON'T do is yank a refetch under the
 * reader — that re-render lands a beat later and reflows the list (a section's
 * "More"/refresh footer toggling, rows shifting), which could move the reader's
 * scroll position out from under them. `refetchType: 'none'` just marks the
 * cache stale; the next natural trigger — remounting the view, window focus, or
 * pull-to-refresh (all still enabled) — reconciles it with the server.
 *
 * Must be mounted at the App level (not inside a feed view) so mutations made on
 * the reader page mark feed caches stale even while the feed list is unmounted;
 * when the user navigates back, refetchOnMount sees the stale data and fetches.
 *
 * Boot-time reconciliation (for state that preexisted the React tree) is handled
 * in PersistQueryClientProvider's onSuccess callback in main.tsx, which fires
 * after the persisted cache is fully hydrated — ensuring the invalidation isn't
 * overwritten by the restore.
 */
export function useFeedInvalidation() {
  const ds = useDataSource();
  const queryClient = useQueryClient();

  useEffect(() => {
    return ds.stateStore.subscribe(() => {
      void queryClient.invalidateQueries({
        queryKey: ['feed'],
        refetchType: 'none',
      });
    });
  }, [ds, queryClient]);
}
