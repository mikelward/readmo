import { useEffect } from 'react';
import {
  applyFontSize,
  getStoredFontSize,
  setStoredFontSize,
  type FontSize,
} from '../lib/theme';
import {
  fontSizeAfterSteps,
  touchDistance,
  zoomSteps,
} from '../lib/pinchFontSize';

// Below this the two "fingers" are close enough that the ratio is mostly noise
// (a palm, or two touches landing on the same spot), and dividing by it would
// send the zoom to infinity.
const MIN_START_DISTANCE_PX = 24;

interface Gesture {
  /** The size in force when the fingers landed — every step is measured from
   * here, so the whole gesture is one edit rather than a chain of them. */
  base: FontSize;
  /** Finger spread at the start, the denominator of the zoom ratio. */
  startDistance: number;
  /** Ladder offset currently on screen, fed back into `zoomSteps` so its
   * hysteresis has something to be sticky about. */
  steps: number;
  /** What `applyFontSize` last painted, so a frame that doesn't change the
   * step doesn't touch the DOM. */
  showing: FontSize;
}

/**
 * A two-finger pinch anywhere in the app resizes readmo's text, stepping
 * through the same six canned sizes the Settings picker offers (SPEC.md
 * *Appearance* → *Text size*).
 *
 * Preview-live, persist-on-release, the shape simmo's pinch uses: every frame
 * repaints through `applyFontSize`, which only moves the `data-font-size`
 * attribute, and only the release calls `setStoredFontSize` — so the text
 * resizes under the fingers while localStorage and the `useTheme` subscribers
 * see exactly one change per gesture, at the size it actually settled on.
 *
 * Also the enforcement half of the mobile viewport lock. `user-scalable=no` in
 * the viewport meta covers Android, but iOS Safari has ignored that since iOS
 * 10 — Safari's own `gesture*` events are the only lever there, so the lock has
 * to be code as well as a meta tag. Both are unconditional: they must hold on
 * every page, not just the ones a pinch happens to resize.
 */
export function usePinchFontSize(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let gesture: Gesture | null = null;

    // Whatever is on screen is what the user chose — including when the system
    // took the gesture away mid-pinch (touchcancel). Silently reverting to the
    // pre-pinch size would undo a change they watched happen.
    const commit = () => {
      if (!gesture) return;
      const { base, showing } = gesture;
      gesture = null;
      if (showing !== base) setStoredFontSize(showing);
    };

    const onTouchStart = (e: TouchEvent) => {
      // A third finger arriving mid-pinch makes the next ratio meaningless (a
      // different pair of touches), so bank the gesture rather than let it
      // jump. Lifting back to two fingers starts a fresh one.
      if (e.touches.length !== 2) {
        commit();
        return;
      }
      if (gesture) return;
      const startDistance = touchDistance(e.touches);
      if (startDistance < MIN_START_DISTANCE_PX) return;
      const base = getStoredFontSize();
      gesture = { base, startDistance, steps: 0, showing: base };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!gesture) return;
      if (e.touches.length !== 2) {
        commit();
        return;
      }
      // Claim the gesture: without this the page also pans under the fingers,
      // and on Android it pinch-zooms.
      if (e.cancelable) e.preventDefault();
      const steps = zoomSteps(
        touchDistance(e.touches) / gesture.startDistance,
        gesture.steps,
      );
      const showing = fontSizeAfterSteps(gesture.base, steps);
      gesture.steps = steps;
      if (showing === gesture.showing) return;
      gesture.showing = showing;
      applyFontSize(showing);
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) commit();
    };

    // iOS Safari only. Blocks the page zoom the viewport meta can't.
    const preventGesture = (e: Event) => {
      if (e.cancelable) e.preventDefault();
    };

    // `passive: false` on the two we preventDefault — Chrome makes touchmove
    // passive by default at the document level, which would make the call a
    // silent no-op and leave the page zooming under the pinch.
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    document.addEventListener('gesturestart', preventGesture, {
      passive: false,
    });
    document.addEventListener('gesturechange', preventGesture, {
      passive: false,
    });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
    };
  }, []);
}
