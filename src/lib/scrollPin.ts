// A portable "hold the reader's scroll position across a dismissing mutation"
// primitive. See ItemList's single-dismiss path.
//
// The problem: marking a row Done momentarily collapses the list (a transient
// reflow) before it settles one row shorter. If the reader is scrolled past that
// momentary floor, the browser clamps the scroll toward the top — and never
// restores it once the document recovers (the "jump to top on dismiss" bug).
//
// The old defense froze the document tall (min-height) and opted out of the
// browser's scroll anchoring (overflow-anchor: none). That machinery is fragile
// — a web of release-timing races shared across Sweep / auto-hide / refetch —
// and `overflow-anchor` isn't even supported on iOS Safari, so half of it is a
// no-op there. Instead we do the simplest portable thing: remember where the
// reader was, and put them back once the document can hold that offset again.
// Pure scrollTo, no layout freeze — identical behavior on iOS and Chromium.
//
// TODO: this is deliberately generic. Once it's proven on the single-dismiss
// path, apply it to Sweep and auto-hide-on-scroll too and delete the
// min-height/overflow-anchor lock machinery (lockBodyHeight / releaseBodyHeight
// and their release effects) that those paths still depend on.

/** Injected environment so the logic is testable without a real scroller. */
export interface ScrollPinEnv {
  /** Current scroll offset. */
  scrollY: () => number;
  /** Max valid scroll offset right now (`scrollHeight − viewport height`). */
  maxScroll: () => number;
  /** Move the scroller to `y`. */
  scrollTo: (y: number) => void;
  /** Schedule `cb` for the next frame; returns a handle for {@link ScrollPinEnv.cancelFrame}. */
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
  /** Register a one-shot "reader took over" interrupt (wheel / touch / key).
   * Returns a detach fn. Must NOT fire on programmatic scrollTo (listen to
   * input events, not `scroll`), or the pin would abort itself. */
  onInterrupt: (cb: () => void) => () => void;
}

/** How many frames to watch for the clamp-and-recover before giving up
 * (~200ms at 60fps). The recovery is typically 2–3 frames; this is a safe
 * ceiling so a document that never recovers (a genuinely shorter list) doesn't
 * leave the watcher running. */
export const DEFAULT_PIN_FRAMES = 12;

/**
 * Hold `targetY` across a dismiss that transiently shrinks the document. Watches
 * up to `maxFrames`: on each frame, if the scroll was clamped short
 * (`scrollY < targetY`) and the document can now hold `targetY`
 * (`maxScroll >= targetY`), restore it and stop. Aborts the moment the reader
 * scrolls / touches / keys — they've taken over. A no-op when already at the top
 * (`targetY <= 0`: nothing above to clamp toward).
 *
 * Returns a cancel fn (idempotent) — call it on unmount or before starting a new
 * pin.
 */
export function pinScrollAcross(
  targetY: number,
  env: ScrollPinEnv,
  maxFrames: number = DEFAULT_PIN_FRAMES,
): () => void {
  if (targetY <= 0) return () => {};

  let frame = 0;
  let handle = 0;
  let done = false;
  let detachInterrupt: (() => void) | null = null;

  const stop = () => {
    if (done) return;
    done = true;
    if (handle) env.cancelFrame(handle);
    detachInterrupt?.();
    detachInterrupt = null;
  };

  const step = () => {
    frame += 1;
    if (env.scrollY() < targetY && env.maxScroll() >= targetY) {
      env.scrollTo(targetY);
      stop();
      return;
    }
    if (frame >= maxFrames) {
      stop();
      return;
    }
    handle = env.requestFrame(step);
  };

  detachInterrupt = env.onInterrupt(stop);
  handle = env.requestFrame(step);
  return stop;
}
