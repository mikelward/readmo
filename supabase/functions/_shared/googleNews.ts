// Recognize Google News RSS feed URLs.
//
// Google News RSS feeds all live under https://news.google.com/rss/... (search,
// topics, headlines, and section feeds; locale is carried in query params, not a
// per-country host). They are a Google-ToS gray area, so the `discover` function
// gates *adding* them on the trusted-user allowlist (see _shared/allowlist.ts).
// Matching the `/rss` path keeps the gate to feeds specifically, not every
// news.google.com page.

/** Whether `url` is a Google News RSS feed (`news.google.com/rss/...`). */
export function isGoogleNewsFeedUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'news.google.com') return false;
  const path = u.pathname.toLowerCase();
  return path === '/rss' || path.startsWith('/rss/');
}
