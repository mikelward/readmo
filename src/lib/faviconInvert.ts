// Some publishers ship a black-on-transparent favicon — a dark monochrome
// wordmark or glyph with no background. On the dark page background that ink
// all but disappears, so we invert it to white in dark mode. Inversion is
// opt-in per domain: blindly inverting every favicon would wreck full-color
// logos (a blue bird becoming orange), so this set lists only the domains whose
// favicon is known to be dark monochrome.
//
// Matching is on the favicon's own host (a domain here matches that exact host
// or any subdomain of it), since a publisher's icon is often served from a
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

/** Whether the favicon at `faviconUrl` is a dark monochrome mark that needs
 * inverting to stay visible in dark mode. Matches the favicon's host against
 * the set by exact host or subdomain suffix (e.g. cdn.vox-cdn.com matches
 * vox-cdn.com, www.abc.net.au matches abc.net.au) — deliberately host-based
 * rather than via the lossy display-domain trim, which mangles ccTLDs like
 * .net.au (www.abc.net.au would collapse to the net.au public suffix). */
export function faviconNeedsDarkInvert(
  faviconUrl: string | null | undefined,
): boolean {
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
