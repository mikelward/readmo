// Matches src/poster="..." attributes pointing at our image proxy.
// HTML is sanitized server-side so we only need well-formed double-quoted attrs.
const ATTR_RE = /\s(?:src|poster)="(\/api\/img[^"]*)"/g;

// Matches srcset="..." attribute values.
const SRCSET_ATTR_RE = /\ssrcset="([^"]*)"/g;

/**
 * Return every `/api/img?url=…` URL found in a sanitized HTML string,
 * covering `src`, `poster` (video), and `srcset` (img/source) attributes
 * that the server-side sanitizer routes through the image proxy.
 * Used by `useOfflineCacheLock` to fire background fetches so the service
 * worker caches article images for offline reading.
 */
export function extractProxiedImageUrls(html: string): string[] {
  const urls: string[] = [];

  // src and poster single-URL attributes
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(html)) !== null) {
    urls.push(m[1]);
  }

  // srcset multi-candidate attributes: split on commas (the CSS Images spec
  // separator), then take the first whitespace-delimited token of each
  // candidate as the URL (trimming optional descriptors like "1x" or "320w").
  SRCSET_ATTR_RE.lastIndex = 0;
  while ((m = SRCSET_ATTR_RE.exec(html)) !== null) {
    for (const candidate of m[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url && url.startsWith('/api/img')) urls.push(url);
    }
  }

  return urls;
}

