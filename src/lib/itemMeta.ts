// Display-only meta helpers for item rows.

import { formatDisplayDomain as formatRegistrableDomain } from './format';

/** Compact relative age, e.g. "just now", "3h", "2d", "5w". */
export function formatAge(publishedAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - publishedAt);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 52) return `${wk}w`;
  // Day 364 reaches week 52 (past the week bucket) but floors to year 0 —
  // roll it over to "1y" rather than render a nonsensical "0y" (same rollover
  // format.ts's formatTimeAgoLong applies at its month/year boundary).
  const yr = Math.max(1, Math.floor(day / 365));
  return `${yr}y`;
}

/** Trim a URL to its registrable-ish domain for the source label, matching
 * newshacker's domain trimming (old.reddit.com → reddit.com, www stripped).
 * Delegates to format.ts's implementation — the one place that knows about
 * compound eTLDs (jasoneckert.github.io must keep its owner label, not trim
 * to the bare public suffix "github.io") and the fuller ccTLD second-level
 * set (or.kr, ne.jp, edu.au, …). A second hand-rolled copy here silently
 * lacked both and mislabeled those publishers. */
export function formatDisplayDomain(url: string | null): string {
  return formatRegistrableDomain(url ?? undefined);
}

/** The article's publisher domain, to show next to the feed name — but only
 * when it differs from the feed's own site. Aggregator feeds (Hacker News,
 * Reddit, lobste.rs) link out to other sites, so "Hacker News" alone hides
 * where a row actually goes; surfacing "thedrive.com" next to it fixes that.
 * A normal blog feed links to itself, so we'd just be repeating the feed's own
 * domain — return '' in that case (and when the article URL is missing or
 * unparseable). `feedSiteUrl` should be the feed's home page (`feed.siteUrl`),
 * falling back to the feed URL when that's absent. */
export function articleSourceDomain(
  articleUrl: string | null,
  feedSiteUrl: string | null,
): string {
  const domain = formatDisplayDomain(articleUrl);
  if (!domain) return '';
  if (domain === formatDisplayDomain(feedSiteUrl)) return '';
  return domain;
}

// Item URLs come from whatever the publisher syndicated. In the very
// unlikely case that a non-http(s) scheme leaks through (`javascript:`,
// `data:`, `vbscript:`…), inlining that URL into an `href` or handing it to
// window.open would let a tap execute script on our origin. Narrow the
// allowlist to `http:` and `https:` and render the title / Open-original
// link as plain text otherwise. Relative and malformed URLs throw from
// `new URL(url)` and are rejected by the catch.
export function isSafeHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Build the row's display-only meta string: "source · domain-or-category-or-author · age".
 * `source` (the feed name) is omitted by the caller in group-by-feed view,
 * where the section header already carries it — pass '' there. `domain` (the
 * article's publisher domain, see `articleSourceDomain`), `category` (the
 * item's first publisher-supplied category/tag, `Item.categories[0]`), and
 * `author` share one slot rather than all showing: `domain` only exists for
 * an aggregator feed (Hacker News, Reddit, …), where knowing the actual
 * destination site matters more than a topic tag, so it wins when present;
 * `category` is next; `author` is the last resort, so a row with neither a
 * domain nor a category still shows something more than a bare age (TODO.md
 * *UI / layout*: an eventual author-based filter, matching title filters —
 * still deferred; this is display-only). */
export function formatItemMetaTail(parts: {
  source: string;
  domain?: string;
  category?: string;
  author?: string;
  publishedAt: number;
  now?: number;
}): string {
  const segs: string[] = [];
  if (parts.source) segs.push(parts.source);
  const fallbackSlot = parts.domain || parts.category || parts.author;
  if (fallbackSlot) segs.push(fallbackSlot);
  segs.push(formatAge(parts.publishedAt, parts.now));
  return segs.join(' · ');
}
