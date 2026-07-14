import type { FeedItem, ItemId } from './types';

const EMPTY_SET: ReadonlySet<ItemId> = new Set();

/**
 * Re-place *in-session* pins at their natural feed position instead of the
 * data source's pinned-first lift — and hold a *just-unpinned* server pin in
 * its lifted slot so neither direction moves a row under the reader.
 *
 * The data source orders every pinned item to the top of its section (oldest-
 * pinned first), which is the right resting state on a fresh load / pull-to-
 * refresh. But a local pin/unpin the reader is *currently looking at* shouldn't
 * yank the row (SPEC.md *Feed views*: "pinning a body row keeps its position";
 * the list never moves a row the reader can see for a state change —
 * consolidation waits for the next refetch). `ItemList` tracks two id sets and
 * passes them here:
 *   - `stay`: rows pinned in-session while in the body — keep their body slot
 *     instead of lifting to the top block.
 *   - `stayLifted`: rows that occupy the server's lifted prefix (the caller
 *     passes the load-time-pinned set) — keep their lifted slot even once
 *     `isPinned` reports them unpinned, instead of dropping into the body. The
 *     cache stays pinned-first until the next refetch lands, so the input
 *     already carries these at the front; this just stops treating a since-
 *     unpinned one (locally or from another device) as a body row until then.
 *
 * Pins NOT in `stay` keep their lifted, oldest-pinned-first prefix (the input
 * already arrives in that order). In-session `stay` pins fall back into the body
 * and are re-sorted by publish date alongside the unpinned rows, landing exactly
 * where their date places them — i.e. where they already sat before the pin.
 *
 * Returns `list` unchanged (same reference) whenever no in-session `stay` pin is
 * actually present, so the common case preserves identity for downstream memos.
 * (A `stayLifted`-only hold needs no reorder — the input is already lifted-first
 * — so it doesn't force the work either.)
 *
 * When grouping by feed the reorder is applied per contiguous feed run, so
 * sections stay self-contained and in their existing order.
 */
export function placeStayInBodyPins(
  list: FeedItem[],
  opts: {
    groupByFeed: boolean;
    /** Body order: ascending (oldest-first) when the view's sort is 'oldest'. */
    sortAsc: boolean;
    /** Ids the reader pinned in-session while the row was in the loaded feed. */
    stay: ReadonlySet<ItemId>;
    /**
     * Ids the reader unpinned in-session that sit in the server's lifted prefix.
     * Held in their lifted slot (not re-sorted into the body) until refresh.
     */
    stayLifted?: ReadonlySet<ItemId>;
    isPinned: (id: ItemId) => boolean;
  },
): FeedItem[] {
  const { groupByFeed, sortAsc, stay, isPinned } = opts;
  const stayLifted = opts.stayLifted ?? EMPTY_SET;
  if (stay.size === 0) return list;

  // Only do any work if a held (`stay`) id is actually in the list — otherwise
  // the data source's order is already what we want and we keep the same ref.
  // We don't require the held id to still be pinned: an in-session pin the
  // reader has since unpinned still sorts back into the body at its date slot.
  let active = false;
  for (const fi of list) {
    if (stay.has(fi.item.id)) {
      active = true;
      break;
    }
  }
  if (!active) return list;

  const byDate = (a: FeedItem, b: FeedItem) => {
    const d = sortAsc
      ? a.item.publishedAt - b.item.publishedAt
      : b.item.publishedAt - a.item.publishedAt;
    if (d !== 0) return d;
    // Tie-break by id descending, matching the `feed_items` body order
    // (`ORDER BY … (i).id desc`, supabase migration 0021) and MockDataSource.
    // Without it, equal-`publishedAt` rows (common for dateless feeds that fall
    // back to a shared insertion timestamp) compare equal, so a stable sort
    // would leave an in-session pin at the front position it held in the pinned
    // prefix instead of returning it to its natural slot.
    return a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0;
  };

  const placeSection = (section: FeedItem[]): FeedItem[] => {
    const lifted: FeedItem[] = [];
    const body: FeedItem[] = [];
    for (const fi of section) {
      const id = fi.item.id;
      // A row keeps its top-block slot when it's a pin the reader hasn't held in
      // body — OR a server pin the reader unpinned in-session (`stayLifted`),
      // which holds its lifted place until refresh rather than dropping to body.
      if ((isPinned(id) || stayLifted.has(id)) && !stay.has(id)) lifted.push(fi);
      else body.push(fi);
    }
    // `lifted` keeps the input's oldest-pinned-first order; the body (now
    // including the in-session pins) is re-sorted by date so each lands at its
    // natural position.
    body.sort(byDate);
    return lifted.concat(body);
  };

  if (!groupByFeed) return placeSection(list);

  const out: FeedItem[] = [];
  let i = 0;
  while (i < list.length) {
    const feedId = list[i].item.feedId;
    const run: FeedItem[] = [];
    while (i < list.length && list[i].item.feedId === feedId) {
      run.push(list[i]);
      i += 1;
    }
    for (const fi of placeSection(run)) out.push(fi);
  }
  return out;
}
