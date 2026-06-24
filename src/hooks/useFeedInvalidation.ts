import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';

/**
 * Globally invalidates all ['feed', *] queries whenever item state changes.
 *
 * Must be mounted at the App level (not inside a feed view) so mutations made
 * on the reader page — marking an item Done, pinning, hiding — immediately
 * mark feed caches stale even while the feed list is unmounted. When the user
 * navigates back, refetchOnMount sees stale data and fetches, so Done/hidden
 * items are filtered out without waiting for the 5-minute staleTime to expire.
 */
export function useFeedInvalidation() {
  const ds = useDataSource();
  const queryClient = useQueryClient();

  useEffect(() => {
    return ds.stateStore.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    });
  }, [ds, queryClient]);
}
