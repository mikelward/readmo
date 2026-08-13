import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { SETTINGS_SYNCED_EVENT } from '../lib/settingsSync';

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
 * - **A change to the FILTERED WORDS list** is the one thing that does
 *   invalidate the frozen feed-items set, and it is a deliberate exception to
 *   the paragraph above rather than an oversight. The server applies the
 *   filters too (migrations 0072/0073), so the rows it excluded are not in the
 *   cache at all — so the overlay cannot restore them, and SPEC's promise that removing
 *   a word "restores every article it was hiding" would silently hold only
 *   until the next pull-to-refresh. The same applies in reverse: the articles
 *   that move up into the floor slots a new filter frees have never been
 *   fetched. Neither direction is expressible as an overlay, which is exactly
 *   the test the frozen-set rule uses.
 *
 *   It stays narrow on purpose — only this list, so an unrelated settings write
 *   reflows nothing. Against a backend without the migration the refetch returns
 *   the same rows and the overlay does the work, so the client never requires a
 *   particular backend vintage (guardrail #11).
 *
 *   THE TIMING IS THE WHOLE POINT, and getting it wrong is silent. It keys on
 *   SETTINGS_SYNCED_EVENT — the server ACK — not on the local store change,
 *   because the push is 400 ms of debounce plus a round trip behind that write.
 *   Refetching on the local change asks the server while it still holds the OLD
 *   list, gets the old rows back, and marks the query fresh; the ack that
 *   follows invalidates nothing, so the feed keeps the stale set until a manual
 *   refresh or the 6h TTL (Codex P1 on #625, on the first version of this hook,
 *   which did exactly that). The reader still sees matched rows disappear at
 *   once — that's the overlay, and it doesn't wait for anything.
 *
 *   Note it also fires when the list arrives from ANOTHER device, which is the
 *   open question recorded in TODO.md — there the refetch is the whole
 *   re-materialization, not just the freed rows. That question is about *when*
 *   a remote change should be adopted and is unsettled; this hook does not
 *   decide it, it only makes the local case keep its promise.
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

  // The feed is refetched when the SERVER acknowledges a title-filter push, so
  // the refetch reads the list the server is actually applying. `detail.keys`
  // is what was sent, so a push of unrelated settings wakes nobody.
  useEffect(() => {
    const onPushed = (event: Event) => {
      const keys = (event as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys?.includes('titleFilters')) return;
      // The whole ['feed', …] prefix: the items set for the rows, and the
      // badges, which count what the list serves and would otherwise disagree.
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    };
    window.addEventListener(SETTINGS_SYNCED_EVENT, onPushed);
    return () => {
      window.removeEventListener(SETTINGS_SYNCED_EVENT, onPushed);
    };
  }, [queryClient]);
}
