import type { FeedId, ItemId, ItemState } from './types';

/** A minimal view of a loaded row — id + which feed it belongs to. */
interface RawRow {
  item: { id: ItemId; feedId: FeedId };
}

/**
 * Optimistically reconcile the server-derived per-feed unread/to-do counts with
 * local triage that hasn't synced yet.
 *
 * `getFeedUnreadCounts` is a server-only read, so it lags a just-applied write
 * by a sync round-trip: right after a Sweep (or row Done) the badge would sit at
 * its pre-sweep value while the rows are already gone from the list. For each
 * loaded row with a still-**pending** (unsynced) write whose *current* state
 * unambiguously means the server still counts it but the user has triaged it
 * away — now Done or active-Hidden, **not** pinned, and **not** Opened — subtract
 * one from its feed's count.
 *
 * This deliberately reads only the *current* local state, never an inferred
 * server state: the outbox coalesces pending writes to their final value, so a
 * field's pre-sync server value can't be recovered by "flipping" the pending
 * change (pin-then-unpin-before-sync leaves `{pinned:false}` over a server that
 * is already `pinned:false`). The conservative predicate can't over-count as a
 * result; its one cost is that a pinned-then-read row later marked Done (the pin
 * cleared, `opened` still true) keeps lagging until its write syncs rather than
 * dropping instantly — an acceptable, self-healing miss.
 *
 * Keying off `pending` is what self-clears the adjustment: once a write drains
 * it leaves the set AND the server count already excludes the row, so there's no
 * double-subtract. A source with no outbox (the mock) passes an empty set and
 * the counts pass through untouched.
 */
export function adjustUnreadCounts(
  serverCounts: Record<FeedId, number>,
  rawItems: readonly RawRow[],
  getState: (id: ItemId) => ItemState,
  pending: ReadonlySet<ItemId> = new Set(),
): Record<FeedId, number> {
  if (pending.size === 0) return serverCounts;

  const decrements = new Map<FeedId, number>();
  for (const { item } of rawItems) {
    if (!pending.has(item.id)) continue;
    const st = getState(item.id);
    if ((st.done || st.hidden) && !st.pinned && !st.opened) {
      decrements.set(item.feedId, (decrements.get(item.feedId) ?? 0) + 1);
    }
  }
  if (decrements.size === 0) return serverCounts;

  const out: Record<FeedId, number> = { ...serverCounts };
  for (const [feedId, dec] of decrements) {
    if (out[feedId] != null) out[feedId] = Math.max(0, out[feedId] - dec);
  }
  return out;
}
