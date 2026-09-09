// Shorthand expansion for the "Add a feed" box.
//
// Reddit and YouTube are first-class sources whose URLs are long and easy to
// mistype. Let the user type the same prefix shorthand they already use on
// each site and expand it to a full URL before discovery runs.
//
//   r/<sub>, u/<user>, user/<u>   → reddit.com path; the server's
//                                    redditFeedFor() then derives the
//                                    canonical `.rss` form.
//   youtube/<handle>, yt/<handle> → youtube.com/@<handle>; discovery picks
//                                    up the channel's Atom feed from the
//                                    page's <link rel="alternate"> tag.
//
// This helper deliberately stops at the host/path and does NOT append a
// feed suffix itself.

const REDDIT_ORIGIN = 'https://www.reddit.com';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';

// First path segment must be EXACTLY r, u, or user (Reddit's own prefixes),
// optionally with a leading slash, followed by at least one more character.
// The trailing `(.+)` keeps any sort / search / multireddit tail intact
// (`r/news/top`, `r/news/search?q=x`, `user/alice/m/tech`). A real hostname
// ("r.jina.ai/feed") has a dot before the slash and so never matches.
const REDDIT_SHORTHAND = /^\/?(r|u|user)\/(.+)$/i;

// First path segment EXACTLY youtube or yt, then a handle. The handle may be
// preceded by an `@` (matching YouTube's on-site display) which we strip
// before re-prefixing — both `youtube/mkbhd` and `youtube/@mkbhd` resolve to
// the same canonical `/@mkbhd` URL.
const YOUTUBE_SHORTHAND = /^\/?(youtube|yt)\/@?([A-Za-z0-9._-]+)$/i;

/**
 * Expand a known shorthand into a full URL.
 *
 * Reddit: `r/<sub>`, `u/<user>`, `user/<user>` (with optional leading slash
 * and a deeper tail) → reddit.com/<…>.
 *
 * YouTube: `youtube/<handle>` or `yt/<handle>` (with or without a leading
 * `@`) → youtube.com/@<handle>.
 *
 * Anything else — full URLs, bare domains, blank input — is returned trimmed
 * and otherwise unchanged for the existing scheme-prepend + discovery path.
 */
export function expandFeedShorthand(input: string): string {
  const trimmed = input.trim();

  const reddit = REDDIT_SHORTHAND.exec(trimmed);
  if (reddit) {
    const prefix = reddit[1].toLowerCase();
    return `${REDDIT_ORIGIN}/${prefix}/${reddit[2]}`;
  }

  const youtube = YOUTUBE_SHORTHAND.exec(trimmed);
  if (youtube) {
    return `${YOUTUBE_ORIGIN}/@${youtube[2]}`;
  }

  return trimmed;
}
