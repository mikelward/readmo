// Shorthand expansion for the "Add a feed" box.
//
// Reddit is a first-class source (SPEC.md "Feed discovery"), and its URLs are
// long and easy to mistype. Let the user type the same `r/<sub>` shorthand they
// already use on Reddit itself and expand it to a full reddit.com URL before
// discovery runs. The server's redditFeedFor() then derives the canonical
// `.rss` feed form (subreddit, sort, search, multireddit, user) — so this
// helper deliberately stops at the host/path and does NOT append `.rss` itself.

const REDDIT_ORIGIN = 'https://www.reddit.com';

// First path segment must be EXACTLY r, u, or user (Reddit's own prefixes),
// optionally with a leading slash, followed by at least one more character.
// The trailing `(.+)` keeps any sort / search / multireddit tail intact
// (`r/news/top`, `r/news/search?q=x`, `user/alice/m/tech`). A real hostname
// ("r.jina.ai/feed") has a dot before the slash and so never matches.
const REDDIT_SHORTHAND = /^\/?(r|u|user)\/(.+)$/i;

/**
 * Expand a Reddit shorthand (`r/<sub>`, `u/<user>`, `user/<user>`, optionally
 * with a leading slash and a deeper tail) into a full reddit.com URL. Anything
 * else — full URLs, bare domains, blank input — is returned trimmed and
 * otherwise unchanged for the existing scheme-prepend + discovery path.
 */
export function expandFeedShorthand(input: string): string {
  const trimmed = input.trim();
  const m = REDDIT_SHORTHAND.exec(trimmed);
  if (!m) return trimmed;
  const prefix = m[1].toLowerCase();
  return `${REDDIT_ORIGIN}/${prefix}/${m[2]}`;
}
