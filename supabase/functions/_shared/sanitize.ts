// Readmo server-side HTML sanitizer.
//
// Publisher feed bodies are untrusted input (SPEC.md guardrail #6: "Sanitize
// all publisher HTML server-side"). We strip scripts, inline event handlers,
// and disallowed tags; force rel="noopener noreferrer" on every link; and
// absolutize relative src/href against the item's base URL so the stored body
// is self-contained and safe to render. We NEVER store or serve raw publisher
// HTML.
//
// Authored with a BARE specifier for `sanitize-html` so vitest (node) imports
// it directly; Deno resolves it via supabase/functions/import_map.json.

import sanitizeHtml from 'sanitize-html';

// A reading-oriented allow-list: structural and inline text tags, media, and
// tables. Notably absent: <script>, <style>, <iframe> (except via a tight
// transform below if ever needed), <form>, and any event-handler attribute.
// Also absent: <small> — its only role in feeds is presentational (e.g. The
// Economist wraps the opening words of a body in <small> for a small-caps lede),
// and since we strip inline styles the publisher's actual styling is gone
// anyway. Dropping the tag (its text is kept) avoids rendering those words at
// the UA's shrunken default. See the reader CSS for the belt-and-suspenders
// rule that also neutralizes any <small> already stored before this change.
const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br',
  'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'dd', 'del', 'details',
  'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'time', 'tr', 'u', 'ul', 'wbr',
  // Media: audio for podcast enclosures, source for responsive images.
  'audio', 'source', 'picture', 'video',
];

/**
 * Sanitize a feed item's HTML body.
 *
 * @param html    Raw publisher HTML (possibly null/empty).
 * @param baseUrl The item's canonical URL, used to absolutize relative
 *                links and image sources. May be null (then relative URLs are
 *                left as-is, since there is no safe base to resolve against).
 * @returns Clean HTML safe to store and render.
 */
export function sanitizeContent(
  html: string | null | undefined,
  baseUrl: string | null | undefined,
): string {
  if (!html) return '';

  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'name', 'rel', 'target', 'title'],
      img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
      source: ['src', 'srcset', 'type', 'media', 'sizes'],
      audio: ['src', 'controls', 'preload'],
      video: ['src', 'controls', 'poster', 'width', 'height', 'preload'],
      time: ['datetime'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      col: ['span'],
      colgroup: ['span'],
      // No "*": ['style', ...] — inline styles can hide tracking / clickjacking
      // and aren't needed for reading. on* handlers are dropped because they
      // are never in any allow-list.
    },
    // Scheme allow-list keeps out javascript:, data: (except images), vbscript:.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      // Permit inline data: images (common in feeds) but nothing else.
      img: ['http', 'https', 'data'],
    },
    // Drop the contents of <script>/<style> entirely rather than leaking text.
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title'],
    // Absolutize relative href/src against the item URL.
    transformTags: {
      a: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        const abs = absolutize(attribs.href, baseUrl);
        if (abs) next.href = abs;
        // Force safe link semantics: new tab + no referrer / opener leak.
        next.rel = 'noopener noreferrer nofollow';
        next.target = '_blank';
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        // Absolutize, then route through the same-origin image proxy so the
        // reader's browser never hits the publisher directly (SPEC.md
        // *Privacy* / guardrail: no reader IP/UA leak, strips tracking
        // pixels, doubles as the offline-image source). data: images are
        // inline and left untouched.
        const abs = absolutize(attribs.src, baseUrl);
        if (abs) next.src = proxify(abs);
        const srcset = proxifySrcset(attribs.srcset, baseUrl);
        if (srcset) next.srcset = srcset;
        // Lazy-load by default (SPEC.md reader view: "images lazy-load").
        if (!next.loading) next.loading = 'lazy';
        return { tagName, attribs: next };
      },
      source: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        // `<source srcset>` is always an image candidate (in <picture>/<img>),
        // so it goes through the image proxy. `<source src>` may be a media
        // enclosure (audio/video), which the image proxy must not touch — we
        // only absolutize it.
        const abs = absolutize(attribs.src, baseUrl);
        if (abs) next.src = abs;
        const srcset = proxifySrcset(attribs.srcset, baseUrl);
        if (srcset) next.srcset = srcset;
        return { tagName, attribs: next };
      },
      video: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        // `poster` is an image, so route it through the same-origin proxy just
        // like <img src> (no reader IP/UA leak, offline cache). `src` is the
        // video media enclosure, not an image, so the proxy must not touch it —
        // only absolutize, matching the <source src> rule above.
        const absSrc = absolutize(attribs.src, baseUrl);
        if (absSrc) next.src = absSrc;
        const absPoster = absolutize(attribs.poster, baseUrl);
        if (absPoster) next.poster = proxify(absPoster) ?? absPoster;
        return { tagName, attribs: next };
      },
    },
    // Discard comments (may carry conditional-comment payloads).
    allowProtocolRelative: false,
  });
}

/** Resolve a possibly-relative URL against a base; null on failure/empty. */
function absolutize(
  href: string | undefined,
  base: string | null | undefined,
): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Leave data: URIs and already-absolute/mailto untouched by URL() only when
  // there's a base; without a base we can't safely resolve relatives.
  try {
    return new URL(trimmed, base ?? undefined).toString();
  } catch {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
}

/**
 * Rewrite an absolute image URL to the same-origin proxy endpoint
 * `/api/img?url=…`. Leaves `data:` URIs (inline images) untouched, and is a
 * no-op for anything that isn't http(s). The proxy fetches through the
 * SSRF-hardened helper, caches, and strips third-party tracking pixels
 * (SPEC.md *Privacy*).
 *
 * `/api/img` is the spec-canonical same-origin path (it also matches the SW
 * runtime-cache rule in vite.config.ts, so proxied images are the offline
 * source). The Deno image function deploys at `/functions/v1/img`; the
 * same-origin `/api/img` route is backed by the thin Vercel Edge shim in
 * `api/img.ts`, which forwards to it (so the browser only ever talks to our
 * origin). See SETUP.md.
 */
export function proxify(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/img?url=${encodeURIComponent(url)}`;
}

/** Absolutize each candidate in a srcset ("url 1x, url 2x") and route it
 * through the image proxy. */
function proxifySrcset(
  srcset: string | undefined,
  base: string | null | undefined,
): string | null {
  if (!srcset) return null;
  const parts = srcset.split(',').map((c) => {
    const seg = c.trim();
    if (!seg) return seg;
    const sp = seg.indexOf(' ');
    const url = sp === -1 ? seg : seg.slice(0, sp);
    const descriptor = sp === -1 ? '' : seg.slice(sp);
    const abs = absolutize(url, base);
    return (proxify(abs ?? url) ?? url) + descriptor;
  });
  const joined = parts.filter(Boolean).join(', ');
  return joined || null;
}
