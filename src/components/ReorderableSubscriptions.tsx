import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Feed, FeedId, Subscription } from '../lib/types';
import { arrayMove, orderForPointer } from '../lib/arrayMove';
import { usePopoverDismiss } from '../hooks/usePopoverDismiss';
import { DragHandle } from './icons';
import { TooltipButton } from './TooltipButton';

export interface SubscriptionEntry {
  subscription: Subscription;
  feed: Feed;
}

interface Props {
  subs: SubscriptionEntry[];
  /** Persist a new feed order — every feed id, in the desired order. May return a
   * promise; when it does, persists are serialized so writes can't commit out of
   * order (see `schedulePersist`). */
  onReorder: (orderedFeedIds: FeedId[]) => void | Promise<void>;
  onMute: (feedId: FeedId, muted: boolean) => void;
  onUnsubscribe: (feedId: FeedId) => void;
  /** Set a per-user display name for `feedId`. Pass `null` to clear the
   * override and fall back to the publisher's feed title. */
  onRename: (feedId: FeedId, title: string | null) => void | Promise<void>;
}

/** The Settings subscriptions list with drag-to-reorder handles. Each row
 * stays within the **3-tap-zone cap** (CLAUDE.md guardrail #2): drag handle,
 * non-interactive row body (title + URL), and an overflow (...) button that
 * opens a per-row menu with Rename / Mute / Unsubscribe. The drag handle is
 * both pointer-draggable (mouse + touch) and keyboard-operable (focus it, then
 * ArrowUp/ArrowDown) so reordering isn't mouse-only. Renaming uses an inline
 * input that replaces the title slot: Enter commits, Esc cancels, blur commits,
 * empty clears the override and falls back to the publisher's title. Order is
 * held locally for a snappy drag and persisted via `onReorder` on drop / each
 * keyboard move; the parent's refetch then re-syncs `subs`. */
export function ReorderableSubscriptions({
  subs,
  onReorder,
  onMute,
  onUnsubscribe,
  onRename,
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

  // Persist is debounced AND serialized, so only the newest order can win.
  //
  //  - Debounce: rapid keyboard moves (or a drag then a key press) collapse into
  //    one write with the final order.
  //  - Serialize: only one persist may be in flight at a time. If another move
  //    lands while a write is still running (the debounce already fired, e.g. on
  //    a slow network), the new order is queued and sent only after the current
  //    write resolves — the two RPCs can't race and commit out of order, so the
  //    server always ends on the last order, not a stale intermediate one. A
  //    queued order is replaced by any newer one (latest-wins), so a burst still
  //    sends at most one follow-up write.
  //
  // `onReorder` is read through a ref so the unmount flush uses the current
  // callback.
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOrder = useRef<FeedId[] | null>(null);
  const inFlight = useRef(false);
  const queuedOrder = useRef<FeedId[] | null>(null);

  function runPersist(next: FeedId[]) {
    if (inFlight.current) {
      queuedOrder.current = next; // newer order supersedes any already queued
      return;
    }
    inFlight.current = true;
    Promise.resolve(onReorderRef.current(next))
      .catch(() => {}) // a failed write surfaces via the parent; don't wedge the queue
      .finally(() => {
        inFlight.current = false;
        const q = queuedOrder.current;
        queuedOrder.current = null;
        if (q) runPersist(q);
      });
  }

  function schedulePersist(next: FeedId[]) {
    pendingOrder.current = next;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      const o = pendingOrder.current;
      pendingOrder.current = null;
      if (o) runPersist(o);
    }, 300);
  }
  useEffect(
    () => () => {
      // Flush a pending persist on unmount so a quick reorder-then-navigate isn't
      // lost.
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        if (pendingOrder.current) runPersist(pendingOrder.current);
      }
    },
    // Unmount-only flush; runPersist only touches refs, so a stable empty dep
    // array is correct (a fresh closure each render would add no value).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const byId = new Map(subs.map((s) => [s.feed.id, s]));
  // Per-row overflow menu (Rename / Mute / Unsubscribe). Only one open at a
  // time; clicks outside or Escape close it.
  const [menuFor, setMenuFor] = useState<FeedId | null>(null);
  // Inline rename. `editing` tracks which row is in edit mode and the current
  // draft value; the input is autofocused on entry. Enter commits, Esc cancels,
  // blur commits. An empty/whitespace-only draft clears the override (null).
  const [editing, setEditing] = useState<{ id: FeedId; value: string } | null>(
    null,
  );
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const committing = useRef(false);
  // Per-feed rename serialization. The input closes synchronously on commit,
  // so the user can immediately reopen the menu and rename the same row again
  // before the previous `onRename` write has resolved. Mirroring the reorder
  // pattern: at most one write per feed is in flight; subsequent commits land
  // in `queued` and replace any older queued value (latest-wins). The next
  // write fires only after the previous finally-block runs, so out-of-order
  // commits to the same row are impossible — the saved title is always the
  // last one the user actually typed. `undefined` in `queued` means "no
  // pending value"; `null` is a real value meaning "clear the override".
  const renameState = useRef(
    new Map<
      FeedId,
      { inFlight: boolean; queued: string | null | undefined }
    >(),
  );
  async function flushRename(id: FeedId) {
    const state = renameState.current.get(id);
    if (!state || state.inFlight || state.queued === undefined) return;
    const value = state.queued;
    state.queued = undefined;
    state.inFlight = true;
    try {
      await Promise.resolve(onRename(id, value));
    } finally {
      state.inFlight = false;
      if (state.queued !== undefined) void flushRename(id);
      else renameState.current.delete(id);
    }
  }
  function queueRename(id: FeedId, value: string | null) {
    let state = renameState.current.get(id);
    if (!state) {
      state = { inFlight: false, queued: undefined };
      renameState.current.set(id, state);
    }
    state.queued = value; // latest wins
    void flushRename(id);
  }
  function startEdit(id: FeedId, current: string) {
    // Clear any stale suppression from the previous edit. The flag is set by
    // commitEdit/cancelEdit to swallow the synthetic trailing blur React fires
    // after the input unmounts; if that blur never lands (browsers don't always
    // deliver it for a removed focused element) it would otherwise persist and
    // swallow the *next* rename's real blur commit.
    committing.current = false;
    setMenuFor(null);
    setEditing({ id, value: current });
  }
  function cancelEdit() {
    committing.current = true; // suppress the trailing onBlur from re-committing
    setEditing(null);
  }
  function commitEdit(id: FeedId, raw: string, originalTitle: string) {
    const trimmed = raw.trim();
    // Empty input clears the override; otherwise only persist if it changed.
    const next = trimmed === '' ? null : trimmed;
    // The "unchanged" no-op is only safe when nothing is queued or in flight
    // for this feed. While a rename is pending the row keeps rendering the
    // pre-edit title until the parent refetches, so `originalTitle` is stale —
    // a user retyping the displayed name is undoing their pending edit, not
    // making a no-op. Always enqueue in that case so the last commit wins.
    const state = renameState.current.get(id);
    const hasPending =
      state !== undefined && (state.inFlight || state.queued !== undefined);
    if (!hasPending && next !== null && next === originalTitle) {
      setEditing(null);
      return;
    }
    committing.current = true;
    setEditing(null);
    queueRename(id, next);
  }
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
  // Shared dropdown dismissal: Escape, outside-press, and the first-press-only
  // swallow (so dismissing the menu doesn't also activate whatever was tapped —
  // a neighboring row, another control). The "inside" region is the open row,
  // so the trigger and Rename input (both inside it) don't dismiss through this
  // path. See usePopoverDismiss.
  usePopoverDismiss({
    open: menuFor !== null,
    onDismiss: () => setMenuFor(null),
    isInside: (target) => {
      const row = menuFor !== null ? rowRefs.current.get(menuFor) : null;
      return !!row?.contains(target);
    },
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
              {editing?.id === feed.id ? (
                <input
                  ref={(el) => {
                    editInputRef.current = el;
                    if (el && document.activeElement !== el) {
                      el.focus();
                      el.select();
                    }
                  }}
                  type="text"
                  className="settings__sub-rename"
                  aria-label={`Rename ${title}`}
                  placeholder="Leave blank to use the publisher's title"
                  value={editing.value}
                  onChange={(e) =>
                    setEditing({ id: feed.id, value: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitEdit(feed.id, editing.value, title);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => {
                    // Cancel/commit already cleared `editing`; suppress to avoid
                    // a second commit on the trailing focus loss.
                    if (committing.current) {
                      committing.current = false;
                      return;
                    }
                    void commitEdit(feed.id, editing.value, title);
                  }}
                />
              ) : (
                <div className="settings__sub-title">{title}</div>
              )}
              <div className="settings__sub-url">{feed.url}</div>
            </div>
            <div className="settings__sub-actions">
              <TooltipButton
                type="button"
                className="settings__sub-overflow"
                tooltip="Actions"
                aria-label={`Actions for ${title}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === feed.id}
                onClick={() =>
                  setMenuFor((cur) => (cur === feed.id ? null : feed.id))
                }
              >
                <span aria-hidden="true">⋯</span>
              </TooltipButton>
              {menuFor === feed.id ? (
                <div role="menu" className="settings__sub-menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="settings__sub-menuitem"
                    onClick={() => startEdit(feed.id, title)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={subscription.muted}
                    className="settings__sub-menuitem"
                    onClick={() => {
                      setMenuFor(null);
                      onMute(feed.id, !subscription.muted);
                    }}
                  >
                    {subscription.muted ? 'Unmute' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="settings__sub-menuitem settings__sub-menuitem--danger"
                    onClick={() => {
                      setMenuFor(null);
                      onUnsubscribe(feed.id);
                    }}
                  >
                    Unsubscribe
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
