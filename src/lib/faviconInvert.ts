// Some publishers ship a black-on-transparent favicon — a dark monochrome
// wordmark or glyph with no background. On the dark page background that ink
// all but disappears, so we invert it to white in dark mode. Blindly inverting
// every favicon would wreck full-color logos (a blue bird becoming orange), so
// inversion is gated two ways:
//
//   1. The poller MEASURES each favicon and stores a verdict on the feed
//      (`Feed.faviconInvertDark`; see the `faviconDarkness` Edge decoder). This
//      is the primary signal and scales automatically to any publisher.
//   2. A small manual host list below, used as an OVERRIDE/fallback for icons
//      the poller can't decode (SVG, exotic formats), feeds not yet re-polled
//      since 0037, and a pre-0037 backend (where the flag is absent). It can
//      only ADD inversions, never remove a measured one.
//
// Manual matching is on the favicon's own host (a domain matches that exact
// host or any subdomain), since a publisher's icon is often served from a
// separate CDN — list every host its icon may come from:
//   - vox.com / vox-cdn.com — Vox advertises its <icon> on cdn.vox-cdn.com
//     (see supabase/functions/_shared/parser.test.ts); vox.com covers the
//     /favicon.ico fallback when no icon is advertised.
//   - abc.net.au — ABC News (Australia); its RSS feeds advertise no icon, so
//     the favicon is the derived www.abc.net.au/favicon.ico (the dark ABC mark).
const DARK_MONOCHROME_FAVICON_DOMAINS = new Set<string>([
  'vox.com',
  'vox-cdn.com',
  'abc.net.au',
]);

/** Whether `faviconUrl`'s host is on the manual dark-icon override list.
 * Host-based (exact host or subdomain suffix, e.g. cdn.vox-cdn.com matches
 * vox-cdn.com, www.abc.net.au matches abc.net.au) — deliberately not the lossy
 * display-domain trim, which mangles ccTLDs like .net.au (www.abc.net.au would
 * collapse to the net.au public suffix). */
function matchesManualList(faviconUrl: string | null | undefined): boolean {
  if (!faviconUrl) return false;
  let host: string;
  try {
    host = new URL(faviconUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const domain of DARK_MONOCHROME_FAVICON_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** Whether a feed's favicon should be inverted in dark mode. Trusts the
 * poller's measured verdict when it says "yes"; otherwise (measured-no, not yet
 * measured, or a pre-0037 backend where the flag is absent) falls back to the
 * manual host list, which can only add inversions. */
export function faviconNeedsDarkInvert(
  faviconUrl: string | null | undefined,
  measured?: boolean | null,
): boolean {
  if (measured === true) return true;
  return matchesManualList(faviconUrl);
}
