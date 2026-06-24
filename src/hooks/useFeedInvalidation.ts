import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';

/**
 * Globally invalidates all ['feed', *] queries whenever item state changes,
 * and once on mount to handle boot-time state that was hydrated before this
 * hook subscribed.
 *
 * Must be mounted at the App level (not inside a feed view) so mutations made
 * on the reader page — marking an item Done, pinning, hiding — immediately
 * mark feed caches stale even while the feed list is unmounted. When the user
 * navigates back, refetchOnMount sees stale data and fetches, so Done/hidden
 * items are filtered out without waiting for the 5-minute staleTime expire.
 *
 * The boot-time invalidation is needed because MockDataSource hydrates the
 * stateStore synchronously from localStorage in its constructor (before React
 * renders), so the hydrate emit fires before this hook subscribes. Without the
 * one-time invalidation, a persisted feed cache showing a Done/Hidden item
 * would remain visible until the 5-minute staleTime expires.
 */
export function useFeedInvalidation() {
  const ds = useDataSource();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Invalidate once on mount in case stateStore was already hydrated before
    // we subscribed (synchronous boot-time hydration from localStorage).
    void queryClient.invalidateQueries({ queryKey: ['feed'] });
    return ds.stateStore.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    });
  }, [ds, queryClient]);
}
