import type { FeedItem, ItemId } from './types';

/**
 * Re-place *in-session* pins at their natural feed position instead of the
 * data source's pinned-first lift.
 *
 * The data source orders every pinned item to the top of its section (oldest-
 * pinned first), which is the right resting state on a fresh load / pull-to-
 * refresh. But pinning a row the reader is *currently looking at* shouldn't
 * yank it to the top under their eye (SPEC.md *Feed views*: "pinning a body row
 * keeps its position"). `ItemList` tracks those just-pinned ids (`stay`) and
 * passes them here so the row stays where it was; everything else keeps the
 * data source's order.
 *
 * Pins NOT in `stay` keep their lifted, oldest-pinned-first prefix (the input
 * already arrives in that order). In-session pins fall back into the body and
 * are re-sorted by publish date alongside the unpinned rows, landing exactly
 * where their date places them — i.e. where they already sat before the pin.
 *
 * Returns `list` unchanged (same reference) whenever no in-session pin is
 * actually present, so the common case preserves identity for downstream memos.
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
    isPinned: (id: ItemId) => boolean;
  },
): FeedItem[] {
  const { groupByFeed, sortAsc, stay, isPinned } = opts;
  if (stay.size === 0) return list;

  // Only do any work if a held id is actually in the list — otherwise the data
  // source's order is already what we want and we keep the same ref. We don't
  // require the held id to still be pinned: when the reader unpins a held row,
  // the cache stays pinned-first until the unpin's refetch lands, so the row
  // must keep being sorted back into the body (as an ordinary unpinned row) for
  // that round-trip rather than snapping to the stale top.
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
      // A pin keeps its top-block slot only when it's NOT an in-session pin.
      if (isPinned(fi.item.id) && !stay.has(fi.item.id)) lifted.push(fi);
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
