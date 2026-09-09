// Client-side glue for mirroring Readmo state changes to newshacker.
//
// When a Hacker News item is dismissed (Done) or pinned in Readmo, we forward
// the numeric HN item id to newshacker's matching sync list via the
// `newshacker-sync` Edge Function. This module holds the pure mapping from
// "items whose Done/Pinned just changed" to newshacker `/api/sync` entries; the
// batching/transport live in `useNewshackerSync`. See SPEC.md "Mirror
// dismissals and pins to newshacker".

import { hackerNewsItemId, isHackerNewsFeed } from './newshacker';
import type { FeedItem, ItemId } from './types';

/** One newshacker `/api/sync` list entry: the numeric HN item id, the action
 * time (last-write-wins clock), and a tombstone flag for a removal. */
export interface NewshackerEntry {
  id: number;
  at: number;
  deleted?: boolean;
}

/** The user-driven change for one item: the new value of whichever of Done /
 * Pinned this mutation touched, plus when it happened. A single mutation can
 * touch both (pinning clears Done, and vice-versa — see `applyMutation`). */
export interface MirrorChange {
  done?: boolean;
  pinned?: boolean;
  at: number;
}

/** The two newshacker lists this feature mirrors, each a batch of entries. */
export interface MirrorPayload {
  done: NewshackerEntry[];
  pinned: NewshackerEntry[];
}

function entry(id: number, at: number, on: boolean): NewshackerEntry {
  return on ? { id, at } : { id, at, deleted: true };
}

/**
 * Map a batch of resolved feed items to their numeric Hacker News ids. Only
 * items from an actual **Hacker News feed** ({@link isHackerNewsFeed}) are
 * considered, then each is mapped via {@link hackerNewsItemId}; items with no
 * derivable id are omitted. Gating on the feed first matters because
 * `hackerNewsItemId` also scans the item body/url — a non-HN blog post that
 * merely *links* to an HN discussion would otherwise be treated as that story.
 */
export function resolveHackerNewsIds(
  items: FeedItem[],
): Map<ItemId, number> {
  const out = new Map<ItemId, number>();
  for (const { item, feed } of items) {
    if (!isHackerNewsFeed(feed)) continue;
    const hnId = hackerNewsItemId(item);
    if (hnId != null) out.set(item.id, Number(hnId));
  }
  return out;
}

/**
 * Build newshacker `done` + `pinned` entries from the changed items, using an
 * already-resolved itemId → HN-id map. Items with no HN id in the map are
 * dropped (non-HN, or unresolvable). A `false` value becomes a tombstone
 * (`deleted:true`) so an un-dismiss / unpin removes it from newshacker's list.
 * Taking a pre-resolved map (rather than fetching here) lets the caller resolve
 * from a render-time cache when a tombstone has cleared the item's visibility.
 */
export function buildMirrorPayload(
  hnIdById: ReadonlyMap<ItemId, number>,
  changes: ReadonlyMap<ItemId, MirrorChange>,
): MirrorPayload {
  const done: NewshackerEntry[] = [];
  const pinned: NewshackerEntry[] = [];
  for (const [itemId, change] of changes) {
    const id = hnIdById.get(itemId);
    if (id == null) continue;
    if (change.done !== undefined) done.push(entry(id, change.at, change.done));
    if (change.pinned !== undefined) {
      pinned.push(entry(id, change.at, change.pinned));
    }
  }
  return { done, pinned };
}
