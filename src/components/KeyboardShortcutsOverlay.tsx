import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import './KeyboardShortcutsOverlay.css';

interface Shortcut {
  keys: string[];
  description: string;
}

// Shortcuts active on the list pages (`/`, `/folder/:name`, `/feed/:id`,
// and the library views — anywhere `useListKeyboardNav` is mounted). The
// active row is whichever row body has DOM focus. See SPEC.md
// *Accessibility → Keyboard shortcuts*.
const LIST_SHORTCUTS: Shortcut[] = [
  { keys: ['j', '↓'], description: 'Next item' },
  { keys: ['k', '↑'], description: 'Previous item' },
  { keys: ['Enter'], description: 'Open the reader' },
  { keys: ['Space'], description: 'Open the row actions menu' },
  { keys: ['o'], description: 'Open the original article in a new tab' },
  { keys: ['p'], description: 'Pin or unpin the item' },
  { keys: ['d'], description: 'Hide (dismiss) the item' },
  { keys: ['?'], description: 'Show this help' },
  { keys: ['Esc'], description: 'Close menus or this help' },
];

// Shortcuts active on the reader page (`/item/:id`). j/k scroll between
// section headings (or page top/bottom); the letter keys act on the
// article. RSS items have no comments, so there is no comment navigation.
const READER_SHORTCUTS: Shortcut[] = [
  { keys: ['j', '↓'], description: 'Next section' },
  { keys: ['k', '↑'], description: 'Previous section' },
  { keys: ['o'], description: 'Open the original article in a new tab' },
  { keys: ['p'], description: 'Pin or unpin the item' },
  { keys: ['f'], description: 'Favorite or unfavorite the item' },
  { keys: ['d'], description: 'Mark the item done (and go back)' },
  { keys: ['?'], description: 'Show this help' },
  { keys: ['Esc'], description: 'Close menus or this help' },
];

function shouldIgnoreKeyEvent(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

// Mounted once at the App root. Listens globally for `?` to open and
// Escape to close. Bails out when another modal is already open (row
// menu / dialogs / drawer / account menu — all use role="dialog" or
// role="menu") so `?` doesn't punch through an active dialog.
export function KeyboardShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  const previouslyFocused = useRef<Element | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  // `/item/:id` is the only route that renders the reader, so a
  // path-prefix check is enough to pick the right shortcut list without
  // each page needing to opt in.
  const onReader = location.pathname.startsWith('/item/');
  const shortcuts = onReader ? READER_SHORTCUTS : LIST_SHORTCUTS;
  const title = onReader
    ? 'Keyboard shortcuts · Reader'
    : 'Keyboard shortcuts';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyEvent(e)) return;
      if (open) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
        return;
      }
      if (e.key !== '?') return;
      // Don't punch through an open dialog/menu.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      e.preventDefault();
      previouslyFocused.current = document.activeElement;
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    return () => {
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    <div
      className="kb-help"
      data-testid="keyboard-shortcuts-overlay"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div className="kb-help__backdrop" />
      <div
        ref={dialogRef}
        className="kb-help__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={stop}
      >
        <h2 className="kb-help__title">{title}</h2>
        <dl className="kb-help__list" data-testid="keyboard-shortcuts-list">
          {shortcuts.map((s) => (
            <div className="kb-help__row" key={s.description}>
              <dt className="kb-help__keys">
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 ? (
                      <span className="kb-help__sep"> or </span>
                    ) : null}
                    <kbd className="kb-help__kbd">{k}</kbd>
                  </span>
                ))}
              </dt>
              <dd className="kb-help__desc">{s.description}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="kb-help__close"
          data-testid="keyboard-shortcuts-close"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
