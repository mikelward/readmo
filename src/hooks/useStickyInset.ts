import { useEffect, useState } from 'react';
import {
  measureStickyBottomInset,
  measureStickyInset,
} from '../lib/stickyInset';

export interface StickyInset {
  /** Combined bottom of the sticky chrome at the top (header + toolbar). */
  top: number;
  /** Intrusion of the sticky bottom toolbar up from the viewport foot. */
  bottom: number;
}

// Live sticky-inset values: `top` is the combined bottom of the
// sticky chrome at the top of the viewport (`.app-header` +
// `.list-toolbar`); `bottom` is the intrusion of the sticky bottom
// toolbar (`.list-toolbar--bottom`) up from the viewport foot. Used
// by `useInViewIds` to set the sweep IntersectionObserver's
// `rootMargin` so rows behind either sticky strip are not counted as
// fully visible.
//
// Re-measures on four triggers:
// 1. mount (so the initial value reflects the real layout, not
//    the SSR-friendly 0 from the `useState` initializer);
// 2. `window` resize (viewport changes);
// 3. ResizeObserver entries on the sticky strips themselves —
//    opening the `/hot` customize panel grows `.list-toolbar` in
//    place without a window resize, and a stale inset would let
//    rows hidden behind the expanded panel slip into Sweep's
//    batch. Feature-detected so jsdom (no implementation)
//    gracefully falls back to the other listeners;
// 4. window scroll (rAF-coalesced) — the toolbar's
//    `getBoundingClientRect().bottom` shifts by 1-3px when it
//    transitions from normal flow (with the header's
//    `margin-bottom` plus the border-bottom in the way) to sticky
//    (`top: var(--app-header-height)`, possibly overlapping the
//    header's bottom border by 1px in mono/duo chromes). Without
//    this trigger the cached inset is stale by a few pixels right
//    through the sticky transition, and the IO's `intersectionRatio
//    >= 0.999` check on a ~80px row leaves no room for a 1-3px
//    error — the boundary row would be wrongly excluded from
//    Sweep. rAF coalescing keeps the work at most once per frame;
//    React skips the re-render (and the IO recreation in
//    `StoryList`) when the rounded value hasn't actually changed,
//    so the steady-state cost during a long scroll is one rect
//    read per frame, no IO churn.
//
// All four Codex P2 comments on PR #299 trace to the inset
// staying stale relative to what the user can actually see; this
// hook is the single source of truth that fixes them.
export function useStickyInset(): StickyInset {
  const [inset, setInset] = useState<StickyInset>(() => ({
    top: measureStickyInset(),
    bottom: measureStickyBottomInset(),
  }));

  useEffect(() => {
    const update = () =>
      setInset((prev) => {
        const top = measureStickyInset();
        const bottom = measureStickyBottomInset();
        // Skip the state update (and the downstream IO recreation) when nothing
        // actually changed — the scroll path fires this every frame.
        if (prev.top === top && prev.bottom === bottom) return prev;
        return { top, bottom };
      });
    update();
    window.addEventListener('resize', update);
    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      for (const selector of [
        '.app-header',
        '.list-toolbar',
        '.list-toolbar--bottom',
      ]) {
        const el = document.querySelector(selector);
        if (el) ro.observe(el);
      }
      // Also watch the document's content height. The bottom toolbar is sticky
      // `bottom: 0`, so its viewport position — and thus the bottom inset — flips
      // between "in normal flow, mid-viewport" (short content) and "pinned to the
      // viewport foot" (content taller than the viewport) purely as a function of
      // content height, with no change to the toolbar's own size. A render that
      // reflows the list without scrolling or resizing — most visibly toggling
      // group-by-feed, which momentarily collapses every row before the regrouped
      // layout settles, but also a "More" page or the initial content paint —
      // can therefore be sampled mid-reflow with the toolbar floating mid-screen,
      // leaving a large stale bottom inset that shrinks the sweep observer's root
      // so far that rows the reader can plainly see count as hidden (their feed's
      // header broom grays out, and a group Sweep skips them) until an unrelated
      // scroll re-measures. Observing `body` re-measures the instant the content
      // settles. `update` skips the state change when the rounded inset is
      // unchanged, so the extra signal is free in the steady state.
      if (document.body) ro.observe(document.body);
    }
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, []);

  return inset;
}
