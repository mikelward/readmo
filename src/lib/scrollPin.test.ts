import { describe, expect, it } from 'vitest';
import { pinScrollAcross, type ScrollPinEnv } from './scrollPin';

/** A controllable scroller: a manual frame queue, mutable scrollY/maxScroll, a
 * recorded scrollTo, and a triggerable reader interrupt. */
function makeEnv(initial: { scrollY: number; maxScroll: number }) {
  let scrollY = initial.scrollY;
  let maxScroll = initial.maxScroll;
  const frames: Array<() => void> = [];
  const scrollToCalls: number[] = [];
  let interruptCb: (() => void) | null = null;
  let detached = false;

  const env: ScrollPinEnv = {
    scrollY: () => scrollY,
    maxScroll: () => maxScroll,
    scrollTo: (y) => {
      scrollToCalls.push(y);
      scrollY = Math.min(y, maxScroll);
    },
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length; // 1-based handle
    },
    cancelFrame: (handle) => {
      frames[handle - 1] = () => {};
    },
    onInterrupt: (cb) => {
      interruptCb = cb;
      return () => {
        detached = true;
        interruptCb = null;
      };
    },
  };

  return {
    env,
    scrollToCalls,
    setScrollY: (y: number) => {
      scrollY = y;
    },
    setMaxScroll: (m: number) => {
      maxScroll = m;
    },
    /** Run the next queued frame callback, if any. */
    tick: () => {
      const cb = frames.shift();
      if (cb) cb();
    },
    pendingFrames: () => frames.length,
    fireInterrupt: () => interruptCb?.(),
    isDetached: () => detached,
  };
}

describe('pinScrollAcross', () => {
  it('restores the reader once the document recovers enough to hold the offset', () => {
    // Reader parked at 994; the dismiss clamps to 561 while the doc is briefly
    // short (max 561), then the doc recovers to 1339.
    const h = makeEnv({ scrollY: 561, maxScroll: 561 });
    pinScrollAcross(994, h.env);

    // Frame 1: still clamped, doc can't hold 994 yet → keep watching.
    h.tick();
    expect(h.scrollToCalls).toEqual([]);

    // Doc recovers.
    h.setMaxScroll(1339);
    h.tick();
    expect(h.scrollToCalls).toEqual([994]);
    expect(h.isDetached()).toBe(true); // cleaned up after restore
  });

  it('does nothing when the scroll was never clamped', () => {
    const h = makeEnv({ scrollY: 994, maxScroll: 1339 });
    pinScrollAcross(994, h.env);
    for (let i = 0; i < 15; i++) h.tick();
    expect(h.scrollToCalls).toEqual([]);
  });

  it('gives up (no restore) if the document never recovers', () => {
    // The list is genuinely shorter now — targetY is no longer a valid offset,
    // so we must not force the reader to an impossible position.
    const h = makeEnv({ scrollY: 300, maxScroll: 300 });
    pinScrollAcross(994, h.env, 5);
    for (let i = 0; i < 10; i++) h.tick();
    expect(h.scrollToCalls).toEqual([]);
    expect(h.pendingFrames()).toBe(0); // stopped scheduling after the cap
  });

  it('aborts when the reader takes over before recovery', () => {
    const h = makeEnv({ scrollY: 561, maxScroll: 561 });
    pinScrollAcross(994, h.env);
    h.tick();
    // Reader scrolls/touches — hand control back.
    h.fireInterrupt();
    h.setMaxScroll(1339);
    h.tick();
    expect(h.scrollToCalls).toEqual([]);
    expect(h.isDetached()).toBe(true);
  });

  it('is a no-op at the top of the list', () => {
    const h = makeEnv({ scrollY: 0, maxScroll: 0 });
    const cancel = pinScrollAcross(0, h.env);
    expect(h.pendingFrames()).toBe(0);
    // Cancel is safe to call.
    cancel();
  });

  it('cancel stops the watcher', () => {
    const h = makeEnv({ scrollY: 561, maxScroll: 561 });
    const cancel = pinScrollAcross(994, h.env);
    cancel();
    h.setMaxScroll(1339);
    h.tick();
    expect(h.scrollToCalls).toEqual([]);
    expect(h.isDetached()).toBe(true);
  });
});
