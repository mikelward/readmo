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
});
