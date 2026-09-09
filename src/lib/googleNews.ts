// Recognize Google News RSS feed URLs (client copy).
//
// Mirrors supabase/functions/_shared/googleNews.ts. The Vite client can't import
// the Deno server module, so the predicate is duplicated; both sides carry the
// same tests to keep them in sync. Used to route Google News feeds in an OPML
// import through the gated `discover` path instead of a direct subscribe (those
// feeds are restricted to the trusted-user allowlist — see SPEC "Feed
// discovery" / "Full-text reading mode").

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
