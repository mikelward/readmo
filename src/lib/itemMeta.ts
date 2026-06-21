// Display-only meta helpers for item rows. Kept self-contained (no
// dependency on the ported format.ts) so the row renders the same way in
// the mock and Supabase data sources.

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
  const yr = Math.floor(day / 365);
  return `${yr}y`;
}

/** Trim a URL to its registrable-ish domain for the source label, matching
 * newshacker's domain trimming (old.reddit.com → reddit.com, www stripped). */
export function formatDisplayDomain(url: string | null): string {
  if (!url) return '';
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '');
  const parts = host.split('.');
  // Keep the last two labels for common TLDs; leave multi-part ccTLDs alone
  // enough for a readable label (e.g. news.bbc.co.uk → bbc.co.uk).
  if (parts.length > 2) {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    const ccSecondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
    if (last.length === 2 && ccSecondLevel.has(secondLast) && parts.length > 3) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }
  return host;
}

/** Only http(s) URLs are safe to hand to window.open / render as links. */
export function isSafeHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Build the row's display-only meta string: "source · age · author". */
export function formatItemMetaTail(parts: {
  source: string;
  publishedAt: number;
  author: string | null;
  now?: number;
}): string {
  const segs: string[] = [];
  if (parts.source) segs.push(parts.source);
  segs.push(formatAge(parts.publishedAt, parts.now));
  if (parts.author) segs.push(parts.author);
  return segs.join(' · ');
}
