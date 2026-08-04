// Keeping a list still under the reader's thumb.
//
// Some lists are *derived* from state the reader is actively changing: `/offline`
// sorts saved (pinned/favorited) rows above the rest, so the very act of pinning
// a row re-sorts the list out from under the finger that pinned it — the row
// jumps to the top, and whatever the reader was about to tap next slides into
// the space it left. The same happens without any input at all when a background
// warm or refresh drops new rows into the cache the list is derived from.
//
// So the sort order is treated as an *entry* decision, not a continuous one: it
// picks the order when the view opens, and from then on the order it already
// painted wins. Re-derivation still adds and removes rows — it just can't
// reshuffle the ones already on screen. A fresh visit re-sorts.

/**
 * Reconcile a freshly-derived (`natural`) id order against the order already on
 * screen (`frozen`), preserving the on-screen order.
 *
 * - Ids in both keep their **frozen** relative order — this is the whole point:
 *   a re-sort caused by a pin, an unpin, or a background write moves nothing.
 * - Ids only in `frozen` are dropped (the row is gone).
 * - Ids only in `natural` are **inserted where the natural order puts them**
 *   relative to the rows already placed — directly after their nearest preceding
 *   natural neighbor, or at the front when they have none — so a newly-cached
 *   article still lands somewhere sensible rather than being tacked onto the end.
 *
 * Pass `[]` as `frozen` on first render: with nothing on screen to preserve, the
 * result is `natural` unchanged.
 */
export function applyStableOrder(natural: string[], frozen: string[]): string[] {
  const present = new Set(natural);
  const next = frozen.filter((id) => present.has(id));
  const placed = new Set(next);
  // The most recent natural element already sitting in `next` — an insertion
  // anchor maintained as we walk, so each newcomer costs one lookup instead of
  // a backward re-scan.
  let anchor: string | null = null;
  for (const id of natural) {
    if (placed.has(id)) {
      anchor = id;
      continue;
    }
    next.splice(anchor === null ? 0 : next.indexOf(anchor) + 1, 0, id);
    placed.add(id);
    anchor = id;
  }
  return next;
}
