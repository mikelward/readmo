import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';

/**
 * Keeps the per-feed **unread-count** badges reconciled with server truth on
 * item-state changes — and deliberately leaves the feed-ITEMS set alone.
 *
 * - **Unread-count badges** (`['feed','unread-counts',…]`) refetch on *every*
 *   store change (the general `subscribe` channel — local mutation, cross-device
 *   hydration, or outbox drain): they're a cheap number that never reflows the
 *   list, and after an outbox write syncs and clears the local pending adjustment
 *   the badge would otherwise read a stale server count and jump back up until the
 *   next focus/PTR (Codex P2 on #375).
 *
 * - **Feed-items** (`['feed', viewKey]`) are the FROZEN published set — they are
 *   never invalidated here, not on a local triage mutation and (the change from
 *   #408) not on a cross-device hydration either. Both kinds of state change
 *   reflect through the store overlay ItemList already subscribes to
 *   (`visibleItems` drops a dismissed row; a pin renders its badge in place) with
 *   no refetch, so the set's membership and order never re-materialize under the
 *   reader. A cross-device change that the overlay *can't* express — a pin of an
 *   article outside the loaded window, say — is deliberately deferred to the next
 *   re-materialization (a load/return past the 6h freshness TTL, a pull-to-refresh,
 *   or More) rather than repainting the list now. That's the point: the feed is
 *   quiet, and nothing the server does shifts the rows you're looking at.
 *
 * Undo forces its own `refetch()` directly in ItemList when it genuinely needs
 * server truth. Boot-time reconciliation for state that preexisted the React tree
 * is handled in PersistQueryClientProvider's onSuccess callback in main.tsx, after
 * the persisted cache is hydrated.
 */
export function useFeedInvalidation() {
  const ds = useDataSource();
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = ds.stateStore.subscribe(() => {
      // Every store change (local mutation, hydration, or outbox drain) can move
      // an unread count — refetch it. Never reflows the list.
      void queryClient.invalidateQueries({
        queryKey: ['feed', 'unread-counts'],
      });
    });
    return () => {
      unsubscribe();
    };
  }, [ds, queryClient]);
}
