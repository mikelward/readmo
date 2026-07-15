// Curated per-publisher section feeds.
//
// Big news orgs typically publish many per-section RSS feeds (World, Business,
// Sport, …) but DON'T advertise them where a crawler can find them — BBC's
// feeds live on a separate host and are only listed on a help page, so live
// discovery of `bbc.com` finds nothing and falls through to the Google News
// last resort. So for the handful of major publishers that need it, we curate
// the section feed URLs directly: when the user adds such a site by name (a
// curated dropdown pick or a resolved catalog name) or by a site URL, the
// Add-a-feed picker offers these sections (main feed first) instead, and the
// user checks the ones they want. SPEC.md "Feed discovery".
//
// The long tail doesn't need this: blogs/Substacks/Ghost sites advertise their
// single feed in the page <head>, so live discovery already handles them. This
// list is purely additive — any site not listed here keeps today's behavior
// (live discovery → its advertised feed(s) → the allowlist-gated Google News
// fallback). Add publishers freely; keep each list MAIN FEED FIRST.
//
// These URLs follow each publisher's documented feed scheme and match the
// single-feed entries already in popularFeeds.ts, but were NOT live-verified at
// authoring time (the dev sandbox blocks egress to news domains). Run
// `npm run feeds:check` from an unrestricted network to confirm/prune them.

/** At most this many sections are offered for a publisher, so the picker stays
 * scannable even if a publisher's list grows. */
export const MAX_SECTIONS = 10;

export interface PublisherSection {
  /** Section label shown in the picker and pinned as the per-user title
   * override on subscribe (so the row reads "BBC World", not whatever generic
   * <channel><title> the section feed carries). */
  name: string;
  feedUrl: string;
}

export interface Publisher {
  /** Brand name, for comments/debugging; the picker labels rows per section. */
  name: string;
  /** Hosts (sans leading "www.") a user would type for the *site* itself. A
   * pasted site URL on one of these expands to the section picker — but only
   * when the URL doesn't itself look like a feed (see {@link looksLikeFeedUrl}),
   * so pasting a specific feed still subscribes to just that feed. */
  siteHosts: string[];
  /** Hosts the section feeds are actually served from (often a separate host,
   * e.g. feeds.bbci.co.uk). Used only to map a curated dropdown pick / resolved
   * catalog name back to its publisher; never triggers raw-paste expansion. */
  feedHosts: string[];
  /** Section feeds, MAIN FEED FIRST, up to ~{@link MAX_SECTIONS}. */
  sections: PublisherSection[];
}

export const PUBLISHERS: Publisher[] = [
  {
    name: 'BBC',
    siteHosts: ['bbc.com', 'bbc.co.uk'],
    feedHosts: ['feeds.bbci.co.uk'],
    sections: [
      { name: 'BBC News', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml' },
      { name: 'BBC World', feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'BBC UK', feedUrl: 'https://feeds.bbci.co.uk/news/uk/rss.xml' },
      { name: 'BBC Business', feedUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
      { name: 'BBC Politics', feedUrl: 'https://feeds.bbci.co.uk/news/politics/rss.xml' },
      { name: 'BBC Technology', feedUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
      {
        name: 'BBC Science & Environment',
        feedUrl: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
      },
      { name: 'BBC Health', feedUrl: 'https://feeds.bbci.co.uk/news/health/rss.xml' },
      {
        name: 'BBC Entertainment & Arts',
        feedUrl: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
      },
      { name: 'BBC Sport', feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml' },
    ],
  },
  {
    name: 'The Guardian',
    siteHosts: ['theguardian.com'],
    feedHosts: ['theguardian.com'],
    sections: [
      { name: 'Guardian News', feedUrl: 'https://www.theguardian.com/international/rss' },
      { name: 'Guardian World', feedUrl: 'https://www.theguardian.com/world/rss' },
      { name: 'Guardian US', feedUrl: 'https://www.theguardian.com/us-news/rss' },
      { name: 'Guardian UK', feedUrl: 'https://www.theguardian.com/uk-news/rss' },
      { name: 'Guardian Australia', feedUrl: 'https://www.theguardian.com/australia-news/rss' },
      { name: 'Guardian Business', feedUrl: 'https://www.theguardian.com/business/rss' },
      { name: 'Guardian Technology', feedUrl: 'https://www.theguardian.com/technology/rss' },
      { name: 'Guardian Science', feedUrl: 'https://www.theguardian.com/science/rss' },
      { name: 'Guardian Sport', feedUrl: 'https://www.theguardian.com/sport/rss' },
      { name: 'Guardian Culture', feedUrl: 'https://www.theguardian.com/culture/rss' },
    ],
  },
  {
    name: 'NPR',
    siteHosts: ['npr.org'],
    feedHosts: ['feeds.npr.org'],
    sections: [
      { name: 'NPR News', feedUrl: 'https://feeds.npr.org/1001/rss.xml' },
      { name: 'NPR World', feedUrl: 'https://feeds.npr.org/1004/rss.xml' },
      { name: 'NPR National', feedUrl: 'https://feeds.npr.org/1003/rss.xml' },
      { name: 'NPR Politics', feedUrl: 'https://feeds.npr.org/1014/rss.xml' },
      { name: 'NPR Business', feedUrl: 'https://feeds.npr.org/1006/rss.xml' },
      { name: 'NPR Technology', feedUrl: 'https://feeds.npr.org/1019/rss.xml' },
      { name: 'NPR Science', feedUrl: 'https://feeds.npr.org/1007/rss.xml' },
      { name: 'NPR Health', feedUrl: 'https://feeds.npr.org/1128/rss.xml' },
      { name: 'NPR Music', feedUrl: 'https://feeds.npr.org/1039/rss.xml' },
      { name: 'NPR Arts & Life', feedUrl: 'https://feeds.npr.org/1008/rss.xml' },
    ],
  },
  {
    name: 'CBC',
    siteHosts: ['cbc.ca'],
    feedHosts: ['cbc.ca'],
    sections: [
      { name: 'CBC Top Stories', feedUrl: 'https://www.cbc.ca/cmlink/rss-topstories' },
      { name: 'CBC World', feedUrl: 'https://www.cbc.ca/cmlink/rss-world' },
      { name: 'CBC Canada', feedUrl: 'https://www.cbc.ca/cmlink/rss-canada' },
      { name: 'CBC Politics', feedUrl: 'https://www.cbc.ca/cmlink/rss-politics' },
      { name: 'CBC Business', feedUrl: 'https://www.cbc.ca/cmlink/rss-business' },
      { name: 'CBC Technology & Science', feedUrl: 'https://www.cbc.ca/cmlink/rss-technology' },
      { name: 'CBC Health', feedUrl: 'https://www.cbc.ca/cmlink/rss-health' },
      { name: 'CBC Arts', feedUrl: 'https://www.cbc.ca/cmlink/rss-arts' },
      { name: 'CBC Sports', feedUrl: 'https://www.cbc.ca/cmlink/rss-sports' },
    ],
  },
  {
    name: 'The New York Times',
    siteHosts: ['nytimes.com'],
    feedHosts: ['rss.nytimes.com'],
    // NYT publishes a per-section feed at
    // rss.nytimes.com/services/xml/rss/nyt/<Section>.xml; HomePage is the front
    // page (the single-feed catalog entry). Capped at MAX_SECTIONS.
    sections: [
      { name: 'NYT Top Stories', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
      { name: 'NYT World', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
      { name: 'NYT US', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml' },
      { name: 'NYT Politics', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml' },
      { name: 'NYT Business', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
      { name: 'NYT Technology', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
      { name: 'NYT Science', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml' },
      { name: 'NYT Health', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml' },
      { name: 'NYT Sports', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml' },
      { name: 'NYT Arts', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml' },
    ],
  },
  {
    name: 'Sky News',
    siteHosts: ['news.sky.com'],
    feedHosts: ['feeds.skynews.com'],
    // Sky News publishes a per-section feed at
    // feeds.skynews.com/feeds/rss/<section>.xml; home is the front page (the
    // single-feed catalog entry).
    sections: [
      { name: 'Sky News', feedUrl: 'https://feeds.skynews.com/feeds/rss/home.xml' },
      { name: 'Sky News UK', feedUrl: 'https://feeds.skynews.com/feeds/rss/uk.xml' },
      { name: 'Sky News World', feedUrl: 'https://feeds.skynews.com/feeds/rss/world.xml' },
      { name: 'Sky News US', feedUrl: 'https://feeds.skynews.com/feeds/rss/us.xml' },
      { name: 'Sky News Politics', feedUrl: 'https://feeds.skynews.com/feeds/rss/politics.xml' },
      { name: 'Sky News Business', feedUrl: 'https://feeds.skynews.com/feeds/rss/business.xml' },
      { name: 'Sky News Technology', feedUrl: 'https://feeds.skynews.com/feeds/rss/technology.xml' },
      { name: 'Sky News Entertainment', feedUrl: 'https://feeds.skynews.com/feeds/rss/entertainment.xml' },
    ],
  },
];

/** Lowercase a host and drop a leading "www." so matching ignores that prefix. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Whether `host` is `candidate` or a subdomain of it (boundary-safe, so
 * "notbbc.com" does NOT match "bbc.com" but "feeds.bbc.com" does). */
function hostMatches(host: string, candidate: string): boolean {
  return host === candidate || host.endsWith(`.${candidate}`);
}

/** Parse a user-entered URL or bare host into a normalized hostname, prepending
 * https:// when no scheme is present (the Add-a-feed box accepts bare hosts).
 * Returns null when it can't be parsed as a host. */
function hostOf(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname;
    return host ? normalizeHost(host) : null;
  } catch {
    return null;
  }
}

/**
 * The publisher a user-entered feed name/URL belongs to, or null.
 *
 * @param input  A site URL, bare host, or curated feed URL.
 * @param sitesOnly  When true, match only the publisher's *site* hosts — used
 *   for a raw paste, where a feed URL on the publisher's feed host should
 *   subscribe directly rather than expand to the section picker. When false
 *   (a curated dropdown pick or resolved catalog name), match site *and* feed
 *   hosts so a known feed URL maps back to its publisher.
 */
export function publisherForUrl(
  input: string,
  { sitesOnly = false }: { sitesOnly?: boolean } = {},
): Publisher | null {
  const host = hostOf(input);
  if (!host) return null;
  for (const publisher of PUBLISHERS) {
    const hosts = sitesOnly
      ? publisher.siteHosts
      : [...publisher.siteHosts, ...publisher.feedHosts];
    if (hosts.some((h) => hostMatches(host, normalizeHost(h)))) return publisher;
  }
  return null;
}

/**
 * Whether a pasted URL looks like a feed itself (rather than a site page), so
 * the add flow subscribes to it directly instead of expanding it to a
 * publisher's section picker. Conservative: a Guardian *section feed*
 * (`/world/rss`) is a feed; the Guardian home page (`theguardian.com`) is not.
 */
export function looksLikeFeedUrl(input: string): boolean {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let path: string;
  try {
    path = new URL(withScheme).pathname.toLowerCase();
  } catch {
    return false;
  }
  // A feed-ish file extension, or a path segment that is (or begins with) a
  // feed word — "rss"/"feed"/"atom"/"rdf". The trailing [-_.] also catches slug
  // forms like CBC's "/cmlink/rss-topstories", while still requiring a real
  // boundary so "/feedback" (feed + "back") is NOT treated as a feed.
  if (/\.(xml|rss|atom|json)$/.test(path)) return true;
  return /(^|\/)(rss|rdf|feeds?|atom)([-_.]|\/|$)/.test(path);
}
