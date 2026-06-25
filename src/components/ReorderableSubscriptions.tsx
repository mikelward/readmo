import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Feed, FeedId, Subscription } from '../lib/types';
import { arrayMove, orderForPointer } from '../lib/arrayMove';
import { DragHandle } from './icons';

export interface SubscriptionEntry {
  subscription: Subscription;
  feed: Feed;
}

interface Props {
  subs: SubscriptionEntry[];
  /** Persist a new feed order — every feed id, in the desired order. */
  onReorder: (orderedFeedIds: FeedId[]) => void;
  onMute: (feedId: FeedId, muted: boolean) => void;
  onUnsubscribe: (feedId: FeedId) => void;
}

/** The Settings subscriptions list with drag-to-reorder handles. The handle is
 * both pointer-draggable (mouse + touch) and keyboard-operable (focus it, then
 * ArrowUp/ArrowDown) so reordering isn't mouse-only. Each row stays within the
 * 3-tap-zone cap: drag handle, Mute, Unsubscribe. Order is held locally for a
 * snappy drag and persisted via `onReorder` on drop / each keyboard move; the
 * parent's refetch then re-syncs `subs`. */
export function ReorderableSubscriptions({
  subs,
  onReorder,
  onMute,
  onUnsubscribe,
}: Props) {
  const propIds = subs.map((s) => s.feed.id);
  const [order, setOrder] = useState<FeedId[]>(propIds);
  const dragging = useRef<{ id: FeedId; startOrder: FeedId[] } | null>(null);
  const [draggingId, setDraggingId] = useState<FeedId | null>(null);

  // Local `order` is authoritative while the user is interacting. We re-sync from
  // props only when the feed *set* changes (a subscribe/unsubscribe elsewhere) —
  // NOT on a pure order change — so a lagging or out-of-order persist refetch can
  // never revert the order the user is looking at mid-reorder. On a membership
  // change we keep existing feeds in their current local order, drop removed
  // ones, and append newly-added ones (in prop order).
  const membershipKey = [...propIds].sort().join(',');
  useEffect(() => {
    setOrder((cur) => {
      const propSet = new Set(propIds);
      const curSet = new Set(cur);
      const sameMembership =
        cur.length === propIds.length && cur.every((id) => propSet.has(id));
      if (sameMembership) return cur;
      const kept = cur.filter((id) => propSet.has(id));
      const added = propIds.filter((id) => !curSet.has(id));
      return [...kept, ...added];
    });
    // membershipKey changes iff the set of feed ids changes; propIds is read
    // inside but only its membership matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey]);

  // Persist is debounced and only-latest-wins: rapid keyboard moves (or a drag
  // then a key press) collapse into a single `onReorder` with the final order,
  // so the writes can't land out of order and leave the server on a stale
  // intermediate order. `onReorder` is read through a ref so the unmount flush
  // uses the current callback.
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOrder = useRef<FeedId[] | null>(null);
  function schedulePersist(next: FeedId[]) {
    pendingOrder.current = next;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      const o = pendingOrder.current;
      pendingOrder.current = null;
      if (o) onReorderRef.current(o);
    }, 300);
  }
  useEffect(
    () => () => {
      // Flush a pending persist on unmount so a quick reorder-then-navigate isn't
      // lost.
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        if (pendingOrder.current) onReorderRef.current(pendingOrder.current);
      }
    },
    [],
  );

  const byId = new Map(subs.map((s) => [s.feed.id, s]));
  const rowRefs = useRef(new Map<FeedId, HTMLLIElement>());
  // After a keyboard move the row re-renders; restore focus to its handle so a
  // run of ArrowDown presses keeps working.
  const refocus = useRef<FeedId | null>(null);
  const handleRefs = useRef(new Map<FeedId, HTMLButtonElement>());
  useEffect(() => {
    if (refocus.current) {
      handleRefs.current.get(refocus.current)?.focus();
      refocus.current = null;
    }
  });

  function collectRects(): Map<FeedId, { top: number; height: number }> {
    const rects = new Map<FeedId, { top: number; height: number }>();
    for (const [id, el] of rowRefs.current) {
      const r = el.getBoundingClientRect();
      rects.set(id, { top: r.top, height: r.height });
    }
    return rects;
  }

  function onHandlePointerDown(e: ReactPointerEvent<HTMLButtonElement>, id: FeedId) {
    // Primary button / touch / pen only; ignore right-click etc.
    if (e.button !== 0) return;
    dragging.current = { id, startOrder: order };
    setDraggingId(id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onHandlePointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag) return;
    setOrder((cur) => orderForPointer(cur, drag.id, e.clientY, collectRects()));
  }

  function endDrag() {
    const drag = dragging.current;
    dragging.current = null;
    setDraggingId(null);
    if (!drag) return;
    // Persist only if the drag actually changed the order.
    setOrder((cur) => {
      if (cur.join(',') !== drag.startOrder.join(',')) schedulePersist(cur);
      return cur;
    });
  }

  function onHandleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, id: FeedId) {
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const from = order.indexOf(id);
    const to = from + dir;
    if (to < 0 || to >= order.length) return;
    const next = arrayMove(order, from, to);
    setOrder(next);
    schedulePersist(next);
    refocus.current = id;
  }

  return (
    <ul className="settings__subs">
      {order.map((id) => {
        const entry = byId.get(id);
        if (!entry) return null;
        const { feed, subscription } = entry;
        const title = subscription.titleOverride ?? feed.title;
        return (
          <li
            key={feed.id}
            className={
              'settings__sub' + (draggingId === feed.id ? ' is-dragging' : '')
            }
            ref={(el) => {
              if (el) rowRefs.current.set(feed.id, el);
              else rowRefs.current.delete(feed.id);
            }}
          >
            <button
              type="button"
              className="settings__sub-drag"
              aria-label={`Reorder ${title} (use the arrow keys)`}
              data-testid="sub-drag-handle"
              ref={(el) => {
                if (el) handleRefs.current.set(feed.id, el);
                else handleRefs.current.delete(feed.id);
              }}
              onPointerDown={(e) => onHandlePointerDown(e, feed.id)}
              onPointerMove={onHandlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={(e) => onHandleKeyDown(e, feed.id)}
            >
              <DragHandle width={20} height={20} />
            </button>
            <div className="settings__sub-main">
              <div className="settings__sub-title">{title}</div>
              <div className="settings__sub-url">{feed.url}</div>
            </div>
            <label className="settings__mute">
              <input
                type="checkbox"
                checked={subscription.muted}
                onChange={(e) => onMute(feed.id, e.target.checked)}
              />
              Mute
            </label>
            <button
              type="button"
              className="settings__unsub"
              onClick={() => onUnsubscribe(feed.id)}
            >
              Unsubscribe
            </button>
          </li>
        );
      })}
    </ul>
  );
}
