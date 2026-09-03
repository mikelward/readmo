import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePinchFontSize } from './usePinchFontSize';
import { ZOOM_PER_STEP } from '../lib/pinchFontSize';
import { FONT_SIZE_STORAGE_KEY } from '../lib/theme';

/** jsdom has no real TouchEvent, and the hook only ever reads `touches`
 * — so a plain cancelable Event carrying that list exercises the same path
 * while letting a test assert `defaultPrevented`. */
function fireTouch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  xs: number[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: xs.map((clientX) => ({ clientX, clientY: 0 })),
  });
  window.dispatchEvent(event);
  return event;
}

/** Two fingers `spread` px apart, centered so neither finger's position
 * matters — only the gap does. */
const pinchTo = (
  type: 'touchstart' | 'touchmove',
  spread: number,
): Event => fireTouch(type, [0, spread]);

const attribute = () => document.documentElement.getAttribute('data-font-size');
const stored = () => window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);

// 100px start gap: a step out lands at 112px, a step in at ~89px.
const START = 100;
const OUT_ONE_STEP = START * ZOOM_PER_STEP;
const OUT_TWO_STEPS = START * ZOOM_PER_STEP ** 2;
const IN_ONE_STEP = START / ZOOM_PER_STEP;

describe('usePinchFontSize', () => {
  beforeEach(() => {
    renderHook(() => usePinchFontSize());
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('repaints as the fingers move without writing storage', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    expect(attribute()).toBe('17');
    pinchTo('touchmove', OUT_TWO_STEPS);
    expect(attribute()).toBe('18');
    // Still mid-gesture: the size on screen is a preview, not a decision.
    expect(stored()).toBeNull();
  });

  it('persists once, at the size the gesture settled on', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_TWO_STEPS);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchend', []);
    expect(stored()).toBe('17');
    expect(attribute()).toBe('17');
  });

  it('walks back down the ladder when the fingers close', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', IN_ONE_STEP);
    fireTouch('touchend', []);
    expect(stored()).toBe('15');
  });

  it('measures every step from the size the fingers landed on', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '20');
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchend', []);
    expect(stored()).toBe('22');
  });

  it('clamps at the end of the ladder but remembers the overshoot', () => {
    pinchTo('touchstart', START);
    // From the 16px default that is 14 rungs' worth of spread against a ladder
    // that has 10 left, so it clamps with two steps of overshoot banked.
    pinchTo('touchmove', START * ZOOM_PER_STEP ** 12);
    expect(attribute()).toBe('32');
    // Coming back to one step out from the *base* gives 17, not the 30 a
    // gesture that had clamped its own count would report: the fingers, not the
    // end of the ladder, say where the size is.
    pinchTo('touchmove', START * ZOOM_PER_STEP);
    expect(attribute()).toBe('17');
    fireTouch('touchend', []);
    expect(stored()).toBe('17');
  });

  it('writes nothing when the gesture ends where it started', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    pinchTo('touchmove', START);
    fireTouch('touchend', []);
    expect(stored()).toBeNull();
    expect(attribute()).toBeNull();
  });

  it('claims the gesture so the page cannot pan or zoom under it', () => {
    pinchTo('touchstart', START);
    expect(pinchTo('touchmove', OUT_ONE_STEP).defaultPrevented).toBe(true);
  });

  it('leaves one-finger touches entirely alone', () => {
    fireTouch('touchstart', [0]);
    const move = fireTouch('touchmove', [40]);
    expect(move.defaultPrevented).toBe(false);
    expect(attribute()).toBeNull();
  });

  it('ignores two touches that land on top of each other', () => {
    // Below the minimum start gap the ratio is noise, and dividing by it would
    // send the zoom to infinity.
    pinchTo('touchstart', 8);
    pinchTo('touchmove', 200);
    expect(attribute()).toBeNull();
  });

  it('banks the gesture when a third finger arrives', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchstart', [0, OUT_ONE_STEP, 300]);
    expect(stored()).toBe('17');
    // The third finger's frame must not be read as a zoom off the old pair.
    fireTouch('touchmove', [0, 500, 900]);
    expect(attribute()).toBe('17');
  });

  it('keeps what the user watched happen when the system takes the gesture', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchcancel', []);
    expect(stored()).toBe('17');
  });

  it("cancels Safari's own zoom, which the viewport meta cannot", () => {
    const start = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    const change = new Event('gesturechange', { cancelable: true });
    document.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(true);
  });
});

describe('usePinchFontSize teardown', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => usePinchFontSize());
    unmount();
    fireTouch('touchstart', [0, START]);
    const move = fireTouch('touchmove', [0, OUT_ONE_STEP]);
    expect(move.defaultPrevented).toBe(false);
    expect(document.documentElement.getAttribute('data-font-size')).toBeNull();
    const gesture = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(false);
  });
});
