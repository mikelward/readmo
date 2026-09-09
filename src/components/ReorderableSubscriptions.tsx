import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Feed, FeedId, ListLayout, OpenMode, Subscription } from '../lib/types';
import { openModeOf } from '../lib/types';
import { isHackerNewsFeed } from '../lib/newshacker';
import { arrayMove, orderForPointer } from '../lib/arrayMove';
import { usePopoverDismiss } from '../hooks/usePopoverDismiss';
import { DragHandle } from './icons';
import { TooltipButton } from './TooltipButton';
import { onGestureCancel } from '../lib/gestureCancel';

export interface SubscriptionEntry {
  subscription: Subscription;
  feed: Feed;
}

/** The per-feed "Card style" menu options. `null` is "Default" — clear the
 * override and use the app-wide Article layout setting; the rest mirror the
 * app-wide choices (Settings → Appearance → Article layout) and the
 * {@link ListLayout} union. */
const CARD_STYLE_OPTIONS: { value: ListLayout | null; label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'title', label: 'Title only' },
  { value: 'thumbnail-small', label: 'Small thumbnail' },
  { value: 'thumbnail', label: 'Large thumbnail' },
  { value: 'excerpt', label: 'Excerpt' },
];

/** Which two-level submenu is drilled into within the open overflow menu, or
 * `null` for the top level. Both the open-mode ("Open on…") and "Card style"
 * controls share the same drill-in machinery. */
type Submenu = 'openMode' | 'cardStyle' | null;

interface Props {
  subs: SubscriptionEntry[];
  /** Persist a new feed order — every feed id, in the desired order. May return a
   * promise; when it does, persists are serialized so writes can't commit out of
   * order (see `schedulePersist`). */
  onReorder: (orderedFeedIds: FeedId[]) => void | Promise<void>;
  onMute: (feedId: FeedId, muted: boolean) => void;
  /** Set the feed's open mode — the mutually-exclusive choice (**Open here** /
   * **Open original** / **Open on newshacker**) shown as the "Open on…" drill
   * submenu. The parent persists it by clearing the other mode and setting the
   * chosen one. */
  onSetOpenMode: (feedId: FeedId, mode: OpenMode) => void;
  /** Toggle the feed's "mark done when opening" preference — when on, opening one
   * of its items on the original source or the newshacker discussion also marks
   * it Done. Independent of the open-mode choice above. */
  onSetMarkDoneOnOpen: (feedId: FeedId, markDoneOnOpen: boolean) => void;
  /** Set the feed's per-feed "card style" override — how much of its articles a
   * row shows. Pass a {@link ListLayout} to override the app-wide Article layout
   * setting for this feed, or `null` to clear it (fall back to the app setting). */
  onSetListLayout: (feedId: FeedId, listLayout: ListLayout | null) => void;
  onUnsubscribe: (feedId: FeedId) => void;
  /** Set a per-user display name for `feedId`. Pass `null` to clear the
   * override and fall back to the publisher's feed title. */
  onRename: (feedId: FeedId, title: string | null) => void | Promise<void>;
  /** When set, scroll this feed's row into view once it renders and briefly
   * highlight it. Used by the single feed page's settings pencil so the user
   * lands on the feed they came from rather than the top of the list. */
  scrollToFeedId?: FeedId | null;
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
  onSetOpenMode,
  onSetMarkDoneOnOpen,
  onSetListLayout,
  onUnsubscribe,
  onRename,
  scrollToFeedId,
}: Props) {
  const propIds = subs.map((s) => s.feed.id);
  const [order, setOrder] = useState<FeedId[]>(propIds);
  const dragging = useRef<{ id: FeedId; startOrder: FeedId[]; pointerId: number } | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<FeedId | null>(null);

  // Local `order` is authoritative while the user is interacting. We re-sync from
  // props only when the feed *set* changes (a subscribe/unsubscribe elsewhere) —
  // NOT on a pure order change — so a lagging or out-of-order persist refetch can
  // never revert the order the user is looking at mid-reorder. On a membership
  // change we keep existing feeds in their current local order, drop removed
  // ones, and append newly-added ones (in prop order).
  // Reconcile during render (not in an effect) when the feed *set* changes:
  // storing the previous membership key and adjusting state in render is React's
  // recommended way to derive from props without a cascading effect commit.
  const membershipKey = [...propIds].sort().join(',');
  const [prevMembershipKey, setPrevMembershipKey] = useState(membershipKey);
  if (prevMembershipKey !== membershipKey) {
    setPrevMembershipKey(membershipKey);
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
  }

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
  // Two of the open-menu's controls are two-level: the open-mode choice ("Open
  // on…", Hacker-News feeds only) and the per-feed "Card style" — each a single
  // top-level row that drills into a submenu holding its radio group. `submenu`
  // tracks which one, if any, is showing for the currently-open menu; it resets
  // whenever the open menu changes (including closing) so a stale drill level
  // can't leak onto the next row's menu.
  const [submenu, setSubmenu] = useState<Submenu>(null);
  // Reset the drill level during render when the open menu changes (including
  // closing), rather than in an effect, so a stale level can't leak onto the
  // next row's menu.
  const [submenuResetFor, setSubmenuResetFor] = useState(menuFor);
  if (submenuResetFor !== menuFor) {
    setSubmenuResetFor(menuFor);
    if (submenu !== null) setSubmenu(null);
  }
  // Drilling in/out unmounts the button the user just activated, which would
  // otherwise drop focus to <body> and lose their place. Move focus into the
  // submenu (its Back row) on drill-in and back onto the originating drill row
  // on return. Only on an actual drill transition while the menu stays open —
  // never when the menu first opens (that would yank focus off the ⋯ trigger).
  const openModeDrillRef = useRef<HTMLButtonElement | null>(null);
  const cardStyleDrillRef = useRef<HTMLButtonElement | null>(null);
  const submenuBackRef = useRef<HTMLButtonElement | null>(null);
  const prevSubmenu = useRef<Submenu>(null);
  const prevMenuFor = useRef<FeedId | null>(null);
  useLayoutEffect(() => {
    const wasSub = prevSubmenu.current;
    const wasMenu = prevMenuFor.current;
    prevSubmenu.current = submenu;
    prevMenuFor.current = menuFor;
    if (menuFor === null) {
      // The menu just closed. If it closed while focus was inside a submenu
      // (Escape, an outside press, or picking a radio — all set menuFor null),
      // that focused control unmounts and focus falls to <body>; return it to
      // the ⋯ trigger that owns the menu so keyboard/switch users keep their
      // place. Guard on <body> so we never steal focus the dismissal moved
      // somewhere meaningful.
      if (
        wasSub !== null &&
        wasMenu !== null &&
        typeof document !== 'undefined' &&
        document.activeElement === document.body
      ) {
        overflowRefs.current.get(wasMenu)?.focus({ preventScroll: true });
      }
      return;
    }
    // `preventScroll` because this focus effect runs *before* the placement
    // effect below: at this point the submenu is still rendered wherever the
    // (taller) top level was placed, which may be off-screen, and the default
    // scroll-into-view would jump the page before placement flips it into view.
    if (submenu !== null && wasSub === null) {
      submenuBackRef.current?.focus({ preventScroll: true });
    } else if (submenu === null && wasSub !== null) {
      const drill =
        wasSub === 'openMode' ? openModeDrillRef : cardStyleDrillRef;
      drill.current?.focus({ preventScroll: true });
    }
  }, [submenu, menuFor]);
  // The menu drops below its trigger by default, but a row near the bottom of
  // the viewport would push the menu off-screen. After it opens we measure and
  // flip it above the trigger when there isn't room below — see the layout
  // effect below.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<'below' | 'above'>(
    'below',
  );
  // Measures the committed DOM to decide above/below, so it must set state from
  // a layout effect — this is not derivable during render.
  useLayoutEffect(() => {
    if (menuFor === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMenuPlacement('below');
      return;
    }
    const menu = menuRef.current;
    // The menu lives inside `.settings__sub-actions` (its anchor); measure that
    // box rather than the trigger so the math doesn't depend on icon padding.
    const anchor = menu?.parentElement;
    if (!menu || !anchor || typeof window === 'undefined') return;
    const pad = 8;
    const gap = 4; // matches the menu's 4px top/bottom margin
    const anchorRect = anchor.getBoundingClientRect();
    // Measured while the menu is still placed below, so its height is its full
    // natural height regardless of which way we end up flipping it.
    const menuHeight = menu.getBoundingClientRect().height;
    // The sticky app header (`.app-header`, z-index above this menu) covers the
    // top of the viewport, so the usable ceiling for a flipped-up menu is its
    // bottom edge, not 0. Fall back to the viewport top if it isn't mounted.
    const header = document.querySelector('.app-header');
    const ceiling = header ? header.getBoundingClientRect().bottom : 0;
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top - ceiling;
    // Flip up only when it doesn't fit below AND it genuinely fits above (clear
    // of the header). A bottom overflow is recoverable by scrolling the page;
    // items hidden under the fixed header are not — so when it fits neither way
    // we keep it below rather than tucking the first actions under the header.
    const fitsBelow = spaceBelow >= menuHeight + gap + pad;
    const fitsAbove = spaceAbove >= menuHeight + gap + pad;
    setMenuPlacement(!fitsBelow && fitsAbove ? 'above' : 'below');
    // Also re-measure when drilling in/out of a submenu: the two levels differ
    // in height (a tall top level may be kept `below` because it fits neither
    // way, while the shorter submenu could fit `above`), so the placement
    // decided at open can go stale on the drill transition.
  }, [menuFor, submenu]);
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
  // The per-row overflow (⋯) triggers, so focus can return to the owning trigger
  // when its open-mode submenu is dismissed (see the drill focus effect below).
  const overflowRefs = useRef(new Map<FeedId, HTMLButtonElement>());
  useEffect(() => {
    if (refocus.current) {
      handleRefs.current.get(refocus.current)?.focus();
      refocus.current = null;
    }
  });

  // Deep-link from the single feed page (`/feeds?feed=<id>`): scroll that row
  // into view and flash a highlight. `order` is a dep so the effect re-runs
  // once the async subscriptions load and the target row mounts; `scrolledFor`
  // guards against re-scrolling on every later re-render (a drag, a rename).
  const [highlightId, setHighlightId] = useState<FeedId | null>(null);
  const scrolledFor = useRef<FeedId | null>(null);
  useEffect(() => {
    if (!scrollToFeedId) return;
    if (scrolledFor.current === scrollToFeedId) return;
    const el = rowRefs.current.get(scrollToFeedId);
    if (!el) return; // target row not rendered yet — re-runs when `order` updates
    scrolledFor.current = scrollToFeedId;
    el.scrollIntoView({ block: 'center' });
    setHighlightId(scrollToFeedId);
  }, [scrollToFeedId, order]);

  // Clear the highlight ~2s after it's set, in its own effect keyed on
  // `highlightId` rather than inline in the scroll effect above. If the timer
  // lived in that effect, any unrelated re-run before it fired (a mid-highlight
  // reorder bumps `order`; a StrictMode setup/cleanup cycle) would clear the
  // timeout and then early-return on the `scrolledFor` guard without scheduling
  // a replacement — stranding the row highlighted. Keyed on `highlightId`, the
  // timer is only torn down when the highlight actually changes or unmounts.
  useEffect(() => {
    if (highlightId === null) return;
    const t = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(t);
  }, [highlightId]);
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
    // One drag at a time: a second finger landing on another handle mid-drag
    // must not hijack the gesture — the first finger's moves would reorder
    // the second feed by the first's Y position, and its release would
    // persist that half-scrambled order.
    if (dragging.current) return;
    dragging.current = { id, startOrder: order, pointerId: e.pointerId };
    setDraggingId(id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  // A pinch (or any other multi-touch gesture) has claimed the fingers: abandon
  // the drag and put the order back where it started. The handle holds pointer
  // capture under `touch-action: none`, so nothing else can take this gesture
  // away — no `pointercancel` arrives — and without this the first finger keeps
  // reordering while the second resizes text, then its release PERSISTS an order
  // the user never chose. Restoring rather than dropping in place is the point:
  // a half-finished drag is not a decision.
  useEffect(
    () =>
      onGestureCancel(() => {
        const drag = dragging.current;
        if (!drag) return;
        dragging.current = null;
        setDraggingId(null);
        setOrder(drag.startOrder);
      }),
    [],
  );

  function onHandlePointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOrder((cur) => orderForPointer(cur, drag.id, e.clientY, collectRects()));
  }

  function endDrag(e: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    // Only the dragging pointer ends the drag — a stray second finger lifting
    // elsewhere must not commit (or cancel) the first finger's gesture.
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragging.current = null;
    setDraggingId(null);
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
        // The newshacker option in the open-mode choice (Open here / Open
        // original / Open on newshacker) is only applicable to Hacker News feeds.
        const showNewshackerOption = isHackerNewsFeed(feed);
        // Which drill submenu (if any) is showing for THIS row's open menu.
        const activeSubmenu: Submenu =
          menuFor !== feed.id
            ? null
            : submenu === 'openMode'
              ? 'openMode'
              : submenu === 'cardStyle'
                ? 'cardStyle'
                : null;
        return (
          <li
            key={feed.id}
            className={
              'settings__sub' +
              (draggingId === feed.id ? ' is-dragging' : '') +
              (highlightId === feed.id ? ' is-highlighted' : '')
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
                ref={(el) => {
                  if (el) overflowRefs.current.set(feed.id, el);
                  else overflowRefs.current.delete(feed.id);
                }}
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
                <div
                  role="menu"
                  ref={menuRef}
                  className={
                    'settings__sub-menu' +
                    (menuPlacement === 'above'
                      ? ' settings__sub-menu--above'
                      : '')
                  }
                  data-placement={menuPlacement}
                >
                  {activeSubmenu === 'openMode' ? (
                    // Second level of the open-mode control: a back row plus the
                    // mutually-exclusive radios — Open here / Open original, with
                    // Open on newshacker added only when applicable (HN feeds).
                    // Replaces the whole menu panel so it's never taller than the
                    // top level it swapped out.
                    <div role="group" aria-label="Open links in">
                      <button
                        type="button"
                        role="menuitem"
                        ref={submenuBackRef}
                        className="settings__sub-menuitem settings__sub-menuitem--back"
                        aria-label="Back"
                        onClick={() => setSubmenu(null)}
                      >
                        <span
                          className="settings__sub-chevron"
                          aria-hidden="true"
                        >
                          ‹
                        </span>
                        Open on
                      </button>
                      {(
                        [
                          ['reader', 'Open here'],
                          ['original', 'Open original'],
                          ...(showNewshackerOption
                            ? [['newshacker', 'Open on newshacker'] as const]
                            : []),
                        ] as const
                      ).map(([mode, label]) => {
                        const current = openModeOf(subscription);
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="menuitemradio"
                            aria-checked={current === mode}
                            className="settings__sub-menuitem settings__sub-menuitem--check"
                            onClick={() => {
                              setMenuFor(null);
                              if (current !== mode) onSetOpenMode(feed.id, mode);
                            }}
                          >
                            {label}
                            <span
                              className="settings__sub-check"
                              aria-hidden="true"
                            >
                              {current === mode ? '✓' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : activeSubmenu === 'cardStyle' ? (
                    // Second level of the Card style control: a back row plus the
                    // mutually-exclusive layout radios. Same drill machinery as
                    // the open-mode submenu above.
                    <div role="group" aria-label="Card style">
                      <button
                        type="button"
                        role="menuitem"
                        ref={submenuBackRef}
                        className="settings__sub-menuitem settings__sub-menuitem--back"
                        aria-label="Back"
                        onClick={() => setSubmenu(null)}
                      >
                        <span
                          className="settings__sub-chevron"
                          aria-hidden="true"
                        >
                          ‹
                        </span>
                        Card style
                      </button>
                      {CARD_STYLE_OPTIONS.map(({ value, label }) => {
                        const current = subscription.listLayout ?? null;
                        const selected = current === value;
                        return (
                          <button
                            key={value ?? 'default'}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            className="settings__sub-menuitem settings__sub-menuitem--check"
                            onClick={() => {
                              setMenuFor(null);
                              if (!selected) onSetListLayout(feed.id, value);
                            }}
                          >
                            {label}
                            <span
                              className="settings__sub-check"
                              aria-hidden="true"
                            >
                              {selected ? '✓' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <>
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
                      {/* Top level of the open-mode control: a single row that
                          drills into the Open here / Open original /
                          (newshacker) submenu above. */}
                      <button
                        type="button"
                        role="menuitem"
                        ref={openModeDrillRef}
                        aria-haspopup="menu"
                        aria-expanded={false}
                        className="settings__sub-menuitem settings__sub-menuitem--check"
                        onClick={() => setSubmenu('openMode')}
                      >
                        Open on…
                        <span className="settings__sub-chevron" aria-hidden="true">
                          ›
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={subscription.markDoneOnOpen}
                        className="settings__sub-menuitem settings__sub-menuitem--check"
                        onClick={() => {
                          setMenuFor(null);
                          onSetMarkDoneOnOpen(feed.id, !subscription.markDoneOnOpen);
                        }}
                      >
                        Mark done when opening
                        <span className="settings__sub-check" aria-hidden="true">
                          {subscription.markDoneOnOpen ? '✓' : ''}
                        </span>
                      </button>
                      {/* Top level of the Card style control: a single row that
                          drills into the layout submenu above. */}
                      <button
                        type="button"
                        role="menuitem"
                        ref={cardStyleDrillRef}
                        aria-haspopup="menu"
                        aria-expanded={false}
                        className="settings__sub-menuitem settings__sub-menuitem--check"
                        onClick={() => setSubmenu('cardStyle')}
                      >
                        Card style
                        <span className="settings__sub-chevron" aria-hidden="true">
                          ›
                        </span>
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
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
