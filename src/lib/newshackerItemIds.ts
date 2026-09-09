// Session cache of Readmo itemId → numeric Hacker News item id.
//
// The Done/Pinned mirror (`useNewshackerSync`) resolves an item's HN id at
// flush time. Normally it fetches the item, but a *tombstone* (un-dismiss /
// unpin) can clear the last permanent state (`pinned`/`favorite`/`done`) that
// made an item from an unsubscribed feed RLS-visible (`items_select`,
// 0002_rls.sql) — so the post-mutation fetch returns nothing and the tombstone
// would be lost, leaving the item pinned/done on newshacker forever.
//
// Fix: every HN-feed row remembers its id mapping when it renders (before any
// state is cleared — you must see the row to act on it), and the mirror recalls
// from here first. Only public, non-sensitive ids are stored (a Readmo itemId
// and a numeric HN id — the same mapping for every user, since items are
// shared), so this needs no per-user scoping. Bounded LRU so a long session
// can't grow it without limit.

import type { ItemId } from './types';

const MAX_ENTRIES = 5000;

// Insertion-ordered; re-inserting refreshes recency, and we evict the oldest
// key once over the cap.
const byItemId = new Map<ItemId, number>();

export function rememberHackerNewsItemId(itemId: ItemId, hnId: number): void {
  if (byItemId.has(itemId)) byItemId.delete(itemId);
  byItemId.set(itemId, hnId);
  if (byItemId.size > MAX_ENTRIES) {
    const oldest = byItemId.keys().next().value;
    if (oldest !== undefined) byItemId.delete(oldest);
  }
}

/** The remembered numeric HN id for an item, or null if it was never rendered
 * as a Hacker News row this session. */
export function recallHackerNewsItemId(itemId: ItemId): number | null {
  return byItemId.get(itemId) ?? null;
}
