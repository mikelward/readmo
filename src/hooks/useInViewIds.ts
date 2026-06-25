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

  // Rows that have been fully visible at least once. A row is only a candidate
  // for "scrolled off the top" once it's actually been seen — this excludes
  // rows still below the fold (never intersected) from being auto-hidden on the
  // first observer callback.
  const seenRef = useRef<Set<ItemId>>(new Set());

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const exitedTop: ItemId[] = [];
        const nowVisible: ItemId[] = [];
        const nowHidden: ItemId[] = [];
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const id = el.dataset.itemId;
          if (!id) continue;
          if (entry.intersectionRatio >= FULLY_VISIBLE_RATIO) {
            nowVisible.push(id);
            seenRef.current.add(id);
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
      },
      {
        threshold: [0, FULLY_VISIBLE_RATIO, 1],
        rootMargin: `-${topInset}px 0px -${bottomInset}px 0px`,
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
