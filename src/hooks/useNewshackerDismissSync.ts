import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { buildDoneEntries, type DoneChange } from '../lib/newshackerSync';
import { consumeDoneMirrorSuppression } from '../lib/newshackerMirrorSuppress';
import type { ItemId } from '../lib/types';

/** How long to coalesce a burst of dismissals (swipe, Sweep, auto-hide) into one
 * mirror call. Matches the spirit of newshacker's own ~2s sync debounce. */
const FLUSH_DEBOUNCE_MS = 1500;

export const NEWSHACKER_LINK_QUERY_KEY = ['newshacker-link'] as const;

/**
 * Mirror Hacker News dismissals to newshacker's Done list (SPEC.md *Mirror
 * dismissals to newshacker*). Mount once, high in the tree. Only active when the
 * account has linked a newshacker token; otherwise it does nothing.
 *
 * It listens to the item-state store's *mutation* events (user-driven set/hide/
 * sweep/undo only — never hydration/cross-device sync), collects the items whose
 * Done just changed, and after a short debounce resolves them to HN item ids and
 * forwards the batch. Non-HN items resolve to no id and are dropped, so a
 * non-Hacker-News feed never calls out. Entirely best-effort: any failure is
 * swallowed and the local Done state stays authoritative.
 */
export function useNewshackerDismissSync(): void {
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
    const syncDone = ds.syncNewshackerDone?.bind(ds);
    if (!syncDone) return;
    const store = ds.stateStore;

    const pending = new Map<ItemId, DoneChange>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = async () => {
      timer = null;
      if (pending.size === 0) return;
      const changes = new Map(pending);
      pending.clear();
      let items;
      try {
        items = await ds.getItemsByIds([...changes.keys()]);
      } catch {
        return; // couldn't resolve the items; drop this batch (best-effort)
      }
      const entries = buildDoneEntries(items, changes);
      if (entries.length > 0) await syncDone(entries);
    };

    const unsub = store.subscribeMutations((id, changed) => {
      if (changed.done === undefined) return;
      // Skip the one Done that fires when the user OPENS this item on newshacker
      // (open-on-newshacker + mark-done-on-open): that's a handoff, not a
      // dismissal, so we don't sweep it to Done on newshacker as they arrive to
      // read it. One-shot — a later real dismissal still mirrors. This is also
      // the only same-tab-unload path, so suppressing it means the remaining
      // dismissals all happen while the app stays open (no unload race).
      if (changed.done === true && consumeDoneMirrorSuppression(id)) return;
      pending.set(id, { done: changed.done, at: Date.now() });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), FLUSH_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      // Flush whatever's still pending so a dismissal right before unmount
      // (route change) still mirrors.
      void flush();
    };
  }, [ds, linked]);
}
