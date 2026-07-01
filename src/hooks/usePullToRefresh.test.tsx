import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePullToRefresh } from './usePullToRefresh';

// Thresholds in the hook (kept in sync with the source):
//   START_THRESHOLD_PX = 8; TRIGGER_PX = 64; RESISTANCE = 0.5.
// A 160px downward drag → (160 - 8) * 0.5 = 76px displayed ≥ TRIGGER_PX,
// so releasing commits the refresh.

function makePointerEvent(init: { clientX: number; clientY: number; pointerId: number }) {
  return {
    clientX: init.clientX,
    clientY: init.clientY,
    pointerId: init.pointerId,
    pointerType: 'touch',
    button: 0,
    currentTarget: { setPointerCapture: vi.fn() },
    preventDefault: vi.fn(),
  } as unknown as React.PointerEvent<HTMLElement>;
}

describe('usePullToRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores a second concurrent pointer so the held pull survives its tap-release', () => {
    // Regression: a second fingertip touching the list mid-pull overwrote the
    // tracked start state; its (unarmed) release then reset the actively held
    // pull back to idle, and the first finger's release was ignored.
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      usePullToRefresh({ onRefresh, isAtTop: () => true }),
    );

    // First finger starts a pull and arms it (past the 8px start threshold).
    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent({ clientX: 100, clientY: 100, pointerId: 1 }),
      );
    });
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent({ clientX: 100, clientY: 200, pointerId: 1 }),
      );
    });
    expect(result.current.phase).toBe('pulling');
    expect(result.current.pull).toBeGreaterThan(0);

    // A second fingertip touches and lifts while the pull is held.
    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent({ clientX: 200, clientY: 300, pointerId: 2 }),
      );
      result.current.handlers.onPointerUp(
        makePointerEvent({ clientX: 200, clientY: 300, pointerId: 2 }),
      );
    });
    // The held pull is unaffected — not snapped back to idle.
    expect(result.current.phase).toBe('pulling');
    expect(result.current.pull).toBeGreaterThan(0);

    // The first finger keeps pulling and releases past the trigger.
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent({ clientX: 100, clientY: 260, pointerId: 1 }),
      );
    });
    act(() => {
      result.current.handlers.onPointerUp(
        makePointerEvent({ clientX: 100, clientY: 260, pointerId: 1 }),
      );
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
