import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';

// Ported from newshacker verbatim — the swipe physics are reused as-is
// (SPEC.md *What is identical to newshacker*). Action-agnostic: the caller
// wires onSwipeLeft/onSwipeRight/onLongPress; a swipe whose handler is
// undefined falls through to the snap-back branch, which is exactly how the
// Pinned/Hidden "rubber-band shield" behavior is achieved upstream.

const SWIPE_RATIO = 0.25;
const SWIPE_MIN_PX = 56;
const ANGLE_RATIO = 1.2;
const START_THRESHOLD_PX = 8;
const EXIT_DURATION_MS = 200;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;

interface Options {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onLongPress?: () => void;
  enabled?: boolean;
  /** Whether a committed swipe in each direction unmounts the row. For
   * dismissals (`true`) the row stays translated off-screen + opacity 0 after
   * the handler fires, so the parent's unmount removes the element instead of
   * snapping it back into place. For save-and-stay actions (`false`,
   * the default — e.g. swipe-left-to-Pin keeps the row in the list) the
   * offset/opacity reset to 0 after the handler, snapping the row back to
   * its resting position. The default preserves the original snap-back
   * behavior; callers opt in per direction.
   *
   * Necessary because the data layer is async — `handleHide` marks the item
   * Done, but React Query takes a tick to refetch and drop the row, so a
   * blind snap-back here flashes the row back into place before unmount.
   * Snapping back early reads as "the swipe didn't take" before the row
   * finally disappears. */
  dismissOnLeft?: boolean;
  dismissOnRight?: boolean;
}

interface PointerStart {
  x: number;
  y: number;
  width: number;
  pointerId: number;
  swiping: boolean;
}

export function useSwipeToDismiss({
  onSwipeLeft,
  onSwipeRight,
  onLongPress,
  enabled = true,
  dismissOnLeft = false,
  dismissOnRight = false,
}: Options) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);

  const startRef = useRef<PointerStart | null>(null);
  const justSwipedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const onSwipeLeftRef = useRef(onSwipeLeft);
  const onSwipeRightRef = useRef(onSwipeRight);
  const onLongPressRef = useRef(onLongPress);

  useEffect(() => {
    onSwipeLeftRef.current = onSwipeLeft;
  }, [onSwipeLeft]);
  useEffect(() => {
    onSwipeRightRef.current = onSwipeRight;
  }, [onSwipeRight]);
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  }, [onLongPress]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current);
      }
      clearLongPressTimer();
    };
  }, [clearLongPressTimer]);

  const hasAnyHandler = !!(onSwipeLeft || onSwipeRight || onLongPress);
  const active = enabled && hasAnyHandler;

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (!active || isDismissing) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      justSwipedRef.current = false;
      const rect = e.currentTarget.getBoundingClientRect();
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: rect.width,
        pointerId: e.pointerId,
        swiping: false,
      };
      clearLongPressTimer();
      if (onLongPressRef.current) {
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null;
          justSwipedRef.current = true;
          startRef.current = null;
          onLongPressRef.current?.();
        }, LONG_PRESS_MS);
      }
    },
    [active, isDismissing, clearLongPressTimer],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (
        longPressTimerRef.current != null &&
        Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        clearLongPressTimer();
      }
      if (!start.swiping) {
        if (Math.abs(dx) < START_THRESHOLD_PX) return;
        if (Math.abs(dx) < Math.abs(dy) * ANGLE_RATIO) {
          startRef.current = null;
          clearLongPressTimer();
          return;
        }
        start.swiping = true;
        clearLongPressTimer();
        setDragging(true);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // jsdom / unsupported: safe to ignore
        }
      }
      setOffset(dx);
    },
    [clearLongPressTimer],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      const dx = e.clientX - start.x;
      const threshold = Math.max(SWIPE_MIN_PX, start.width * SWIPE_RATIO);
      const width = start.width;
      const wasSwiping = start.swiping;
      startRef.current = null;
      clearLongPressTimer();
      setDragging(false);

      const dir = dx >= 0 ? 1 : -1;
      const handler = dir > 0 ? onSwipeRightRef.current : onSwipeLeftRef.current;

      if (wasSwiping && Math.abs(dx) >= threshold && handler) {
        justSwipedRef.current = true;
        setIsDismissing(true);
        setOffset(dir * Math.max(width, 300));
        const willDismiss = dir > 0 ? dismissOnRight : dismissOnLeft;
        timeoutRef.current = window.setTimeout(() => {
          handler();
          // Save-and-stay (the default): the row will remain mounted, so
          // reset offset/isDismissing to snap it back to its resting
          // position. Dismissal directions skip the reset and stay
          // translated off-screen until the parent unmounts the row —
          // otherwise the row would visibly snap back into place during
          // the async unmount window and flash before disappearing.
          if (!willDismiss) {
            setIsDismissing(false);
            setOffset(0);
          }
        }, EXIT_DURATION_MS);
      } else {
        setOffset(0);
        if (wasSwiping) justSwipedRef.current = true;
      }
    },
    [clearLongPressTimer, dismissOnLeft, dismissOnRight],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      startRef.current = null;
      clearLongPressTimer();
      setDragging(false);
      setOffset(0);
    },
    [clearLongPressTimer],
  );

  // Snap the row back to rest. The consumer calls this when a committed
  // dismissal is undone (e.g. toolbar Undo flips `done` back to false before
  // the refetch dropped the row) or otherwise stays mounted — without it,
  // the off-screen `dismissOn*` state would leave the same component stuck
  // invisible until something else forces a remount.
  const reset = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsDismissing(false);
    setOffset(0);
  }, []);

  const onContextMenu = useCallback((e: MouseEvent) => {
    if (justSwipedRef.current || onLongPressRef.current) {
      e.preventDefault();
    }
  }, []);

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (!justSwipedRef.current) return;
    const currentTarget = e.currentTarget as Node | null;
    const target = e.target as Node | null;
    if (currentTarget && target && !currentTarget.contains(target)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    justSwipedRef.current = false;
  }, []);

  const style: CSSProperties =
    offset === 0 && !isDismissing
      ? {}
      : {
          transform: `translate3d(${offset}px, 0, 0)`,
          opacity: isDismissing ? 0 : Math.max(0.4, 1 - Math.abs(offset) / 500),
          transition: dragging
            ? 'none'
            : `transform ${EXIT_DURATION_MS}ms ease-out, opacity ${EXIT_DURATION_MS}ms ease-out`,
        };

  return {
    offset,
    dragging,
    isDismissing,
    reset,
    style,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
      onContextMenu,
    },
  };
}
