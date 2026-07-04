// Client-side glue for mirroring dismissals to newshacker.
//
// When a Hacker News item is marked Done (or un-done) in Readmo, we forward the
// numeric HN item id to newshacker's Done list via the `newshacker-sync` Edge
// Function. This module holds the pure mapping from "items whose Done just
// changed" to newshacker `/api/sync` `done` entries; the batching/transport
// live in `useNewshackerDismissSync`. See SPEC.md "Mirror dismissals to
// newshacker".

import { hackerNewsItemId, isHackerNewsFeed } from './newshacker';
import type { FeedItem, ItemId } from './types';

/** One newshacker `/api/sync` `done` entry: the numeric HN item id, the action
 * time (last-write-wins clock), and a tombstone flag for an un-dismiss. */
export interface NewshackerDoneEntry {
  id: number;
  at: number;
  deleted?: boolean;
}

/** The Done change for one item: its new value and when it happened. */
export interface DoneChange {
  done: boolean;
  at: number;
}

/**
 * Build newshacker `done` entries from a batch of just-changed items. Only items
 * from an actual **Hacker News feed** ({@link isHackerNewsFeed}) are considered,
 * then each is mapped to its numeric HN id (via {@link hackerNewsItemId}); items
 * with no derivable id are dropped. Gating on the feed first matters because
 * `hackerNewsItemId` also scans the item body/url — a non-HN blog post that
 * merely *links* to an HN discussion would otherwise mirror that unrelated story
 * as Done. `done:false` becomes a tombstone (`deleted:true`) so an un-dismiss
 * removes it from newshacker's list.
 */
export function buildDoneEntries(
  items: FeedItem[],
  changes: ReadonlyMap<ItemId, DoneChange>,
): NewshackerDoneEntry[] {
  const out: NewshackerDoneEntry[] = [];
  for (const { item, feed } of items) {
    const change = changes.get(item.id);
    if (!change) continue;
    if (!isHackerNewsFeed(feed)) continue;
    const hnId = hackerNewsItemId(item);
    if (hnId == null) continue;
    const entry: NewshackerDoneEntry = { id: Number(hnId), at: change.at };
    if (!change.done) entry.deleted = true;
    out.push(entry);
  }
  return out;
}
