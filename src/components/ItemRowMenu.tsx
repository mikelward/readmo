import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ItemRowMenu.css';

// Ported from newshacker's StoryRowMenu (generic — no HN coupling). Anchored
// popover on pointer devices, bottom-sheet fallback on touch.

export interface ItemRowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
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

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    const firstBtn = sheetRef.current?.querySelector<HTMLButtonElement>(
      'button[data-menu-item]',
    );
    firstBtn?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open, onClose]);

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
  }, [popover, anchorEl, items]);

  useEffect(() => {
    if (!popover) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sheetRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
    };
  }, [popover, anchorEl, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const handleSelect = (item: ItemRowMenuItem) => {
    item.onSelect();
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
          {items.map((item) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                data-menu-item
                data-testid={`item-row-menu-${item.key}`}
                className="item-menu__item"
                onClick={() => handleSelect(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
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
