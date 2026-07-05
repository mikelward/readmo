import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDataSource } from '../lib/data/context';
import { useToast } from './useToast';
import { freezeDiagReport, recordDiag } from '../lib/scrollDiag';

/** Scroll-jump diagnostics (the /debug switch, off by default). When enabled,
 * record every window scroll position and every Done flip into an in-memory
 * timeline (see lib/scrollDiag), and raise a sticky "Done — Report bug" toast on
 * each dismiss. Tapping "Report bug" freezes the timeline and opens
 * /debug/scroll, so a jump-to-top after a dismiss/done can be inspected on a
 * phone with no console. A no-op when disabled — nothing is listened for or
 * recorded, so it costs nothing in normal use. Mounted once app-wide (App) so it
 * captures dismisses from both the feed list and the reader. */
export function useScrollDiag(enabled: boolean): void {
  const ds = useDataSource();
  const { showToast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    // Max scrollable offset right now — if a jump's `y` lands here the document
    // became too short and the browser clamped; if it stays above the prior `y`
    // the scroll moved with room to spare (an anchoring rewind).
    const maxScroll = () =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // Whether the list body's scroll-anchor/height lock is active — the
    // single-dismiss guard sets overflow-anchor:none (and a min-height) on it.
    const bodyLocked = () => {
      const body = document.querySelector('.item-list__body');
      return (
        body instanceof HTMLElement &&
        (body.style.overflowAnchor === 'none' || body.style.minHeight !== '')
      );
    };
    // The layout breakdown at a moment in time: the list body's own height vs.
    // the whole document, the rendered row count, and the viewport. Recorded on
    // done/resize/probe so a collapse can be localized (body vs. chrome) and a
    // reflow dip (rows unchanged) told apart from real removal.
    const readLayout = () => {
      const body = document.querySelector('.item-list__body');
      return {
        bodyH: body instanceof HTMLElement ? body.offsetHeight : 0,
        docH: document.documentElement.scrollHeight,
        rows: document.querySelectorAll('[data-item-id]').length,
        vh: window.innerHeight,
      };
    };

    let lastY = Math.round(window.scrollY);
    const onScroll = () => {
      const y = Math.round(window.scrollY);
      recordDiag({
        kind: 'scroll',
        y,
        delta: y - lastY,
        max: maxScroll(),
        locked: bodyLocked(),
      });
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    // Sample the document height so a collapse that happens WITHOUT a scroll —
    // e.g. a background resync/refetch reshaping the list while the reader sits
    // idle — is recorded with its timing. That collapse is what leaves the
    // document too short, so the next interaction clamps the scroll. Only a
    // material change is logged (not every pixel), and only while enabled.
    const HEIGHT_SAMPLE_MS = 150;
    const MATERIAL_MAX_DELTA_PX = 40;
    let lastMax = maxScroll();
    const heightTimer = window.setInterval(() => {
      const m = maxScroll();
      if (Math.abs(m - lastMax) >= MATERIAL_MAX_DELTA_PX) {
        recordDiag({
          kind: 'resize',
          y: Math.round(window.scrollY),
          delta: m - lastMax,
          max: m,
          locked: bodyLocked(),
          ...readLayout(),
        });
        lastMax = m;
      }
    }, HEIGHT_SAMPLE_MS);

    // The document collapse a dismiss triggers is over within a couple of frames
    // — far faster than the 150ms height sampler. On each Done, sample the layout
    // for a short animation-frame burst so the dip's shape and composition
    // (body vs. chrome height, row count) are captured. Deduped: a frame is
    // recorded only when the body/document height moved materially since the last
    // one (plus the first and last), so a steady stretch doesn't flood the buffer.
    const PROBE_FRAMES = 12;
    const PROBE_MATERIAL_PX = 8;
    const canRaf = typeof requestAnimationFrame === 'function';
    const pendingProbeRafs = new Set<number>();
    const startProbeBurst = () => {
      if (!canRaf) return;
      let frame = 0;
      let last: { bodyH: number; docH: number } | null = null;
      const tick = () => {
        const layout = readLayout();
        const material =
          last === null ||
          frame === PROBE_FRAMES - 1 ||
          Math.abs(layout.bodyH - last.bodyH) >= PROBE_MATERIAL_PX ||
          Math.abs(layout.docH - last.docH) >= PROBE_MATERIAL_PX;
        if (material) {
          recordDiag({
            kind: 'probe',
            y: Math.round(window.scrollY),
            max: maxScroll(),
            locked: bodyLocked(),
            ...layout,
          });
          last = { bodyH: layout.bodyH, docH: layout.docH };
        }
        frame += 1;
        if (frame < PROBE_FRAMES) {
          const next = requestAnimationFrame(tick);
          pendingProbeRafs.add(next);
        }
      };
      const id = requestAnimationFrame(tick);
      pendingProbeRafs.add(id);
    };

    const unsubscribe = ds.stateStore.subscribeMutations((id, changed) => {
      // Only a fresh Done flip — pins/favorites/opened and un-dones don't move
      // the list the way a dismiss does.
      if (changed.done !== true) return;
      // The listener fires synchronously inside hide(), before React re-renders,
      // so the dismissed row is still mounted — read its headline for a legible
      // timeline. Absent (undefined) when the row isn't in this view's DOM.
      const row = document.querySelector(`[data-item-id="${id}"]`);
      const title =
        row?.querySelector('.item-row__title-text')?.textContent?.trim() ||
        undefined;
      // `max` here is the pre-removal ceiling; comparing it with the jump's
      // post-removal `max` shows how far the document shrank. `locked` is left to
      // the scroll entries — this handler may run before ItemList's lock does.
      // The layout breakdown localizes the collapse the following probe burst
      // then tracks frame-by-frame.
      recordDiag({
        kind: 'done',
        y: Math.round(window.scrollY),
        id,
        title,
        max: maxScroll(),
        ...readLayout(),
      });
      startProbeBurst();
      showToast({
        message: 'Done',
        actionLabel: 'Report bug',
        onAction: () => {
          freezeDiagReport();
          navigate('/debug/scroll');
        },
        // Sticky, same as the update toast — stays until the next dismiss
        // replaces it or the user taps through, so there's always time to tap
        // Report bug right after a jump.
        durationMs: Number.POSITIVE_INFINITY,
        groupKey: 'scroll-diag',
      });
    });

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.clearInterval(heightTimer);
      if (canRaf) {
        for (const id of pendingProbeRafs) cancelAnimationFrame(id);
        pendingProbeRafs.clear();
      }
      unsubscribe();
    };
  }, [enabled, ds, showToast, navigate]);
}
