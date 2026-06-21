import { useEffect, useRef } from 'react';

// Document-scoped list navigation: j/↓ next row, k/↑ previous row. The first
// press focuses the first row. Enter/Space/o/p/d are handled per-row by
// ItemRow's onKeyDown once a row is focused. Bails out in inputs, with a
// modifier held, when a dialog/menu is open, or if the event was pre-handled
// (same conditions as newshacker).
export function useListKeyboardNav() {
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;

      const isNext = e.key === 'j' || e.key === 'ArrowDown';
      const isPrev = e.key === 'k' || e.key === 'ArrowUp';
      if (!isNext && !isPrev) return;

      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(
        list.querySelectorAll<HTMLElement>('.item-row__body'),
      );
      if (rows.length === 0) return;

      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? rows.indexOf(active) : -1;

      let nextIdx: number;
      if (idx === -1) {
        nextIdx = 0;
      } else if (isNext) {
        nextIdx = Math.min(idx + 1, rows.length - 1);
      } else {
        nextIdx = Math.max(idx - 1, 0);
      }
      rows[nextIdx]?.focus();
      rows[nextIdx]?.scrollIntoView({ block: 'nearest' });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return listRef;
}
