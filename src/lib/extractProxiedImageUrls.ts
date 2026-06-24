// Matches src/poster="..." attributes pointing at our image proxy.
// HTML is sanitized server-side so we only need well-formed double-quoted attrs.
const ATTR_RE = /\s(?:src|poster)="(\/api\/img[^"]*)"/g;

// Matches each whitespace-separated candidate in a srcset="..." attribute.
// Captures the URL token before an optional descriptor (e.g. "1x", "320w").
const SRCSET_ATTR_RE = /\ssrcset="([^"]*)"/g;
const SRCSET_CANDIDATE_RE = /(\S+)(?:\s+\S+)?/g;

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

  // srcset multi-candidate attributes
  SRCSET_ATTR_RE.lastIndex = 0;
  while ((m = SRCSET_ATTR_RE.exec(html)) !== null) {
    const srcset = m[1];
    SRCSET_CANDIDATE_RE.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = SRCSET_CANDIDATE_RE.exec(srcset)) !== null) {
      if (c[1].startsWith('/api/img')) urls.push(c[1]);
    }
  }

  return urls;
}
