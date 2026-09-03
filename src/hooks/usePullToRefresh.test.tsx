import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePullToRefresh } from './usePullToRefresh';
import { cancelPointerGestures } from '../lib/gestureCancel';

// Thresholds in the hook (kept in sync with the source):
//   START_THRESHOLD_PX = 8; TRIGGER_PX = 64; RESISTANCE = 0.5.
// A 160px downward drag → (160 - 8) * 0.5 = 76px displayed ≥ TRIGGER_PX,
// so releasing commits the refresh.

function makePointerEvent(init: {
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType?: string;
  buttons?: number;
}) {
  return {
    clientX: init.clientX,
    clientY: init.clientY,
    pointerId: init.pointerId,
    pointerType: init.pointerType ?? 'touch',
    button: 0,
    buttons: init.buttons ?? 1,
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

  it('drops a stale mouse press (released outside) on a button-less move instead of arming a phantom pull', () => {
    // Regression: capture is only taken once the pull arms, so a mouse press
    // at scroll-top released outside the container (up over the app header)
    // never delivered its pointerup. The stale start then blocked real pulls,
    // and a button-less hover back down the list re-armed the "pull" — a later
    // click far enough below the stale start triggered a spurious refresh.
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      usePullToRefresh({ onRefresh, isAtTop: () => true }),
    );

    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent({ clientX: 100, clientY: 50, pointerId: 1, pointerType: 'mouse' }),
      );
    });
    // (mouse released outside the container — no pointerup delivered)

    // Button-less hover back over the list: must drop the stale start, not
    // arm a pull.
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent({
          clientX: 100,
          clientY: 150,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 0,
        }),
      );
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.pull).toBe(0);

    // A later plain click 200px below the stale start must not refresh.
    act(() => {
      result.current.handlers.onPointerUp(
        makePointerEvent({
          clientX: 100,
          clientY: 250,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 0,
        }),
      );
    });
    expect(onRefresh).not.toHaveBeenCalled();

    // And the gesture isn't wedged: a fresh press starts a real pull.
    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent({ clientX: 100, clientY: 100, pointerId: 1, pointerType: 'mouse' }),
      );
    });
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent({ clientX: 100, clientY: 200, pointerId: 1, pointerType: 'mouse' }),
      );
    });
    expect(result.current.phase).toBe('pulling');
  });
  it('abandons a pull armed in the same tick a pinch claims the fingers', () => {
    // The race: the second finger lands just as the first crosses the arm
    // threshold. `setPhase('pulling')` is queued but the effect that syncs
    // `phaseRef` has not run, so a cancel handler that trusts the ref alone
    // reads `idle`, clears the tracked pointer, and skips the reset — leaving
    // the queued `pulling` painted with nothing left to finish it.
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      usePullToRefresh({ onRefresh, isAtTop: () => true }),
    );

    act(() => {
      result.current.handlers.onPointerDown(
        makePointerEvent({ clientX: 100, clientY: 100, pointerId: 1 }),
      );
    });
    // Arm and cancel inside one act(), so no effect flushes between them.
    act(() => {
      result.current.handlers.onPointerMove(
        makePointerEvent({ clientX: 100, clientY: 200, pointerId: 1 }),
      );
      cancelPointerGestures();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.pull).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
