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
export function useInViewIds(): {
  inViewIds: ReadonlySet<ItemId>;
  /** Stable per-id callback ref to attach to each row element. */
  getRowRef: (id: ItemId) => (el: HTMLElement | null) => void;
} {
  const [inViewIds, setInViewIds] = useState<Set<ItemId>>(() => new Set());
  const rowEls = useRef<Map<ItemId, HTMLElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const { top: topInset, bottom: bottomInset } = useStickyInset();

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        setInViewIds((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const id = el.dataset.itemId;
            if (!id) continue;
            if (entry.intersectionRatio >= FULLY_VISIBLE_RATIO) next.add(id);
            else next.delete(id);
          }
          return next;
        });
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
