import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import {
  buildMirrorPayload,
  resolveHackerNewsIds,
  type MirrorChange,
} from '../lib/newshackerSync';
import { consumeDoneMirrorSuppression } from '../lib/newshackerMirrorSuppress';
import { clearAllReverseSyncPending } from '../lib/newshackerReverseSyncPending';
import { recallHackerNewsItemId } from '../lib/newshackerItemIds';
import type { ItemId } from '../lib/types';

/** How long to coalesce a burst of changes (swipe, Sweep, auto-hide, pin/unpin)
 * into one mirror call. Matches the spirit of newshacker's own ~2s sync debounce. */
const FLUSH_DEBOUNCE_MS = 1500;

export const NEWSHACKER_LINK_QUERY_KEY = ['newshacker-link'] as const;

/**
 * Mirror Hacker News **dismissals (Done)** and **pins** to newshacker's matching
 * lists (SPEC.md *Mirror dismissals and pins to newshacker*). Mount once, high in
 * the tree. Only active when the account has linked a newshacker token; otherwise
 * it does nothing.
 *
 * It listens to the item-state store's *mutation* events — **user-driven only**
 * (set/hide/sweep/undo), never hydration or cross-device sync — so a pin/Done
 * arriving *from* another device is never echoed back out (mirror on the local
 * event, not on every sync). It collects the items whose Done/Pinned just
 * changed, and after a short debounce resolves them to HN item ids and forwards
 * the batch. Non-HN items resolve to no id and are dropped, so a non-Hacker-News
 * feed never calls out. Entirely best-effort: any failure is swallowed and the
 * local state stays authoritative.
 */
export function useNewshackerSync(): void {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: NEWSHACKER_LINK_QUERY_KEY,
    queryFn: () =>
      ds.getNewshackerLink?.() ??
      Promise.resolve({ linked: false, supported: false }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const linked = data?.linked ?? false;

  useEffect(() => {
    if (!linked) return;
    const syncState = ds.syncNewshackerState?.bind(ds);
    if (!syncState) return;
    const store = ds.stateStore;

    const pending = new Map<ItemId, MirrorChange>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = async () => {
      timer = null;
      if (pending.size === 0) return;
      const changes = new Map(pending);
      pending.clear();
      // Resolve each item's HN id from the render-time cache first — it survives
      // a tombstone that just cleared the item's RLS visibility (unpin/un-dismiss
      // of an unsubscribed feed's item), which the fetch below would then miss.
      const hnIdById = new Map<ItemId, number>();
      const unresolved: ItemId[] = [];
      for (const id of changes.keys()) {
        const remembered = recallHackerNewsItemId(id);
        if (remembered != null) hnIdById.set(id, remembered);
        else unresolved.push(id);
      }
      if (unresolved.length > 0) {
        try {
          const items = await ds.getItemsByIds(unresolved);
          for (const [id, hnId] of resolveHackerNewsIds(items)) {
            hnIdById.set(id, hnId);
          }
        } catch {
          // Couldn't resolve the un-cached items; still mirror whatever the
          // render cache covered (best-effort).
        }
      }
      const payload = buildMirrorPayload(hnIdById, changes);
      if (payload.done.length > 0 || payload.pinned.length > 0) {
        await syncState(payload);
      }
    };

    const unsub = store.subscribeMutations((id, changed) => {
      const hasDone = changed.done !== undefined;
      const hasPinned = changed.pinned !== undefined;
      if (!hasDone && !hasPinned) return;
      // Skip the whole mutation that fires when the user OPENS this item on
      // newshacker (open-on-newshacker + mark-done-on-open): that Done is a
      // handoff, not a dismissal, so we don't sweep it (or its exclusivity-
      // cleared pin) to newshacker as they arrive to read it. One-shot — a later
      // real change still mirrors. This is also the only same-tab-unload path, so
      // suppressing it means the rest happen while the app stays open.
      if (changed.done === true && consumeDoneMirrorSuppression(id)) return;
      const next: MirrorChange = pending.get(id) ?? { at: 0 };
      if (hasDone) next.done = changed.done;
      if (hasPinned) next.pinned = changed.pinned;
      next.at = Date.now();
      pending.set(id, next);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), FLUSH_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      // Flush whatever's still pending so a change right before unmount (route
      // change) still mirrors.
      void flush();
    };
  }, [ds, linked]);

  // Reverse sync: once linked, pull newshacker's own Done + Pinned lists and
  // apply them to Readmo (SPEC.md *Mirror dismissals and pins to newshacker* →
  // reverse pull). Runs on mount/link activation AND on tab focus / visibility /
  // reconnect — the same triggers as the item-state resync — so triage done on
  // newshacker shows up without a manual refresh. Best-effort. The apply lands in
  // item_state server-side and re-hydrates through the store's `hydrate` path,
  // which (a) never fires the outbound mirror above — no echo loop — and (b)
  // grays a now-Done row IN PLACE via the ItemList overlay rather than reflowing
  // the list (cross-device-dismiss behavior), so a focus sync never yanks rows
  // out from under the reader. A pulled pin also warms its offline cache via
  // useOfflineCacheLock. Each completed pull clears the reverse-sync "pending"
  // markers, resolving any open-on-newshacker "syncing" spinner (→ struck if the
  // item is now Done, else the opened fade).
  useEffect(() => {
    if (!linked) return;
    const pull = ds.pullNewshackerState?.bind(ds);
    if (!pull) return;
    // Coalesce overlapping pulls: a single tab return can dispatch BOTH `focus`
    // and `visibilitychange`, and the Edge GET isn't itself deduped — so guard on
    // an in-flight flag to issue one pull per return, not two.
    let pulling = false;
    const run = () => {
      if (pulling) return;
      pulling = true;
      void pull()
        .catch(() => {
          // best-effort; the local state is authoritative.
        })
        .then(() => {
          pulling = false;
          clearAllReverseSyncPending();
        });
    };
    run();
    const onFocus = () => {
      // A bare `focus` can fire on a still-hidden tab; only pull when visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      run();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [ds, linked]);
}
