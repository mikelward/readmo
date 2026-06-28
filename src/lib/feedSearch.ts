import type { PopularFeed } from './popularFeeds';

/** Word-initials of a name, letters/digits only and lowercased. Words are
 * split on whitespace/punctuation *and* on camel-case and letter↔digit
 * boundaries, so names that encode words without spaces still yield useful
 * initials: "The Wall Street Journal" → "twsj", "freeCodeCamp" → "fcc",
 * "3Blue1Brown" → "3b1b", "9to5Mac" → "9t5m" (so a query "9m" still finds it
 * as a subsequence). Used for acronym matching so "wsj" finds "Wall Street
 * Journal". */
function initials(name: string): string {
  return name
    // Insert a break at each camel-case (aA) and letter↔digit transition, then
    // split on those plus any run of non-alphanumerics.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .toLowerCase();
}

/** True when every character of `q` appears in `s` in order (gaps allowed) —
 * i.e. `q` is a subsequence of `s`. Empty `q` is vacuously true. */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j += 1) {
    if (s[j] === q[i]) i += 1;
  }
  return i === q.length;
}

/**
 * Rank a curated feed catalog against a typed query. Two tiers, best first:
 *
 *  0. **Substring** on the display name, feed URL, or category — the literal
 *     "type part of what you see" match (so a country code like `au` finds
 *     `.com.au`, a topic like `science` finds that section).
 *  1. **Acronym / initialism** — the query (letters/digits only) is a
 *     subsequence of the name's word-initials, so "wsj" → "Wall Street
 *     Journal", "nyt" → "New York Times" (the leading "The" is skipped for
 *     free because a subsequence need not start at the first initial), "scmp"
 *     → "South China Morning Post".
 *
 * Acronym matching requires a 2+ char query: a single letter as a subsequence
 * of initials would match nearly every feed, so one-character queries fall back
 * to substring only. Ties keep the catalog's original (rough popularity) order.
 */
export function searchFeeds(query: string, feeds: PopularFeed[]): PopularFeed[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qAlnum = q.replace(/[^a-z0-9]/g, '');

  const ranked: Array<{ feed: PopularFeed; tier: number; idx: number }> = [];
  feeds.forEach((feed, idx) => {
    if (
      feed.name.toLowerCase().includes(q) ||
      feed.feedUrl.toLowerCase().includes(q) ||
      feed.category.toLowerCase().includes(q)
    ) {
      ranked.push({ feed, tier: 0, idx });
    } else if (qAlnum.length >= 2 && isSubsequence(qAlnum, initials(feed.name))) {
      ranked.push({ feed, tier: 1, idx });
    }
  });

  ranked.sort((a, b) => a.tier - b.tier || a.idx - b.idx);
  return ranked.map((r) => r.feed);
}

/**
 * Resolve a typed query to a single catalog feed for *submit-time* subscription
 * (pressing Add without picking a suggestion). Deliberately strict — it only
 * resolves a query that *is* a feed's identifier, never a substring, URL,
 * category, or partial topic:
 *
 *  1. an **exact name** match (handles dotted names like "Inc." / "The A.V.
 *     Club");
 *  2. otherwise, an **exact acronym** match — the query equals a feed's full
 *     word-initials and exactly one feed has them, so "wsj" → "Wall Street
 *     Journal", "fcc" → "freeCodeCamp".
 *
 * Everything else returns null and falls through to discovery / the dropdown:
 * real URLs and hosts ("openai.com"), partial names ("guardian"), and broad
 * topic / country-code words ("programming", "health", "ai", "au") are never a
 * feed's exact name or acronym, so they're never silently auto-subscribed — the
 * user picks them from the dropdown. Returns the matched feed, or null.
 */
export function resolveFeedByName(query: string, feeds: PopularFeed[]): PopularFeed | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const exact = feeds.find((f) => f.name.toLowerCase() === q);
  if (exact) return exact;

  const qAlnum = q.replace(/[^a-z0-9]/g, '');
  if (qAlnum.length < 2) return null;
  const acronymHits = feeds.filter((f) => initials(f.name) === qAlnum);
  return acronymHits.length === 1 ? acronymHits[0] : null;
}
