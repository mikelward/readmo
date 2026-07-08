import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemId } from '../lib/types';
import { useStickyInset } from './useStickyInset';

// A fully-visible row can report an intersectionRatio fractionally below 1 on
// sub-pixel layouts, so anything at or above this counts as fully in view. The
// same value is also an observer threshold (not just `[0, 1]`): the callback
// only fires when the ratio crosses a configured threshold, so without the
// cutoff a row that left full visibility at ~0.9995 would get no follow-up
// callback until it exited the viewport entirely — staying wrongly sweepable
// behind the sticky chrome the whole way down (Codex P2 on PR #44).
const FULLY_VISIBLE_RATIO = 0.999;

// Extra slack, in CSS px, subtracted from each *non-zero* sticky-chrome inset
// before it shrinks the observer root. This is the fix for "sometimes after
// sweeping a group, one article is left behind."
//
// The visibility test is a *ratio* (>= FULLY_VISIBLE_RATIO), but its pixel
// tolerance is a function of row height: 0.999 of an 80px row is ~0.08px, of a
// 200px card ~0.2px. `measureStickyInset`/`measureStickyBottomInset` floor the
// inset so a row sitting *flush* below the chrome keeps ~1px of favorable slack
// and clears the cutoff — but a row whose top is tucked a fraction of a pixel to
// ~1px *behind* the top toolbar (or, in the pinned-bottom-bar layout, behind the
// bottom bar) still falls under 0.999 and drops out of the sweepable set, even
// though the reader can see ~99% of it. It reads as "fully visible," so a group
// Sweep that skips it looks like it left one row. Because the amount tucked
// depends on the sub-pixel scroll offset (and the "More" pager lands the next
// page's first row flush under the chrome), it happens only *sometimes*.
//
// A few px of fixed tolerance decouples the boundary from row height: a row up
// to this many px behind the occluding chrome counts as visible and is swept.
// The occlusion is imperceptible at this size, and over-sweeping a barely-
// occluded row is the same lean the flooring already takes (favor not stranding
// a row the reader thinks they can see). Applied ONLY to a non-zero inset — the
// bare viewport edge (inset 0, e.g. the relative bottom bar) stays exact, so a
// row genuinely cut off by the screen edge is still correctly excluded.
const SWEEP_EDGE_SLACK_PX = 2;

/** Shrink an occluding-chrome inset by the visibility slack, but leave a zero
 * inset (the bare screen edge) untouched so screen-clipped rows stay excluded. */
function insetWithSlack(inset: number): number {
  return inset > 0 ? Math.max(0, inset - SWEEP_EDGE_SLACK_PX) : 0;
}

// Tracks which list rows are *fully* visible right now, so Sweep can hide only
// the rows the reader can actually see — not the whole loaded list (SPEC.md
// *List toolbar → Sweep*). A row counts as in view iff its bounding box sits
// entirely inside the viewport minus the sticky chrome: the header + top
// toolbar above, and the pinned bottom toolbar below. We track that via a
// shared IntersectionObserver whose `rootMargin` shrinks the top and bottom of
// the viewport by those insets (`useStickyInset`). Mirrors newshacker's
// `StoryList` sweep wiring, plus the bottom inset readmo needs because — unlike
// newshacker's relative footer — its bottom toolbar is pinned over content.
interface Options {
  /** Called with the ids of rows that have just scrolled fully off the *top* of
   * the viewport (above the sticky chrome) after having been fully visible.
   * Drives the optional auto-hide-on-scroll behavior; omit it for plain Sweep
   * visibility tracking. */
  onExitTop?: (ids: ItemId[]) => void;
  /** Called with the ids of rows that are now intersecting the viewport again
   * (fully *or* partially) — i.e. the reader scrolled them back into view. Lets
   * the auto-hide-on-scroll consumer drop a row it had queued for top-exit
   * dismissal once it's visible under the finger again. Fires from inside the
   * IntersectionObserver callback, so it's synchronous with the re-entry (no
   * dependency on a React render landing first). */
  onReenter?: (ids: ItemId[]) => void;
  /** Called with the ids of rows that just started intersecting the viewport
   * (fully *or* partially), and {@link onViewportExit} with those that just
   * stopped. Unlike {@link onReenter} (auto-hide only), these track raw
   * on-screen membership for the cross-device "dismiss in place" rule — a grayed
   * row is held only while on screen, and dropped the moment it leaves. Both fire
   * synchronously from the observer callback. */
  onViewportEnter?: (ids: ItemId[]) => void;
  onViewportExit?: (ids: ItemId[]) => void;
}

export function useInViewIds(opts: Options = {}): {
  inViewIds: ReadonlySet<ItemId>;
  /** Stable per-id callback ref to attach to each row element. */
  getRowRef: (id: ItemId) => (el: HTMLElement | null) => void;
} {
  const [inViewIds, setInViewIds] = useState<Set<ItemId>>(() => new Set());
  const rowEls = useRef<Map<ItemId, HTMLElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const { top: topInset, bottom: bottomInset } = useStickyInset();

  // Keep the latest callback in a ref so toggling the feature on/off never
  // recreates the observer (its effect only depends on the insets).
  const onExitTopRef = useRef(opts.onExitTop);
  onExitTopRef.current = opts.onExitTop;
  const onReenterRef = useRef(opts.onReenter);
  onReenterRef.current = opts.onReenter;
  const onViewportEnterRef = useRef(opts.onViewportEnter);
  onViewportEnterRef.current = opts.onViewportEnter;
  const onViewportExitRef = useRef(opts.onViewportExit);
  onViewportExitRef.current = opts.onViewportExit;
  // Latest inViewIds mirrored into a ref so the enable effect can seed from it
  // without subscribing (depending on inViewIds would re-seed on every scroll).
  const inViewIdsRef = useRef(inViewIds);
  inViewIdsRef.current = inViewIds;

  // Rows that have been fully visible at least once *while the feature is on*.
  // A row is only a candidate for "scrolled off the top" once it's actually been
  // seen — this excludes rows still below the fold (never intersected). Tracked
  // only while enabled so rows passed with the setting off aren't retroactively
  // auto-hidden when it's later turned on — e.g. when a sticky-inset change
  // recreates the observer below and replays initial non-intersecting entries.
  const seenRef = useRef<Set<ItemId>>(new Set());
  const enabled = !!opts.onExitTop;
  useEffect(() => {
    // On enable, seed with exactly the rows fully visible *right now* so the
    // feature applies to what's on screen (they dismiss on their next top-exit),
    // while rows already scrolled past — above the viewport, absent from
    // inViewIds — stay excluded so they aren't retroactively hidden.
    if (enabled) seenRef.current = new Set(inViewIdsRef.current);
  }, [enabled]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const exitedTop: ItemId[] = [];
        const nowVisible: ItemId[] = [];
        const nowHidden: ItemId[] = [];
        const reentered: ItemId[] = [];
        const leftViewport: ItemId[] = [];
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const id = el.dataset.itemId;
          if (!id) continue;
          // Intersecting at all (fully or partially) = in the viewport; the
          // complement (ratio 0, either edge) = fully off screen.
          if (entry.isIntersecting) reentered.push(id);
          else leftViewport.push(id);
          if (entry.intersectionRatio >= FULLY_VISIBLE_RATIO) {
            nowVisible.push(id);
            // Only track "seen" while the feature is on (paired with the
            // clear-on-enable above), so a row fully viewed with auto-hide off
            // never becomes a scroll-past candidate after a later enable.
            if (onExitTopRef.current) seenRef.current.add(id);
          } else {
            nowHidden.push(id);
            // A previously-seen row that's now fully out of view: report it only
            // if it left via the *top* edge (scrolled past while reading down),
            // not the bottom (scrolled back up). rootBounds is unavailable in
            // some environments (jsdom) — treat its absence as a top exit, which
            // the seen-guard already keeps from firing on below-the-fold rows.
            if (!entry.isIntersecting && seenRef.current.has(id)) {
              const rb = entry.rootBounds;
              const exitedViaTop = rb
                ? entry.boundingClientRect.bottom <= rb.top
                : true;
              if (exitedViaTop) exitedTop.push(id);
            }
          }
        }
        if (nowVisible.length || nowHidden.length) {
          setInViewIds((prev) => {
            const next = new Set(prev);
            for (const id of nowVisible) next.add(id);
            for (const id of nowHidden) next.delete(id);
            return next;
          });
        }
        if (exitedTop.length) onExitTopRef.current?.(exitedTop);
        if (reentered.length) {
          onReenterRef.current?.(reentered);
          onViewportEnterRef.current?.(reentered);
        }
        if (leftViewport.length) onViewportExitRef.current?.(leftViewport);
      },
      {
        threshold: [0, FULLY_VISIBLE_RATIO, 1],
        rootMargin: `-${insetWithSlack(topInset)}px 0px -${insetWithSlack(bottomInset)}px 0px`,
      },
    );
    observerRef.current = io;
    for (const el of rowEls.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [topInset, bottomInset]);

  // Cache one stable callback-ref per row id so React doesn't tear down the
  // IntersectionObserver attachment on every render. The React-19 alternative
  // is a single callback ref that returns a cleanup; we're still on 18.x where
  // cleanup-returning refs don't exist — hence the per-id cache held in a ref.
  const rowRefCache = useRef<Map<ItemId, (el: HTMLElement | null) => void>>(
    new Map(),
  );
  const getRowRef = useCallback((id: ItemId) => {
    const cached = rowRefCache.current.get(id);
    if (cached) return cached;
    const setRef = (el: HTMLElement | null) => {
      const io = observerRef.current;
      const prev = rowEls.current.get(id);
      if (prev && prev !== el) {
        io?.unobserve(prev);
        rowEls.current.delete(id);
        // Forget that this row was ever seen once it leaves the DOM. Otherwise a
        // row that was auto-hidden (or manually marked Done) and then restored
        // via Undo remounts *above* the viewport, and its first non-intersecting
        // observation — still flagged "seen" — would immediately re-report a top
        // exit and hide it again, defeating Undo. A restored row must be fully
        // re-seen before it can auto-hide again (Codex P2 on PR #111).
        seenRef.current.delete(id);
        setInViewIds((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        // A row leaving the DOM (dismissed, collapsed, paged out) has also left
        // the viewport — the observer never fires a non-intersecting entry for an
        // unobserved element, so report the exit here to keep on-screen tracking
        // (the cross-device gray-in-place rule) from holding a stale id.
        onViewportExitRef.current?.([id]);
      }
      if (el) {
        rowEls.current.set(id, el);
        io?.observe(el);
      }
    };
    rowRefCache.current.set(id, setRef);
    return setRef;
  }, []);

  return { inViewIds, getRowRef };
}
