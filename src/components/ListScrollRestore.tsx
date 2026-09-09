import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import {
  captureListScrollAnchor,
  getListScrollAnchor,
  measureAnchorDelta,
  saveListScrollAnchor,
} from '../lib/listScrollAnchor';

// How long one correction pass keeps looking for rows to aim at, in ms. They
// usually paint on the first frame (the feed renders straight from the query
// cache), but a cold return can be waiting on the persisted cache to hydrate.
// This bounds only the *waiting*: once the pass gives up, the hold is still
// watching for the list to change (see the mutation observer below), so a later
// arrival is caught there rather than by spinning here.
const PAINT_WAIT_MS = 1000;

// Consecutive frames the anchor must already be in place before we stop. Two,
// not one: a single settled frame can be the frame before a late row height
// (a lazily-loaded favicon, a wrapped headline) shifts it again.
const SETTLED_FRAMES = 2;

// Sub-pixel corrections are noise — layout rounding, not the list having moved.
const RESTORE_EPSILON_PX = 1;

/** Reader input that ends an in-flight restore. */
const ABORT_EVENTS = ['touchstart', 'wheel', 'keydown', 'pointerdown'] as const;

/** Did this batch of DOM changes touch list rows? Anything else on the page — a
 * toast, a status strip, the header — can't move the anchor, so it doesn't
 * warrant re-measuring. */
function touchesRows(records: MutationRecord[]): boolean {
  for (const record of records) {
    // A change *inside* a row counts, not just a row appearing or vanishing: a
    // refetch that returns the same ids with an edited headline (the poller
    // updates titles in place) rewrites the text of a row React keeps, and a
    // headline that re-wraps to a second line moves everything below it.
    const target =
      record.target instanceof HTMLElement ? record.target : record.target.parentElement;
    if (target?.closest('li[data-item-id]')) return true;
    for (const nodes of [record.addedNodes, record.removedNodes]) {
      for (const node of Array.from(nodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches('li[data-item-id]') || node.querySelector('li[data-item-id]')) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Holds the reader's place in a list across a trip to the reader view and back.
 *
 * On Back, the browser restores the pixel offset it saved — which is the wrong
 * place whenever rows have left the list above the reader while it was
 * unmounted. That happens routinely: the article you opened is dropped on a
 * mark-done-on-open feed, and with auto-hide's strike-in-place hold on, every
 * row you scrolled past is dropped when the list remounts (the hold lives in the
 * unmounted component). Each dropped row above the reader slides the rest up
 * under the restored offset, landing them that many articles further down.
 *
 * So this records the row at the top of the visible band as the reader scrolls,
 * and on a POP navigation scrolls that row back to where it sat. Rendered once
 * in App, next to <ScrollToTop> (which owns the other half: forward navigation
 * starts at the top). It works off the rendered rows themselves, so every list
 * view gets it without plumbing.
 */
export function ListScrollRestore() {
  // `key` identifies the history entry, so each entry in the back stack keeps
  // its own place — including two visits to the same list.
  const { key } = useLocation();
  const navigationType = useNavigationType();
  // Set for as long as a hold is running, so the capture watcher below leaves
  // the anchor to it: a hold's own scrolls and the reflows it's correcting for
  // would otherwise be recorded as if the reader had moved there.
  const restoringRef = useRef(false);

  // Record where the reader is. Capture has to happen while the list is still
  // mounted: by the time an unmount cleanup runs, React has already swapped the
  // DOM for the next route, so there'd be nothing left to read — which is why
  // this watches continuously rather than trying to snapshot on the way out.
  //
  // Scrolling isn't the only thing that moves the reader relative to the rows.
  // A re-materialization can land while they're sitting on the list — a
  // focus/reconnect refetch, a pull-to-refresh, a cross-device dismiss — and
  // reorder or drop rows with no scroll event at all. A stale anchor is worse
  // than none: the next Back would faithfully restore a row to where it sat
  // before a change the reader has already seen. So the same signals the hold
  // uses to re-correct are used here to re-record.
  useEffect(() => {
    let frame = 0;
    const capture = () => {
      frame = 0;
      // A hold owns the anchor while it runs — it re-records on its own terms
      // (see endPass), against the corrected position rather than a
      // mid-correction one.
      if (restoringRef.current) return;
      const anchor = captureListScrollAnchor();
      if (anchor) saveListScrollAnchor(key, anchor);
    };
    // One capture per animation frame at most: a scroll fires events far faster
    // than the anchor can meaningfully change, and a re-materialization arrives
    // as a burst of mutations.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(capture);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    const rows = new MutationObserver((records) => {
      if (touchesRows(records)) schedule();
    });
    rows.observe(document.body, { childList: true, subtree: true, characterData: true });
    let resize: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(schedule);
      resize.observe(document.body);
    }
    return () => {
      window.removeEventListener('scroll', schedule);
      rows.disconnect();
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);

  // Put the reader back, on Back/Forward only — a forward navigation belongs to
  // <ScrollToTop>, and a fresh entry has no anchor anyway.
  useEffect(() => {
    if (navigationType !== 'POP') return;
    const anchor = getListScrollAnchor(key);
    if (!anchor) return;

    let frame = 0;
    let settled = 0;
    let stopped = false;
    let deadline = 0;

    // End a correction pass, leaving the hold itself in place: the list can
    // still change under a reader who hasn't touched anything yet.
    //
    // A settled pass re-records the anchor, because the reader need never
    // scroll again for the entry to be revisited: reading consecutive articles
    // down a feed is Back, open the next one, Back — and on a mark-done-on-open
    // feed (or with auto-hide) each of those returns drops a row. The scroll
    // listener can't cover it (no scroll happens, and its captures are
    // suppressed mid-pass), so the entry would keep its original rows until all
    // of them had been opened and removed, at which point there'd be nothing
    // left to aim at and the next Back would fall back to the raw pixel offset —
    // losing the place on the fifth or sixth article rather than the first.
    // Re-recording after each correction keeps the anchor pointing at rows that
    // are actually still there. `save` is false when the reader ended the pass
    // themselves: their own scroll is about to record a better position than
    // this half-applied one.
    const endPass = (save: boolean) => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!save) return;
      const fresh = captureListScrollAnchor();
      if (fresh) saveListScrollAnchor(key, fresh);
    };

    const step = () => {
      frame = 0;
      // A frame already dispatched when the reader took over still runs, so the
      // abort is re-checked here rather than trusted to cancelAnimationFrame.
      if (stopped) return;
      const delta = measureAnchorDelta(anchor);
      if (delta === null) {
        // None of the anchor's rows is rendered yet — the list is still
        // painting (or every one of them is gone). Keep looking for a beat,
        // then leave it to the observer.
        if (Date.now() >= deadline) {
          endPass(true);
          return;
        }
        frame = requestAnimationFrame(step);
        return;
      }
      const from = Math.round(window.scrollY);
      const target = Math.max(0, from + Math.round(delta));
      if (Math.abs(delta) >= RESTORE_EPSILON_PX && target !== from) {
        settled = 0;
        window.scrollTo(0, target);
      } else {
        // Either already in place, or as close as the document allows: the
        // anchor row wants to sit further down than a list this short can put
        // it (everything above it went away). Scroll 0 is the answer, and
        // re-requesting it every frame would just burn frames.
        settled += 1;
      }
      if (settled >= SETTLED_FRAMES || Date.now() >= deadline) {
        endPass(true);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    const startPass = () => {
      if (stopped || frame) return;
      settled = 0;
      deadline = Date.now() + PAINT_WAIT_MS;
      frame = requestAnimationFrame(step);
    };

    // The hold outlives the first pass, because the list can re-materialize
    // after it: opening an article kicks off a refetch of a stale feed
    // (ItemList's handleOpenReader) precisely so the reflow lands while the
    // feed is off screen — but a quick Back, or a slow response, puts that
    // reflow *after* the return, adding and reordering rows above the reader.
    // A cross-device dismiss can drop a row the same way. Settling once and
    // walking away would hand those the very displacement this exists to
    // prevent, so every change to the rendered rows re-runs the correction.
    const observer = new MutationObserver((records) => {
      if (touchesRows(records)) startPass();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      // An edited headline rewrites a row's text in place, changing no nodes.
      characterData: true,
    });

    // …and some shifts change no DOM at all: a favicon or inline image above
    // the reader finishes loading, a webfont swaps in, a headline re-wraps at a
    // new width. Those move the anchor with nothing for the mutation observer
    // to report, so watch the page's height as well. Guarded because
    // ResizeObserver is absent in jsdom and older browsers — where the mutation
    // path still covers everything it covered before.
    let resize: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(() => startPass());
      resize.observe(document.body);
    }

    // The reader wins: any touch, wheel, or key means they're driving now, so
    // the hold ends for good rather than fighting them for the scroll.
    const stop = () => {
      stopped = true;
      restoringRef.current = false;
      endPass(false);
      observer.disconnect();
      resize?.disconnect();
      for (const event of ABORT_EVENTS) {
        window.removeEventListener(event, stop);
      }
    };
    // The hold owns the anchor for its whole life, not just while a pass is
    // mid-flight: between passes the recorded position is the corrected one,
    // and letting the capture watcher overwrite it with whatever a settling
    // reflow looks like mid-way would be a step backwards.
    restoringRef.current = true;
    for (const event of ABORT_EVENTS) {
      window.addEventListener(event, stop, { passive: true });
    }
    startPass();
    return stop;
  }, [key, navigationType]);

  return null;
}
