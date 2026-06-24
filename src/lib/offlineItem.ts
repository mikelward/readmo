import type { QueryClient } from '@tanstack/react-query';
import type { FeedItem } from './types';

// Offline recovery for the reader. When the per-item detail read (`getItem`)
// can't reach the network — the device is offline and the article isn't
// pinned-cached — we can still show *something* immediately: the feed's own
// body. List payloads already carry it. The `feed_items` RPC returns the whole
// item composite and only nulls `full_content_html` (0011), so every home/
// folder/feed/library page persisted in the query cache holds `content_html`
// for the rows it loaded. This walks those cached pages to find a prior copy of
// the item, so an unpinned article stays readable offline (the RSS body, not the
// extracted reading view).

function isFeedItem(value: unknown): value is FeedItem {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { item?: { id?: unknown }; feed?: unknown };
  return (
    !!candidate.item &&
    typeof candidate.item.id === 'string' &&
    !!candidate.feed
  );
}

/** Pull a FeedItem with the given id out of one cached query's data. Handles
 * the three list shapes that hold FeedItems on this device:
 *   - an infinite-query cache `{ pages: Page<FeedItem>[] }` — the Home/folder/
 *     feed views (`useInfiniteQuery`, `lib/.../useFeedItems.ts`);
 *   - a single `Page<FeedItem>` (`{ items }`);
 *   - a bare `FeedItem[]` — the library lists (`useQuery`).
 * Returns null for any other shape (e.g. the `['offline']` `Item[]` cache,
 * whose entries lack a `feed` and whose items are pinned — so their detail is
 * cached directly anyway). */
function pluckFeedItem(data: unknown, id: string): FeedItem | null {
  if (!data || typeof data !== 'object') return null;
  // Infinite-query cache: { pages: Page<FeedItem>[], pageParams }. Recurse into
  // each page (each is a `Page<FeedItem>` handled by the branch below).
  const pages = (data as { pages?: unknown }).pages;
  if (Array.isArray(pages)) {
    for (const page of pages) {
      const found = pluckFeedItem(page, id);
      if (found) return found;
    }
    return null;
  }
  const items = Array.isArray(data)
    ? data
    : (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  for (const entry of items) {
    if (isFeedItem(entry) && entry.item.id === id) return entry;
  }
  return null;
}

/**
 * Scan the persisted list query caches (feed pages, library lists, the offline
 * list) for a previously-loaded copy of `id`. Returns the cached `FeedItem`
 * (feed body only — list payloads never carry `full_content_html`) or null when
 * the item was never loaded into any list on this device.
 */
export function findCachedFeedItem(
  client: QueryClient,
  id: string,
): FeedItem | null {
  for (const [, data] of client.getQueriesData({})) {
    const found = pluckFeedItem(data, id);
    if (found) return found;
  }
  return null;
}
