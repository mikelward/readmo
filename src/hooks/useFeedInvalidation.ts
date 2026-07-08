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
 *   almost never invalidated here: not on a local triage mutation and (the change
 *   from #408) not on an ordinary cross-device hydration. Those state changes
 *   reflect through the store overlay ItemList already subscribes to
 *   (`visibleItems` drops a dismissed row; a pin renders its badge in place) with
 *   no refetch, so the set's membership and order never re-materialize under the
 *   reader. That's the point: the feed is quiet, and nothing the server does
 *   shifts the rows you're looking at.
 *
 *   The ONE exception is a cross-device **pin of an article the overlay can't
 *   surface** — one that isn't in the loaded set at all. The overlay can flip a
 *   flag on a row that's present, but it can't *add* an absent row, so such a pin
 *   would stay invisible until the next re-materialization (6h TTL / PTR / More) —
 *   the "my pinned article vanished" bug, seen when a persisted (PWA) feed set
 *   predates the pin. A pinned article must be visible, so when `subscribeHydrated`
 *   reports a newly-pinned id absent from an **all-subscriptions** home list, we
 *   invalidate that list — the mounted one refetches now, an inactive one (reader
 *   on another route, or a different sort/group variant) is marked stale so it
 *   refetches on its next mount instead of serving the pre-pin list for 6h. It's
 *   scoped to the all-subscriptions view because a folder/single-feed read is
 *   bounded server-side and can't surface a pin from another scope anyway. Poller
 *   rows, dismisses, unpins, and in-window pins never trigger it, so the quiet
 *   contract holds otherwise.
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
    // Re-materialize a feed list only when a cross-device sync pins an article
    // the overlay can't surface — a newly-pinned id absent from that list.
    //
    // Scoped to the **all-subscriptions** home view (`['feed', 'home-all:…']`):
    //   - `newlyPinned` comes from the reader's WHOLE item_state hydration, not a
    //     view. A folder/single-feed view's `feed_items` read is bounded by
    //     `p_folder`/`p_feed_id`, so it can never surface a pin from another
    //     feed/folder — invalidating it for an out-of-scope pin would reflow a
    //     scoped list with no benefit. The all-subscriptions view is the only one
    //     that can include any subscribed feed's pin, so limit the exception to it
    //     (an absent pin's feedId isn't in the cache — it's absent — so we can't
    //     scope-match a folder/feed view precisely anyway). (Codex P2.)
    //
    // Evaluated PER home-all list, active AND inactive, each against its own
    // pages — so:
    //   - an inactive home query left over from a previous route (or a different
    //     sort/group variant) can't hold the pin and suppress a mounted view that
    //     lacks it (the check is per-query, never a union). (Codex P2.)
    //   - a home list that's inactive when the pin lands — the reader is on a
    //     reader/library route, or a non-current sort/group — is marked stale so
    //     it refetches on its next mount (`refetchOnMount` is true-when-stale, and
    //     the invalidated flag persists), instead of serving the pre-pin list for
    //     the 6h TTL. `invalidateQueries` (default `refetchType: 'active'`)
    //     refetches the mounted list now and stales the rest. (Codex P2.)
    // A scoped view still reconciles a genuinely-in-scope pin on the next
    // mount/TTL/PTR, exactly as before this exception.
    const unsubscribeHydrated = ds.stateStore.subscribeHydrated((newlyPinned) => {
      if (newlyPinned.length === 0) return;
      const homeListLacksPin = (q: {
        queryKey: readonly unknown[];
        state: { data?: unknown };
      }) => {
        if (
          q.queryKey[0] !== 'feed' ||
          typeof q.queryKey[1] !== 'string' ||
          !q.queryKey[1].startsWith('home-all')
        ) {
          return false;
        }
        const pages = (
          q.state.data as
            | { pages?: Array<{ items?: Array<{ item: { id: string } }> }> }
            | undefined
        )?.pages;
        const loaded = new Set<string>();
        if (Array.isArray(pages)) {
          for (const page of pages) {
            for (const fi of page.items ?? []) loaded.add(fi.item.id);
          }
        }
        return newlyPinned.some((id) => !loaded.has(id));
      };
      // No-op when no home list is missing the pin (predicate matches nothing).
      void queryClient.invalidateQueries({ predicate: homeListLacksPin });
    });
    return () => {
      unsubscribe();
      unsubscribeHydrated();
    };
  }, [ds, queryClient]);
}
