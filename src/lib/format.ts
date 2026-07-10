// Common second-level labels that sit under a 2-letter ccTLD and behave
// like a TLD for registration purposes (`bbc.co.uk`, `9news.com.au`,
// `stuff.co.nz`, `asahi.co.jp`, `naver.or.kr`…). Not a full Public Suffix
// List — we'd rather ship no data file than drag one into the bundle —
// but it covers the long tail of mainstream feed domains well enough
// that we don't accidentally trim `9news.com.au` down to `9news`.
const NESTED_CCTLD_SECOND_LEVELS = new Set([
  'co',
  'com',
  'net',
  'org',
  'gov',
  'edu',
  'ac',
  'or',
  'ne',
  'mil',
  'gob',
]);

// Two-label suffixes where each subdomain is a separate user/project —
// Public Suffix List "private" entries. Trimming `jasoneckert.github.io`
// to `github.io` would throw away the owner, so we keep the first label.
// Hand-picked from the most common feed hosts; not the full PSL (that
// would be ~15KB of data for a cosmetic feature).
const COMPOUND_EFFECTIVE_TLDS = new Set([
  'github.io',
  'gitlab.io',
  'substack.com',
  'wordpress.com',
  'blogspot.com',
  'tumblr.com',
  'herokuapp.com',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'r2.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'cloudfront.net',
  'medium.com',
]);

function registrablePartCount(parts: string[]): number {
  if (parts.length < 2) return parts.length;
  if (parts.length >= 3) {
    const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (COMPOUND_EFFECTIVE_TLDS.has(last2)) return 3;
  }
  if (parts.length < 3) return parts.length;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && NESTED_CCTLD_SECOND_LEVELS.has(sld)) return 3;
  return 2;
}

export const DEFAULT_DISPLAY_DOMAIN_LENGTH = 22;

/**
 * Formats a URL's hostname for display in an item row:
 *   - strips `www.`
 *   - always trims leading subdomains down to the registrable
 *     domain (so `fingfx.thomsonreuters.com` → `thomsonreuters.com`,
 *     `old.reddit.com` → `reddit.com`, and `sport.bbc.co.uk` →
 *     `bbc.co.uk`), but never past it (so `9news.com.au` stays
 *     `9news.com.au`, and `jasoneckert.github.io` stays intact because
 *     `github.io` is on the compound-eTLD list)
 *   - falls back to a trailing-ellipsis truncation if the registrable
 *     domain itself is still over `maxLength`.
 *
 * Always-trim (vs. trim-only-when-long) is intentional: subdomains
 * rarely carry useful reader-facing identity — `sport.bbc.co.uk`,
 * `edition.cnn.com`, `old.reddit.com` all read better as the bare
 * domain — and the reader page still shows the full source for anyone
 * who wants the detail.
 */
export function formatDisplayDomain(
  url: string | undefined,
  maxLength: number = DEFAULT_DISPLAY_DOMAIN_LENGTH,
): string {
  if (!url) return '';
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return '';
  }
  hostname = hostname.replace(/^www\./, '');

  const parts = hostname.split('.');
  const keep = registrablePartCount(parts);
  if (parts.length > keep) {
    hostname = parts.slice(parts.length - keep).join('.');
  }

  if (hostname.length > maxLength) {
    const cut = Math.max(1, maxLength - 1);
    hostname = hostname.slice(0, cut) + '…';
  }

  return hostname;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Verbose relative time, e.g. `just now`, `2 minutes ago`, `2 days ago`.
 * Unlike itemMeta.ts's compact `formatAge` (`2m`/`2d`), this spells out the
 * unit for prose contexts like the About section.
 */
export function formatTimeAgoLong(unixSeconds: number, now: Date = new Date()): string {
  const nowS = Math.floor(now.getTime() / 1000);
  let diff = nowS - unixSeconds;
  if (diff < 0) diff = 0;

  if (diff < MINUTE) return 'just now';
  const ago = (n: number, unit: string) => `${n} ${pluralize(n, unit)} ago`;
  if (diff < HOUR) return ago(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return ago(Math.floor(diff / HOUR), 'hour');
  if (diff < MONTH) return ago(Math.floor(diff / DAY), 'day');
  if (diff < YEAR) {
    const mo = Math.floor(diff / MONTH);
    if (mo >= 12) return ago(1, 'year');
    return ago(mo, 'month');
  }
  return ago(Math.floor(diff / YEAR), 'year');
}

export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}
