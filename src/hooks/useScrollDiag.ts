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
      recordDiag({
        kind: 'done',
        y: Math.round(window.scrollY),
        id,
        title,
        max: maxScroll(),
      });
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
      unsubscribe();
    };
  }, [enabled, ds, showToast, navigate]);
}
