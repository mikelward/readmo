import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverDismiss } from '../hooks/usePopoverDismiss';
import './ItemRowMenu.css';

// Ported from newshacker's StoryRowMenu (generic — no HN coupling). Anchored
// popover on pointer devices, bottom-sheet fallback on touch.

export interface ItemRowMenuItem {
  key: string;
  label: string;
  /** Leaf: act and close. Exactly one of onSelect/submenu/prompt is set. */
  onSelect?: () => void;
  /** Step INTO a deeper level of this same menu rather than opening a nested
   * one. A second popover would need its own anchoring, and a bottom sheet
   * can't nest at all — so a level swaps the list in place and `Back` pops it.
   * Deep levels are built lazily (a thunk) so a menu that's never opened
   * doesn't pay to compute them. */
  submenu?: () => ItemRowMenuItem[];
  /** Free-text entry rendered inline in the sheet, for the tail of a list of
   * suggestions ("Other…"). Submitting acts and closes; an empty value is
   * ignored. */
  prompt?: { placeholder: string; submitLabel: string; onSubmit: (value: string) => void };
}

interface Props {
  open: boolean;
  title: string;
  items: ItemRowMenuItem[];
  anchorEl?: HTMLElement | null;
  onClose: () => void;
}

interface PopoverPosition {
  top: number;
  left: number;
  placement: 'below' | 'above';
}

export function ItemRowMenu({ open, title, items, anchorEl, onClose }: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const popover = open && !!anchorEl;
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  // The path into nested levels: each entry is the item stepped through, so the
  // list rendered is the deepest one's submenu and `Back` pops one level.
  const [path, setPath] = useState<ItemRowMenuItem[]>([]);
  // Which prompt item (if any) has its inline field open at this level.
  const [prompting, setPrompting] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // A closed menu always reopens at the top level: the path is navigation
  // state, not a preference, and reopening two levels deep on an unrelated row
  // would be baffling. Adjusted DURING RENDER rather than in an effect — React's
  // documented pattern for state that derives from a prop change. An effect
  // would paint the stale level for a frame first, and re-entering the menu is
  // exactly when that frame is visible.
  const [openWas, setOpenWas] = useState(open);
  if (openWas !== open) {
    setOpenWas(open);
    setPath([]);
    setPrompting(null);
    setDraft('');
  }

  // Built once per level rather than per render — the thunk does real work
  // (scanning the title for candidates).
  const level = useMemo(
    () => (path.length > 0 ? (path[path.length - 1].submenu?.() ?? []) : items),
    [path, items],
  );

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    return () => {
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open]);

  // Focus follows the LEVEL, not just open/close. Stepping into a submenu (or
  // popping back out) unmounts the button that had focus, which drops focus to
  // the body — and from there the next Tab leaves the menu entirely for whatever
  // follows it in the document. Re-anchoring on the new level's first item keeps
  // the keyboard inside the menu. Keyed on DEPTH rather than the level array: it
  // is rebuilt whenever the candidate thunk reruns, and refocusing on that would
  // yank focus back to the top while the reader is arrowing through the list.
  useEffect(() => {
    if (!open) return;
    sheetRef.current
      ?.querySelector<HTMLButtonElement>('button[data-menu-item]')
      ?.focus();
  }, [open, path.length]);

  // Dismissal (Escape, outside-press, first-press-only swallow) is the shared
  // contract — see usePopoverDismiss. The anchor is treated as "inside" so
  // re-pressing the trigger toggles via its own onClick rather than dismissing
  // here. Outside-press is wired only in popover mode; the sheet variant
  // dismisses through its darkened backdrop + Cancel button.
  usePopoverDismiss({
    open,
    onDismiss: onClose,
    isInside: (target) =>
      !!sheetRef.current?.contains(target) || !!anchorEl?.contains(target),
    dismissOnOutsidePress: popover,
  });

  useLayoutEffect(() => {
    if (!popover || !anchorEl || !sheetRef.current) {
      setPos(null);
      return;
    }
    let rafId = 0;
    const place = () => {
      if (!sheetRef.current || !anchorEl) return;
      const a = anchorEl.getBoundingClientRect();
      const m = sheetRef.current.getBoundingClientRect();
      const margin = 4;
      const pad = 8;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
      const spaceBelow = vh - a.bottom;
      const spaceAbove = a.top;
      const placement: 'below' | 'above' =
        spaceBelow >= m.height + margin || spaceBelow >= spaceAbove
          ? 'below'
          : 'above';
      const top =
        placement === 'below'
          ? Math.min(a.bottom + margin, Math.max(pad, vh - m.height - pad))
          : Math.max(pad, a.top - m.height - margin);
      let left = a.right - m.width;
      left = Math.max(pad, Math.min(left, Math.max(pad, vw - m.width - pad)));
      setPos((prev) => {
        if (
          prev &&
          prev.top === top &&
          prev.left === left &&
          prev.placement === placement
        ) {
          return prev;
        }
        return { top, left, placement };
      });
    };
    place();
    const scheduleRaf = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        place();
      });
    };
    window.addEventListener('resize', scheduleRaf);
    window.addEventListener('scroll', scheduleRaf, true);
    return () => {
      window.removeEventListener('resize', scheduleRaf);
      window.removeEventListener('scroll', scheduleRaf, true);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
    // `level`/`prompting` re-place the popover: stepping into a submenu or
    // opening the inline field changes the sheet's height, and a stale position
    // would leave it hanging off the anchor (or off-screen).
  }, [popover, anchorEl, level, prompting]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const handleSelect = (item: ItemRowMenuItem) => {
    if (item.submenu) {
      setPath((prev) => [...prev, item]);
      setPrompting(null);
      setDraft('');
      return;
    }
    if (item.prompt) {
      setPrompting(item.key);
      setDraft('');
      return;
    }
    item.onSelect?.();
    onClose();
  };

  const goBack = () => {
    setPath((prev) => prev.slice(0, -1));
    setPrompting(null);
    setDraft('');
  };

  const submitPrompt = (item: ItemRowMenuItem) => {
    const value = draft.trim();
    if (!value) return;
    item.prompt?.onSubmit(value);
    onClose();
  };

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const rootClass =
    'item-menu' + (popover ? ' item-menu--popover' : ' item-menu--sheet');
  const sheetClass =
    'item-menu__sheet' + (popover ? ' item-menu__sheet--popover' : '');
  const sheetStyle =
    popover && pos
      ? { top: pos.top, left: pos.left }
      : popover
        ? { visibility: 'hidden' as const }
        : undefined;

  return createPortal(
    <div
      className={rootClass}
      data-testid="item-row-menu"
      data-variant={popover ? 'popover' : 'sheet'}
      role="presentation"
      onClick={stop}
      onPointerDown={stop}
      onPointerUp={stop}
    >
      {popover ? null : (
        <div
          className="item-menu__backdrop"
          data-testid="item-row-menu-backdrop"
          onClick={onClose}
        />
      )}
      <div
        ref={sheetRef}
        className={sheetClass}
        role={popover ? 'menu' : 'dialog'}
        aria-modal={popover ? undefined : 'true'}
        aria-label={title}
        style={sheetStyle}
        data-placement={pos?.placement}
      >
        <div className="item-menu__title" title={title}>
          {title}
        </div>
        <ul className="item-menu__list" role={popover ? 'presentation' : 'menu'}>
          {level.map((item) =>
            prompting === item.key && item.prompt ? (
              <li key={item.key} role="none">
                <form
                  className="item-menu__prompt"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitPrompt(item);
                  }}
                >
                  {/* Focused on open: the reader chose this field by selecting
                      the item, so it saves a second tap on the surface where
                      taps are dearest. */}
                  <input
                    autoFocus
                    type="text"
                    className="item-menu__prompt-input"
                    data-testid={`item-row-menu-${item.key}-input`}
                    aria-label={item.label}
                    placeholder={item.prompt.placeholder}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="item-menu__prompt-submit"
                    data-testid={`item-row-menu-${item.key}-submit`}
                    disabled={draft.trim().length === 0}
                  >
                    {item.prompt.submitLabel}
                  </button>
                </form>
              </li>
            ) : (
              <li key={item.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  data-menu-item
                  data-testid={`item-row-menu-${item.key}`}
                  className="item-menu__item"
                  aria-haspopup={item.submenu ? 'menu' : undefined}
                  onClick={() => handleSelect(item)}
                >
                  {item.label}
                </button>
              </li>
            ),
          )}
          {path.length > 0 ? (
            <li role="none">
              <button
                type="button"
                role="menuitem"
                data-menu-item
                data-testid="item-row-menu-back"
                className="item-menu__item item-menu__item--back"
                onClick={goBack}
              >
                Back
              </button>
            </li>
          ) : null}
        </ul>
        {popover ? null : (
          <button
            type="button"
            className="item-menu__cancel"
            data-testid="item-row-menu-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
