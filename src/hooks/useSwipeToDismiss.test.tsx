import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSwipeToDismiss } from './useSwipeToDismiss';

// Threshold and timing in the hook (kept in sync with the source):
//   EXIT_DURATION_MS = 200; SWIPE_RATIO = 0.25; SWIPE_MIN_PX = 56;
// A 500-wide row → SWIPE_RATIO threshold = 125px ≥ SWIPE_MIN_PX, so 200px past
// start commits the swipe.

function makePointerEvent(
  type: string,
  init: { clientX: number; clientY: number; pointerId?: number; width?: number },
) {
  // useSwipeToDismiss reads currentTarget.getBoundingClientRect().width on
  // pointerdown to compute the per-direction commit threshold. React's
  // SyntheticEvent surfaces currentTarget as the bound element in JSX, but
  // when we call the bare handler with a constructed event we need to
  // provide it ourselves.
  const target = document.createElement('div');
  Object.defineProperty(target, 'getBoundingClientRect', {
    value: () => ({
      width: init.width ?? 500,
      height: 48,
      top: 0,
      left: 0,
      right: init.width ?? 500,
      bottom: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  return {
    type,
    clientX: init.clientX,
    clientY: init.clientY,
    pointerId: init.pointerId ?? 1,
    button: 0,
    pointerType: 'touch',
    currentTarget: target,
    setPointerCapture: vi.fn(),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent<HTMLElement>;
}

/** A click event whose currentTarget is a row `<article>` containing an action
 * button and a body link, with the clicked element as `target`. */
function makeClickEvent(target: Element, currentTarget: Element) {
  return {
    type: 'click',
    target,
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

/** Build a row `<article>` with a Pin button (icon span inside) and a body
 * link, mirroring ItemRow's structure. */
function makeRow() {
  const article = document.createElement('article');
  const button = document.createElement('button');
  const buttonIcon = document.createElement('span');
  button.appendChild(buttonIcon);
  const link = document.createElement('a');
  const linkText = document.createElement('span');
  link.appendChild(linkText);
  article.append(button, link);
  return { article, button, buttonIcon, link, linkText };
}

/** Arm `justSwiped` via a below-threshold horizontal scrub (mirrors a pinned/
 * library row where the swipe handlers are shielded but long-press keeps the
 * gesture machinery active). */
function armJustSwiped(handlers: ReturnType<typeof useSwipeToDismiss>['handlers']) {
  act(() => {
    handlers.onPointerDown(makePointerEvent('pointerdown', { clientX: 400, clientY: 24 }));
  });
  act(() => {
    handlers.onPointerMove(makePointerEvent('pointermove', { clientX: 380, clientY: 24 }));
  });
  act(() => {
    // 20px scrub is past START_THRESHOLD_PX (8) but under the commit threshold,
    // so it snaps back yet still marks the gesture as a swipe.
    handlers.onPointerUp(makePointerEvent('pointerup', { clientX: 380, clientY: 24 }));
  });
}

describe('useSwipeToDismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('snaps back to rest after a non-dismissal swipe (default)', () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() =>
      useSwipeToDismiss({ onSwipeLeft }),
    );

    // Swipe left past threshold (200px to the left of start).
    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent('pointerdown', { clientX: 400, clientY: 24 }),
      );
    });
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent('pointermove', { clientX: 200, clientY: 24 }),
      );
    });
    act(() => {
      result.current.handlers.onPointerUp(
        makePointerEvent('pointerup', { clientX: 200, clientY: 24 }),
      );
    });

    // Mid-dismiss: handler not yet fired, row translated off-screen.
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(result.current.isDismissing).toBe(true);
    expect(result.current.offset).not.toBe(0);

    // Past EXIT_DURATION_MS: handler fired, AND because dismissOnLeft is
    // false (default), the row snaps back to rest so the still-mounted row
    // returns to its resting position.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(result.current.isDismissing).toBe(false);
    expect(result.current.offset).toBe(0);
  });

  it('reset() clears the off-screen state so a rolled-back dismissal can re-render', () => {
    // Regression: when `dismissOnRight` holds the row off-screen past the
    // handler, the consumer must be able to snap it back if the dismissal
    // is undone before the parent's refetch dropped the row — otherwise
    // the same component would stay mounted at opacity 0.
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useSwipeToDismiss({ onSwipeRight, dismissOnRight: true }),
    );

    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent('pointerdown', { clientX: 100, clientY: 24 }),
      );
      result.current.handlers.onPointerMove(
        makePointerEvent('pointermove', { clientX: 300, clientY: 24 }),
      );
      result.current.handlers.onPointerUp(
        makePointerEvent('pointerup', { clientX: 300, clientY: 24 }),
      );
      vi.advanceTimersByTime(250);
    });
    expect(result.current.isDismissing).toBe(true);
    expect(result.current.offset).not.toBe(0);

    act(() => {
      result.current.reset();
    });
    expect(result.current.isDismissing).toBe(false);
    expect(result.current.offset).toBe(0);
  });

  it('holds off-screen state on a dismissal swipe so the row does not snap back before unmount', () => {
    // Regression: with the async data layer, the parent's unmount happens a
    // tick after the handler runs. The old snap-back reset flashed the row
    // back to its resting position before the parent dropped it.
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useSwipeToDismiss({ onSwipeRight, dismissOnRight: true }),
    );

    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent('pointerdown', { clientX: 100, clientY: 24 }),
      );
    });
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent('pointermove', { clientX: 300, clientY: 24 }),
      );
    });
    act(() => {
      result.current.handlers.onPointerUp(
        makePointerEvent('pointerup', { clientX: 300, clientY: 24 }),
      );
    });

    const offBefore = result.current.offset;
    expect(offBefore).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(250);
    });

    // Handler fired; the dismissed visual state persists so the parent's
    // pending unmount removes a row that's already off-screen + invisible
    // rather than one snapped back to the list.
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(result.current.isDismissing).toBe(true);
    expect(result.current.offset).toBe(offBefore);
  });

  describe('unmount during the exit window', () => {
    function swipeRight(handlers: ReturnType<typeof useSwipeToDismiss>['handlers']) {
      act(() => {
        handlers.onPointerDown(makePointerEvent('pointerdown', { clientX: 100, clientY: 24 }));
      });
      act(() => {
        handlers.onPointerMove(makePointerEvent('pointermove', { clientX: 300, clientY: 24 }));
      });
      act(() => {
        handlers.onPointerUp(makePointerEvent('pointerup', { clientX: 300, clientY: 24 }));
      });
    }

    it('commits a pending swipe action when the row unmounts before the exit timer fires', () => {
      // Regression: the unmount cleanup cleared the EXIT_DURATION_MS timer
      // without running the deferred handler, so swiping a row and then
      // navigating (or re-keying the list) within 200ms silently dropped the
      // user's Done/Pin.
      const onSwipeRight = vi.fn();
      const { result, unmount } = renderHook(() =>
        useSwipeToDismiss({ onSwipeRight, dismissOnRight: true }),
      );

      swipeRight(result.current.handlers);
      expect(onSwipeRight).not.toHaveBeenCalled();

      unmount();
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it('does not double-fire when the exit timer already ran', () => {
      const onSwipeRight = vi.fn();
      const { result, unmount } = renderHook(() =>
        useSwipeToDismiss({ onSwipeRight, dismissOnRight: true }),
      );

      swipeRight(result.current.handlers);
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(onSwipeRight).toHaveBeenCalledTimes(1);

      unmount();
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it('does not fire a commit that reset() rolled back', () => {
      const onSwipeRight = vi.fn();
      const { result, unmount } = renderHook(() =>
        useSwipeToDismiss({ onSwipeRight, dismissOnRight: true }),
      );

      swipeRight(result.current.handlers);
      act(() => {
        result.current.reset();
      });
      unmount();
      expect(onSwipeRight).not.toHaveBeenCalled();
    });
  });

  describe('onClickCapture', () => {
    it('does NOT swallow a tap on an action button after a scrub armed the swipe guard', () => {
      // Regression: a below-threshold scrub on the row body arms `justSwiped`;
      // the row's Pin/Done buttons stop their own pointerdown from reaching this
      // hook, so it never gets cleared by pressing them. Swallowing the button
      // click here made "Unpin" a silent no-op until a second tap.
      const { result } = renderHook(() =>
        // Long-press only (no swipe handlers) mirrors a pinned/library row: the
        // gesture machinery is still active, so a scrub still arms `justSwiped`.
        useSwipeToDismiss({ onLongPress: vi.fn() }),
      );
      armJustSwiped(result.current.handlers);

      const { article, button, buttonIcon } = makeRow();
      const e = makeClickEvent(buttonIcon, article);
      act(() => {
        result.current.handlers.onClickCapture(e);
      });

      // The button's own click proceeds — the guard let it through.
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.stopPropagation).not.toHaveBeenCalled();
      void button; // (button node participates via closest())
    });

    it('still swallows a tap on the row body link after a swipe', () => {
      const { result } = renderHook(() =>
        useSwipeToDismiss({ onLongPress: vi.fn() }),
      );
      armJustSwiped(result.current.handlers);

      const { article, linkText } = makeRow();
      const e = makeClickEvent(linkText, article);
      act(() => {
        result.current.handlers.onClickCapture(e);
      });

      // The body link's accidental post-swipe activation is still suppressed.
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
      expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('clears the guard after letting a button tap through so a later body tap works', () => {
      const { result } = renderHook(() =>
        useSwipeToDismiss({ onLongPress: vi.fn() }),
      );
      armJustSwiped(result.current.handlers);

      const { article, buttonIcon, linkText } = makeRow();
      // First: button tap passes through and disarms the guard.
      const buttonClick = makeClickEvent(buttonIcon, article);
      act(() => {
        result.current.handlers.onClickCapture(buttonClick);
      });
      expect(buttonClick.preventDefault).not.toHaveBeenCalled();

      // A subsequent body-link click is no longer swallowed (guard cleared),
      // so a normal tap isn't collateral-damaged by the earlier scrub.
      const bodyClick = makeClickEvent(linkText, article);
      act(() => {
        result.current.handlers.onClickCapture(bodyClick);
      });
      expect(bodyClick.preventDefault).not.toHaveBeenCalled();
    });
  });
});
