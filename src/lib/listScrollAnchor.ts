import { measureStickyInset, measureTopChromeHeight } from './stickyInset';

// Remembering where a list view was scrolled to, as a ROW rather than a pixel
// offset, so returning to it from the reader puts the reader back in front of
// the same article.
//
// The browser's own scroll restoration hands back a pixel offset, which is only
// right when the list is identical to the one you left. It often isn't: rows can
// leave the list while it's unmounted (the article you just opened on a
// mark-done-on-open feed; every row you scrolled past when auto-hide's
// strike-in-place hold ends with the unmount). Each row that disappears from
// ABOVE the reader slides the rest up under the restored offset, landing them
// that many articles further down the feed — the reported "the list moved under
// me" on Back.
//
// So the anchor records the row at the top of the visible band and where it sat,
// and the restore scrolls that row back to that spot however much of the list
// above it went away.

/** How many consecutive rows an anchor records. The topmost visible row is the
 * one we aim to restore, but it can be gone by the time we return (it's the
 * likeliest one to have been opened and dismissed), so a few of its followers
 * come along as fallbacks — each with its own offset, since they sat a row or
 * more further down. */
const ANCHOR_ROW_COUNT = 5;

/** Cap on remembered history entries. One per list view the reader has scrolled
 * this session; they're tiny, but the map would otherwise grow for the life of
 * the document. Oldest-first eviction — the entries most likely to still be
 * reachable by Back are the ones written most recently. */
const MAX_ENTRIES = 20;

/** One recorded row: its id and where its top edge sat, in px below the bottom
 * of the sticky top chrome (so a negative value means it was tucked partly
 * behind the chrome). */
export interface AnchorRow {
  id: string;
  top: number;
}

export interface ListScrollAnchor {
  /** Consecutive rows from the top of the visible band, topmost first. */
  rows: AnchorRow[];
}

// Keyed by history entry key (react-router's `location.key`), so each entry in
// the back stack remembers its own place. Memory-only and per-document: a
// reload or a PWA relaunch starts empty, and the restore simply doesn't run
// (the browser's own restoration is left to it, exactly as before). That also
// keeps item ids — a signed-in user's subscription content — out of any storage
// that outlives the tab.
const anchors = new Map<string, ListScrollAnchor>();

export function saveListScrollAnchor(key: string, anchor: ListScrollAnchor): void {
  // Delete first so a re-save moves the key to the end of the insertion order,
  // keeping eviction oldest-first rather than first-seen-first.
  anchors.delete(key);
  anchors.set(key, anchor);
  while (anchors.size > MAX_ENTRIES) {
    const oldest = anchors.keys().next();
    if (oldest.done) break;
    anchors.delete(oldest.value);
  }
}

export function getListScrollAnchor(key: string): ListScrollAnchor | null {
  return anchors.get(key) ?? null;
}

/** Test-only: drop every remembered anchor. */
export function clearListScrollAnchors(): void {
  anchors.clear();
}

/** Read the current anchor out of the DOM, or null when no list rows are
 * rendered (any non-list route — the reader, settings — so nothing is
 * recorded there). The scan stops at the first row still showing below the
 * chrome, so the cost is the number of rows already scrolled past. */
export function captureListScrollAnchor(): ListScrollAnchor | null {
  if (typeof document === 'undefined') return null;
  const chrome = measureTopChromeHeight();
  // Which rows are *visible* and which offset they're recorded against are two
  // different questions. Visibility has to account for the grouped view's
  // sticky section header, which paints over the rows sliding up behind it
  // (`measureStickyInset` is the same band auto-hide treats as scrolled-off, so
  // an anchor chosen below it isn't one about to be dismissed). The offset is
  // measured from the top chrome alone, whose layout height doesn't depend on
  // where the list happens to be scrolled — so capture and restore agree even
  // if the sticky state differs between them.
  const occluded = Math.max(chrome, measureStickyInset());
  const rows = document.querySelectorAll('li[data-item-id]');
  for (let i = 0; i < rows.length; i += 1) {
    const el = rows[i];
    if (!(el instanceof HTMLElement)) continue;
    const rect = el.getBoundingClientRect();
    // Painted over by the chrome (or, grouped, by the section header) — the
    // reader can't see it, so it's the wrong row to hold on to. Keep looking.
    if (rect.bottom <= occluded) continue;
    const recorded: AnchorRow[] = [];
    for (let j = i; j < rows.length && recorded.length < ANCHOR_ROW_COUNT; j += 1) {
      const row = rows[j];
      if (!(row instanceof HTMLElement)) continue;
      const id = row.dataset.itemId;
      if (!id) continue;
      recorded.push({ id, top: Math.round(row.getBoundingClientRect().top - chrome) });
    }
    return recorded.length > 0 ? { rows: recorded } : null;
  }
  return null;
}

/** How far the window must scroll (positive = down) to put the anchor back
 * where it was. Null when none of the recorded rows is rendered yet — the list
 * may still be painting, so the caller retries rather than treating it as
 * "nothing to do". */
export function measureAnchorDelta(anchor: ListScrollAnchor): number | null {
  if (typeof document === 'undefined') return null;
  const chrome = measureTopChromeHeight();
  for (const row of anchor.rows) {
    // Same lookup shape as ItemList's rowIntersectsViewport; item ids are
    // server-issued uuids, so they need no escaping in the selector.
    const el = document.querySelector(`li[data-item-id="${row.id}"]`);
    if (!(el instanceof HTMLElement)) continue;
    // Each fallback carries its OWN recorded offset, so restoring against the
    // second or third row lands the view in the same place as the first would
    // have — not a row-height off.
    return Math.round(el.getBoundingClientRect().top - chrome - row.top);
  }
  return null;
}
