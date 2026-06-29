// Hacker News ↔ newshacker helpers for the per-feed "open on newshacker" mode.
//
// newshacker (newshacker.app) is a mobile-friendly reader for Hacker News whose
// thread page is `newshacker.app/item/<hn-id>` (numeric HN item id). When a
// Hacker News feed is in "open on newshacker" mode, its rows deep-link to that
// page instead of the in-app reader. The HN id is derived client-side from data
// readmo already stores: a Hacker News feed item's guid (and often its url) is
// the HN discussion link, `https://news.ycombinator.com/item?id=<id>`.

import type { Feed, Item } from './types';

/** newshacker's primary origin (hnews.app 301s here). */
export const NEWSHACKER_ORIGIN = 'https://newshacker.app';

/** Hosts that identify a feed as a Hacker News feed (www. stripped). The
 * official feed lives on news.ycombinator.com; hnrss.org is the common
 * third-party HN feed generator. */
const HN_FEED_HOSTS = new Set(['news.ycombinator.com', 'hnrss.org']);

function host(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Whether a feed is a Hacker News feed — i.e. its site or feed URL is on a
 * known HN host. Used to decide whether to offer the "open on newshacker" mode
 * for a subscription. */
export function isHackerNewsFeed(feed: Pick<Feed, 'url' | 'siteUrl'>): boolean {
  const site = host(feed.siteUrl);
  if (site && HN_FEED_HOSTS.has(site)) return true;
  const fetchUrl = host(feed.url);
  return fetchUrl != null && HN_FEED_HOSTS.has(fetchUrl);
}

/** The numeric Hacker News item id for an HN discussion link, or null if the URL
 * isn't a `news.ycombinator.com/item?id=<digits>` link. Only the canonical HN
 * host counts (hnrss.org items still point their comments link at HN itself). */
function hnIdFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname.replace(/^www\./, '') !== 'news.ycombinator.com') return null;
  if (u.pathname !== '/item') return null;
  const id = u.searchParams.get('id');
  return id != null && /^\d+$/.test(id) ? id : null;
}

/** The first Hacker News item id linked from a chunk of (already-sanitized)
 * item HTML, or null. The official `news.ycombinator.com/rss` feed carries the
 * discussion link only in the item `<description>` (e.g. `<a
 * href="…/item?id=N">Comments</a>`), which our parser stores as `contentHtml`
 * but not as a structured field — so the row body's HTML is the id source for
 * that feed. hnrss feeds also include the same link. First match wins; HN
 * descriptions carry exactly one `item?id=` link (the story's own discussion). */
function hnIdFromHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = html.match(/news\.ycombinator\.com\/item\?id=(\d+)/i);
  return m ? m[1] : null;
}

/** The Hacker News item id for a feed item, from its HN discussion link — the
 * structured `commentsUrl` first (the RSS `<comments>` / Atom `rel="replies"`
 * link, persisted on the item; present on list rows the `feed_items` RPC
 * returns), then the guid (hnrss sets it to the comments URL), then the item url
 * (Ask/Show HN text posts link to the discussion directly), then the stored item
 * HTML as a backfill (see {@link hnIdFromHtml}) — which covers the official HN
 * feed's already-stored rows and any read that omits `comments_url`
 * (library/search/reader, or a backend predating the column). Null when none
 * yields an id, so the row can fall back to the in-app reader. */
export function hackerNewsItemId(
  item: Pick<Item, 'guid' | 'url' | 'commentsUrl' | 'contentHtml'>,
): string | null {
  return (
    hnIdFromUrl(item.commentsUrl) ??
    hnIdFromUrl(item.guid) ??
    hnIdFromUrl(item.url) ??
    hnIdFromHtml(item.contentHtml)
  );
}

/** The newshacker thread URL for a Hacker News item id. */
export function newshackerItemUrl(hnId: string): string {
  return `${NEWSHACKER_ORIGIN}/item/${hnId}`;
}

/** The newshacker URL a feed item's row should open, or null when the item has
 * no derivable Hacker News id (the row then falls back to the in-app reader,
 * mirroring how "open original" falls back for a non-http url). */
export function newshackerUrlForItem(
  item: Pick<Item, 'guid' | 'url' | 'commentsUrl' | 'contentHtml'>,
): string | null {
  const id = hackerNewsItemId(item);
  return id == null ? null : newshackerItemUrl(id);
}

/** The newshacker thread URL for a single comments/discussion link, or null
 * when it isn't a `news.ycombinator.com/item?id=<id>` link. Unlike
 * {@link newshackerUrlForItem}, this looks at ONLY the given URL — it never
 * scans the item's guid/url/body — so it's safe to use on a non-Hacker-News
 * feed whose structured `commentsUrl` happens to point at an HN thread, without
 * misfiring on a normal item that merely links to HN in its body. */
export function newshackerUrlForCommentsUrl(
  commentsUrl: string | null | undefined,
): string | null {
  const id = hnIdFromUrl(commentsUrl);
  return id == null ? null : newshackerItemUrl(id);
}
