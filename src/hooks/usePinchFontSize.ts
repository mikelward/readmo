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
import { cancelPointerGestures } from '../lib/gestureCancel';

// Below this the two "fingers" are close enough that the ratio is mostly noise
// (a palm, or two touches landing on the same spot), and dividing by it would
// send the zoom to infinity.
const MIN_START_DISTANCE_PX = 24;

/**
 * Whether the browser offers page zoom at all here.
 *
 * An installed app does not, and the image carve-out below would otherwise
 * yield to a magnification that never arrives — pinching an article image in
 * the installed app would do nothing at all, the same "suppress the resize,
 * deliver no zoom" failure the `touch-action` walk exists to prevent, reached
 * through display mode instead.
 *
 * Both signals are asked because they answer for different platforms: iOS
 * reports a home-screen app through `navigator.standalone`, and Chrome reports
 * an installed PWA through the display-mode media query.
 *
 * A round of review argued the Android half should come out, on the grounds
 * that standalone presentation does not *by specification* disable page-scale
 * zoom when the viewport permits it — which is true, and it was removed. The
 * maintainer then confirmed the original report was an installed **Android**
 * PWA, on this app's already-permissive viewport, with no zoom available. So
 * it is back: what ships is what the device does, not what the spec allows.
 * Re-narrowing this needs a device that contradicts that, not an argument.
 *
 * Read live rather than cached at mount: the same bundle serves the installed
 * app and the tab.
 */
function browserZoomAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const iosHomeScreen = (
    window.navigator as Navigator & { standalone?: boolean }
  ).standalone;
  if (iosHomeScreen) return false;
  const installed =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches);
  return !installed;
}

/** `touch-action` values under which the browser will still pinch-zoom. Anything
 * else — `pan-y`, `none` — means it has been told not to, so standing aside
 * would hand the gesture to nobody. */
function allowsPinchZoom(touchAction: string): boolean {
  return (
    touchAction === 'auto' ||
    touchAction === 'manipulation' ||
    touchAction.includes('pinch-zoom')
  );
}

/**
 * Where a pinch means what it has always meant, and this hook keeps its hands
 * off: an image the browser would actually zoom.
 *
 * Resizing text is the right answer for a pinch on *text* — it reflows to the
 * viewport instead of leaving the reader panning sideways across a magnified
 * column. It is no answer at all for a pinch on a photograph or a chart, which
 * a text ladder cannot magnify at any size. So the browser keeps that one,
 * which is also what keeps the override from costing the magnification some
 * readers depend on (WCAG 1.4.4).
 *
 * The `touch-action` walk is what makes that true rather than merely intended.
 * `touch-action` composes down the ancestor chain, and an article row sets
 * `pan-y` so its swipe can own horizontal movement — which also excludes
 * pinch-zoom. Standing aside on a row's thumbnail would therefore suppress the
 * resize and deliver no zoom: the worst of both. Where nobody would zoom, this
 * hook may as well resize, so it does.
 *
 * Relaxing the row to `pan-y pinch-zoom` was the other way to square it, and is
 * worse: the browser claims a pinch it is allowed to claim, stops sending
 * cancelable moves, and text resizing dies on the list — the surface the
 * gesture exists for.
 */
/**
 * What counts as "something a text ladder cannot magnify".
 *
 * Deliberately *not* a bare `svg`. Every Material control glyph in this app is
 * an inline `<svg>`, and `.tooltip-button` is `touch-action: manipulation`,
 * which permits pinch-zoom — so a bare `svg` here handed the browser the whole
 * page whenever a finger landed on Pin, Done, or a toolbar icon. That is the
 * opposite of what the gesture promises, and on the controls it is easiest to
 * grab by accident.
 *
 * A genuine zoomable graphic — a chart, a diagram — opts in with
 * `data-native-zoom` instead. Publisher content arrives as sanitized HTML and
 * its images are `<img>`, which is covered; an exotic inline `<svg>` in an
 * article resizes text rather than zooming, which is the harmless way to be
 * wrong.
 */
const CONTENT_MEDIA = 'img, picture, video, canvas, [data-native-zoom]';

/**
 * App chrome that happens to be drawn with a real image — a feed's favicon, the
 * account avatar. Both are `<img>`, so `CONTENT_MEDIA` catches them and a pinch
 * that clipped one handed the browser the whole page, the same way a bare `svg`
 * did for the Material glyphs.
 *
 * The test is the page's own accessibility markup rather than a list of class
 * names: an image marked decorative is by definition not the content, so it is
 * not what a reader is trying to magnify, and any future chrome icon that
 * follows the same practice is excluded the day it lands. An explicit
 * `data-native-zoom` still wins — that is the opt-in, and it is checked first.
 *
 * `aria-hidden` and **not** an empty `alt`, which would look equivalent and is
 * not. The sanitizer's `img` allowlist passes `alt` through and drops
 * `aria-hidden` (`supabase/functions/_shared/sanitize.ts`), so `alt=""` is
 * publisher-controlled — and it is a normal way to publish an unlabeled
 * photograph. Reading it here would have classified real article images as
 * chrome and taken their native zoom away. `aria-hidden` is unreachable for
 * publisher content by construction, which is what makes it an app-owned
 * marker; both chrome icons this exists for set it.
 */
function isDecorative(el: Element): boolean {
  if (el.hasAttribute('data-native-zoom')) return false;
  return el.getAttribute('aria-hidden') === 'true';
}

function targetYieldsToNativeZoom(target: EventTarget | null): boolean {
  if (!browserZoomAvailable()) return false;
  if (!(target instanceof Element)) return false;
  const zoomable = target.closest(CONTENT_MEDIA);
  if (!zoomable) return false;
  if (isDecorative(zoomable)) return false;
  for (let el: Element | null = zoomable; el; el = el.parentElement) {
    if (!allowsPinchZoom(getComputedStyle(el).touchAction)) return false;
  }
  return true;
}

/**
 * Whether the pinch *includes* something to zoom, asked of every finger.
 *
 * A `TouchEvent`'s own `target` is only the touch that changed — the second
 * finger, at the moment the gesture becomes a pinch. Reading that alone makes
 * the carve-out depend on which finger landed last: an image pinched from
 * inside-then-out would be claimed and its zoom suppressed, while the same
 * pinch made in the other order would yield. Each `Touch` carries its own
 * target, so ask all of them.
 *
 * Any finger is enough. Someone pinching a photograph with one finger just off
 * its edge means the photograph, and guessing the other way suppresses the only
 * thing that would have helped them.
 */
function touchesYieldToNativeZoom(touches: TouchList): boolean {
  for (let i = 0; i < touches.length; i++) {
    if (targetYieldsToNativeZoom(touches[i]?.target ?? null)) return true;
  }
  return false;
}

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
 * This hook is also the *whole* of the browser-zoom suppression: the viewport
 * meta deliberately does not carry `user-scalable=no`. Canceling per gesture
 * rather than locking the viewport is what lets the pinch yield on an image
 * (see `yieldsToNativeZoom`), where magnifying is the only thing that helps and
 * a text ladder cannot, and what leaves native zoom working everywhere if this
 * script never loads. A blanket lock would buy nothing over this and is the
 * shape that fails WCAG 1.4.4.
 */
export function usePinchFontSize(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let gesture: Gesture | null = null;
    // Whether two or more fingers are currently on the glass. Distinguishes a
    // touch pinch this hook can answer from desktop Safari's trackpad pinch,
    // which fires `gesture*` and no touch events at all.
    let touchPinchActive = false;
    // Whether `begin` stood aside for the browser on the fingers currently
    // down. Safari's `gesture*` events carry no touch list, and their single
    // target is the two fingers' common ancestor — which is not the image even
    // when a finger is on one. Re-deciding from that target alone would
    // `preventDefault()` the very zoom the touch path just yielded to, so the
    // decision is made once, from every finger, and read back here.
    let yieldingToNativeZoom = false;

    // Whatever is on screen is what the user chose — including when the system
    // took the gesture away mid-pinch (touchcancel). Silently reverting to the
    // pre-pinch size would undo a change they watched happen.
    const commit = () => {
      if (!gesture) return;
      const { base, showing } = gesture;
      gesture = null;
      if (showing !== base) setStoredFontSize(showing);
    };

    /**
     * Try to start tracking from wherever the two fingers are now.
     *
     * Separate from the stand-down broadcast and the yield decision, both of
     * which belong to the interaction and happen once, because this may be
     * retried: two fingers can land closer together than the minimum and only
     * then spread.
     */
    const armGesture = (e: TouchEvent) => {
      if (gesture || yieldingToNativeZoom) return;
      const startDistance = touchDistance(e.touches);
      if (startDistance < MIN_START_DISTANCE_PX) return;
      const base = getStoredFontSize();
      gesture = { base, startDistance, steps: 0, showing: base };
    };

    /**
     * The hand on the glass has changed and nothing is armed: decide who owns
     * the gesture, then try to arm if it is a pair.
     *
     * Asked of any count of two or more, not just an exact pair. Three fingers
     * landing together is still a pinch the browser would zoom, and `onTouchMove`
     * suppresses from two contacts up — so leaving the question undecided until
     * the count fell to two would mean canceling a zoom nobody had decided to
     * take. Arming stays exclusive to a pair, since a ratio needs two points.
     */
    const startInteraction = (e: TouchEvent) => {
      if (gesture) return;
      yieldingToNativeZoom = touchesYieldToNativeZoom(e.touches);
      if (yieldingToNativeZoom) return;
      if (e.touches.length === 2) armGesture(e);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        touchPinchActive = true;
        // Stand the single-pointer gestures down BEFORE deciding whether this
        // pinch is even ours. Two fingers are down, so whatever swipe or pull
        // was in flight is no longer what the user means — and the cases we
        // decline are exactly the ones nothing else rescues. Yielding to native
        // zoom does not: `.item-row` declares `touch-action: pan-y`, so on a
        // row's thumbnail the browser will not take the gesture over, and
        // therefore never fires the `pointercancel` that would have cleared it.
        //
        // Re-asserted on every additional finger, not just the second: a third
        // finger's `pointerdown` reaches the document before its `touchstart`
        // and disarms the click latch, so without re-arming here the first
        // finger's trailing click would still land on whatever it started on.
        cancelPointerGestures();
      }
      // A third finger arriving mid-pinch makes the next ratio meaningless (a
      // different pair of touches), so bank the gesture rather than let it jump.
      if (e.touches.length !== 2) commit();
      startInteraction(e);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        if (gesture) commit();
        return;
      }
      // The browser's gesture, not ours — leave every part of it alone.
      if (yieldingToNativeZoom) return;
      // Claim the gesture: without this the page also pans under the fingers,
      // and on Android it pinch-zooms. Done before arming, because a pair that
      // landed too close together to measure is still ours — Safari's zoom is
      // already suppressed for it, so letting Chromium zoom instead would make
      // the same pinch do different wrong things on the two engines.
      if (e.cancelable) e.preventDefault();
      // Three fingers: the size is banked, because the ratio now describes a
      // different pair. The cancel above still has to run every frame, though.
      // Chromium pinch-zooms from three contacts as readily as two, and page
      // scaling is not something re-arming the remaining pair can undo when the
      // extra finger lifts — so bailing out before the cancel would let a
      // stray third finger permanently defeat the per-gesture suppression.
      if (e.touches.length > 2) {
        commit();
        return;
      }
      if (!gesture) {
        // Two fingers that landed inside the minimum distance and have now
        // spread far enough to mean something.
        armGesture(e);
        if (!gesture) return;
      }
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
      if (e.touches.length < 2) {
        commit();
        // Hold both flags until the hand is off the glass: Safari's
        // `gestureend`, and any trailing `gesturechange`, arrive after the
        // `touchend` that drops below two fingers, and clearing early would
        // cut the tail off a native zoom — or stop suppressing one mid-pinch.
        // A fresh pinch re-decides in `startInteraction`.
        if (e.touches.length === 0) {
          yieldingToNativeZoom = false;
          touchPinchActive = false;
        }
        return;
      }
      // Two or more left: a finger that banked the gesture has lifted. Re-decide
      // and, at a pair, re-arm from where those two are now — measuring from
      // here rather than from a baseline taken before the lifted finger existed.
      startInteraction(e);
    };

    // iOS Safari: `gesture*` is the sole lever there, since Safari has ignored
    // `user-scalable` since iOS 10. Same carve-out as the touch path, so an
    // article's images still zoom natively.
    const preventGesture = (e: Event) => {
      // Only when fingers are actually on the glass. macOS Safari fires these
      // for a *trackpad* pinch with no touch events behind them, so nothing
      // here could resize the text from one — preventing it would take the
      // page zoom away and offer nothing back, which is the failure this whole
      // carve-out exists to avoid. Desktop keeps its native zoom; the ladder is
      // still reachable there from Settings.
      //
      // Resizing text from `GestureEvent.scale` instead was the alternative.
      // Declined: it is a new behavior on a platform this change was not asked
      // to cover and cannot be tested from here, and desktop zoom is the better
      // answer anyway — it magnifies images and chrome, which reflowing cannot.
      if (!touchPinchActive) return;
      // The touch path decided the image question for the whole gesture, across
      // every finger; honor it rather than re-deriving a worse answer from the
      // one target a `GestureEvent` carries.
      if (yieldingToNativeZoom || targetYieldsToNativeZoom(e.target)) return;
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
