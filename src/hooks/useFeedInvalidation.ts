import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';

/**
 * Reconciles the feed queries with server truth on item-state changes — but
 * distinguishes a *local triage mutation* from a *cross-device hydration*,
 * because they want opposite things from the feed-ITEMS cache.
 *
 * - **Unread-count badges** (`['feed','unread-counts',…]`) refetch on *every*
 *   store change (the general `subscribe` channel): they're a cheap number that
 *   never reflows the list, and after an outbox write syncs and clears the local
 *   pending adjustment the badge would otherwise read a stale server count and
 *   jump back up until the next focus/PTR (Codex P2 on #375).
 *
 * - **Feed-items** (`['feed', viewKey]`) refetch ONLY on a hydration that
 *   changed the store (`subscribeHydrated` — a boot restore or a cross-device
 *   resync), never on a local Done/pin/hide/sweep/undo. A local mutation already
 *   takes effect from the store overlay alone (`visibleItems` drops Done/Hidden,
 *   pins reorder), so refetching it would (1) reflow the list a beat later —
 *   moving a tap target or the reader's scroll — for no visible change, and (2)
 *   force the query stale and thereby fire a full DB read on *every* return to
 *   the feed (refetchOnMount on the remount), defeating the `staleTime` TTL. Left
 *   alone, the feed-items cache stays TTL-gated: returning to the feed within the
 *   TTL doesn't refetch; past it (or on pull-to-refresh, which always refetches)
 *   it reconciles. A cross-device change, by contrast, can add or reorder rows
 *   the overlay can't express (e.g. another device pinning an article not in the
 *   loaded window), so that path *must* refetch — promptly, not after the TTL —
 *   which is why it invalidates with the default `refetchType` (refetch the
 *   active view now; a view unmounted under the reader is marked stale and
 *   reconciles on the back-remount).
 *
 * Undo and the synced-outbox path force their own `refetch()` directly in
 * ItemList when they genuinely need server truth. Boot-time reconciliation for
 * state that preexisted the React tree is handled in PersistQueryClientProvider's
 * onSuccess callback in main.tsx, after the persisted cache is hydrated.
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
    const unsubscribeHydrated = ds.stateStore.subscribeHydrated(() => {
      // A cross-device/boot hydration changed the store — reconcile the feed rows
      // with the server (excluding unread-counts, already handled above).
      void queryClient.invalidateQueries({
        queryKey: ['feed'],
        predicate: (query) => query.queryKey[1] !== 'unread-counts',
      });
    });
    return () => {
      unsubscribe();
      unsubscribeHydrated();
    };
  }, [ds, queryClient]);
}
