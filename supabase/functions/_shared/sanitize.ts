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
        // Collapse a responsive srcset to ONE image, then route it through the
        // same-origin proxy so the reader's browser never hits the publisher
        // directly (SPEC.md *Privacy* / guardrail: no reader IP/UA leak, strips
        // tracking pixels, doubles as the offline-image source).
        //
        // Why collapse: a multi-width srcset makes the browser fetch a separate
        // candidate per <img>, and because each width is a distinct proxy URL it
        // is also a distinct proxy fetch + service-worker cache entry. In a
        // fixed-width reader column that buys almost nothing, so we pick a single
        // sensible width server-side (closest to TARGET_SRCSET_WIDTH) and drop
        // srcset/sizes — exactly one URL is ever requested. data: images are
        // inline and left untouched.
        const chosen = pickSrcsetCandidate(attribs.srcset) ?? attribs.src;
        const abs = absolutize(chosen, baseUrl);
        if (abs) next.src = proxify(abs);
        delete next.srcset;
        delete next.sizes;
        // Lazy-load by default (SPEC.md reader view: "images lazy-load").
        if (!next.loading) next.loading = 'lazy';
        return { tagName, attribs: next };
      },
      source: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        // `<source srcset>` is always an image candidate (in <picture>/<img>),
        // so it goes through the image proxy. Collapse it to a single width too
        // (same reason as <img>), keeping media/type so <picture> art-direction
        // still selects the right source — we just serve one width within it.
        // `<source src>` may be a media enclosure (audio/video), which the image
        // proxy must not touch — we only absolutize it.
        const chosen = pickSrcsetCandidate(attribs.srcset);
        if (chosen) {
          const abs = absolutize(chosen, baseUrl);
          next.srcset = proxify(abs ?? chosen) ?? chosen;
          delete next.sizes;
        }
        const absSrc = absolutize(attribs.src, baseUrl);
        if (absSrc) next.src = absSrc;
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

// Target width (CSS px) we collapse a responsive srcset down to. Because we
// drop srcset and serve a single src, the browser can no longer upgrade to a
// higher-res variant on retina — so this one width must already cover the
// densest common case. The reader column is 720px (mobile) / 860px (wider
// screens), so at 2× DPR the most demanding case wants ~1720px; 1600 stays
// near-crisp there while avoiding the publisher's largest (often 2000–3000px)
// original. Tunable: raising it serves sharper/heavier images, lowering it the
// reverse.
const TARGET_SRCSET_WIDTH = 1600;
// Density we collapse an x-descriptor srcset to when there are no width
// descriptors to compare — 2× covers retina without grabbing a 3× asset.
const TARGET_SRCSET_DENSITY = 2;

/**
 * Choose ONE candidate URL from a srcset — the one closest to
 * `TARGET_SRCSET_WIDTH` — so the proxy serves a single width per image instead
 * of one fetch (and one cache entry) per candidate. "Closest to the target"
 * naturally covers both ends: when every candidate is smaller than the target
 * the largest wins, when every candidate is larger the smallest wins, and a tie
 * breaks toward the larger (sharper) candidate. Returns the raw (un-proxied,
 * possibly relative) URL, or null when there's no usable srcset. Width
 * descriptors (`1424w`) are compared by width; a density-only/descriptor-less
 * srcset falls back to the candidate closest to `TARGET_SRCSET_DENSITY`.
 */
function pickSrcsetCandidate(srcset: string | undefined): string | null {
  if (!srcset) return null;
  const candidates = parseSrcsetCandidates(srcset);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].url;

  // Prefer width descriptors when any candidate carries one (a valid srcset
  // can't mix `w` and `x`, but be defensive and let the width group win).
  const widths = candidates
    .map((c) => ({ url: c.url, n: parseWidthDescriptor(c.descriptor) }))
    .filter((c): c is { url: string; n: number } => c.n !== null);
  if (widths.length > 0) {
    return closestTo(widths, TARGET_SRCSET_WIDTH).url;
  }

  // No width descriptors: compare densities, treating a bare candidate as 1×.
  const densities = candidates.map((c) => ({
    url: c.url,
    n: parseDensityDescriptor(c.descriptor) ?? 1,
  }));
  return closestTo(densities, TARGET_SRCSET_DENSITY).url;
}

/** Pick the item whose `n` is nearest `target`; ties favor the larger `n`. */
function closestTo<T extends { n: number }>(items: T[], target: number): T {
  return items.reduce((best, cur) => {
    const dCur = Math.abs(cur.n - target);
    const dBest = Math.abs(best.n - target);
    if (dCur < dBest || (dCur === dBest && cur.n > best.n)) return cur;
    return best;
  });
}

/** Numeric width from a `123w` descriptor, else null. */
function parseWidthDescriptor(descriptor: string): number | null {
  const m = /^(\d+)w$/.exec(descriptor.trim());
  return m ? Number(m[1]) : null;
}

/** Numeric density from a `2x` / `1.5x` descriptor, else null. */
function parseDensityDescriptor(descriptor: string): number | null {
  const m = /^(\d+(?:\.\d+)?)x$/.exec(descriptor.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Split a `srcset` attribute into `{ url, descriptor }` candidates following
 * the WHATWG parsing rules: a URL is a run of non-whitespace characters, an
 * optional descriptor follows after whitespace, and candidates are separated
 * by commas. Splitting naively on `,` is wrong because image URLs commonly
 * contain commas — e.g. Cloudflare image-resizing paths like
 * `/cdn-cgi/image/width=1424,quality=80,format=auto/…/img.jpg`. The naive
 * split shredded those into fragments, and a fragment like `quality=80` then
 * absolutized against the article URL into a bogus target the image proxy
 * could only 502 on. Parsing the URL as a non-whitespace run keeps it intact.
 */
function parseSrcsetCandidates(
  srcset: string,
): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let i = 0;
  const n = srcset.length;
  const isWs = (c: string) => /\s/.test(c);

  while (i < n) {
    // Skip leading whitespace and comma separators between candidates.
    while (i < n && (isWs(srcset[i]) || srcset[i] === ',')) i++;
    if (i >= n) break;

    // The URL is a maximal run of non-whitespace characters.
    const urlStart = i;
    while (i < n && !isWs(srcset[i])) i++;
    let url = srcset.slice(urlStart, i);

    let descriptor = '';
    if (url.endsWith(',')) {
      // A trailing comma on the URL means this candidate has no descriptor;
      // strip it (and any extras) so the comma isn't carried into the URL.
      url = url.replace(/,+$/, '');
    } else {
      // Skip whitespace, then read the descriptor up to the next comma.
      while (i < n && isWs(srcset[i])) i++;
      const descStart = i;
      while (i < n && srcset[i] !== ',') i++;
      descriptor = srcset.slice(descStart, i).trim();
      i++; // consume the separating comma
    }

    if (url) candidates.push({ url, descriptor });
  }

  return candidates;
}
