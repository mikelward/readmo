// Matches src="..." attributes pointing at our image proxy. The regex is
// intentionally simple — HTML is already sanitized server-side, so we only
// need to find well-formed src attributes with /api/img paths.
const IMG_SRC_RE = /\ssrc="(\/api\/img[^"]*)"/g;

/**
 * Return every `/api/img?url=…` src URL found in a sanitized HTML string.
 * Used by `useOfflineCacheLock` to fire background fetches so the service
 * worker caches article images for offline reading.
 */
export function extractProxiedImageUrls(html: string): string[] {
  const urls: string[] = [];
  IMG_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_SRC_RE.exec(html)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}
