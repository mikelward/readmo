// Matches src/poster="..." attributes pointing at our image proxy.
// HTML is sanitized server-side so we only need well-formed double-quoted attrs.
const ATTR_RE = /\s(?:src|poster)="(\/api\/img[^"]*)"/g;

// Matches srcset="..." attribute values.
const SRCSET_ATTR_RE = /\ssrcset="([^"]*)"/g;

// Width (CSS px) we collapse a responsive srcset down to for prefetch — mirrors
// the sanitizer's TARGET_SRCSET_WIDTH so the URL we warm matches the candidate
// the reader's <img> is most likely to display (reader column × ~2× DPR).
const TARGET_SRCSET_WIDTH = 1600;
// Density we collapse an x-descriptor srcset to when there are no width
// descriptors (a retina reader). Mirrors the sanitizer's TARGET_SRCSET_DENSITY.
const TARGET_SRCSET_DENSITY = 2;

/**
 * Choose ONE proxied candidate URL from a srcset — the one closest to the
 * target width (or density), mirroring the server-side sanitizer's collapse so
 * the offline prefetch warms a single width per image instead of every
 * advertised candidate. Returns null when no candidate routes through the proxy.
 *
 * The sanitizer already collapses srcset to a single `src` for newly-stored
 * rows, but items stored before that change still carry the full multi-width
 * srcset; collapsing here keeps the prefetch to one fetch per image regardless.
 */
function pickProxiedSrcsetCandidate(srcset: string): string | null {
  const candidates: { url: string; descriptor: string }[] = [];
  for (const part of srcset.split(',')) {
    const [url, descriptor = ''] = part.trim().split(/\s+/);
    if (url && url.startsWith('/api/img')) candidates.push({ url, descriptor });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].url;

  const widths = candidates
    .map((c) => ({ url: c.url, n: parseDescriptor(c.descriptor, 'w') }))
    .filter((c): c is { url: string; n: number } => c.n !== null);
  if (widths.length > 0) return closestTo(widths, TARGET_SRCSET_WIDTH);

  const densities = candidates.map((c) => ({
    url: c.url,
    n: parseDescriptor(c.descriptor, 'x') ?? 1,
  }));
  return closestTo(densities, TARGET_SRCSET_DENSITY);
}

/** Numeric value from a `123w` / `1.5x` descriptor matching `unit`, else null. */
function parseDescriptor(descriptor: string, unit: 'w' | 'x'): number | null {
  const re = unit === 'w' ? /^(\d+)w$/ : /^(\d+(?:\.\d+)?)x$/;
  const m = re.exec(descriptor.trim());
  return m ? Number(m[1]) : null;
}

/** URL of the candidate whose `n` is nearest `target`; ties favor the larger. */
function closestTo(items: { url: string; n: number }[], target: number): string {
  return items.reduce((best, cur) => {
    const dCur = Math.abs(cur.n - target);
    const dBest = Math.abs(best.n - target);
    return dCur < dBest || (dCur === dBest && cur.n > best.n) ? cur : best;
  }).url;
}

// Matches a single <img …> or <source …> start tag. HTML is sanitized
// server-side (well-formed, double-quoted attrs, no `>` inside attr values),
// so a `[^>]*` tag body is safe — the same assumption the extractors rely on.
const IMG_OR_SOURCE_TAG_RE = /<(img|source)\b[^>]*>/gi;
const SRCSET_VALUE_RE = /\ssrcset="([^"]*)"/i;
const SRC_VALUE_RE = /\ssrc="[^"]*"/i;
const SIZES_VALUE_RE = /\ssizes="[^"]*"/i;

/**
 * Collapse every **proxied** responsive `srcset` in a sanitized HTML string to
 * a single candidate (nearest ~1600px), mirroring the server-side sanitizer for
 * rows stored before that collapse shipped. On `<img>` the chosen candidate
 * becomes `src` and `srcset`/`sizes` are dropped; on `<source>` (art-directed
 * `<picture>`) the `srcset` is rewritten to the single candidate and its media
 * query preserved.
 *
 * The reader injects stored HTML verbatim via `dangerouslySetInnerHTML`, so the
 * browser otherwise picks a viewport/DPR-dependent candidate from a stale
 * ladder. Collapsing here makes the rendered `<img>` request the **same** URL
 * the offline prefetch (`extractProxiedImageUrls`, same ~1600px pick) warms, so
 * a pinned/favorited article's images stay in the service-worker cache offline
 * instead of missing whenever the browser would have chosen a different width.
 * A non-proxied srcset (no `/api/img` candidate) is left untouched.
 */
export function collapseProxiedSrcset(html: string): string {
  return html.replace(IMG_OR_SOURCE_TAG_RE, (tag, name: string) => {
    const srcset = SRCSET_VALUE_RE.exec(tag);
    if (!srcset) return tag;
    const chosen = pickProxiedSrcsetCandidate(srcset[1]);
    if (!chosen) return tag; // no proxied candidate — leave the tag as-is

    let next = tag.replace(SIZES_VALUE_RE, '');
    if (name.toLowerCase() === 'source') {
      // Keep the <source> (its media query art-directs <picture>), one width.
      return next.replace(SRCSET_VALUE_RE, () => ` srcset="${chosen}"`);
    }
    // <img>: a single src is enough; drop srcset entirely.
    next = next.replace(SRCSET_VALUE_RE, '');
    return SRC_VALUE_RE.test(next)
      ? next.replace(SRC_VALUE_RE, () => ` src="${chosen}"`)
      : next.replace(/\s*\/?>$/, () => ` src="${chosen}">`);
  });
}

/**
 * Return every proxied `/api/img?url=…` URL the offline prefetch should warm
 * for a sanitized HTML string — exactly one per image, matching what the reader
 * renders. Covers `src`, `poster` (video), and `srcset` (img/source).
 *
 * Extraction runs over the **collapsed** HTML (`collapseProxiedSrcset`), the
 * same transform the reader applies before injecting. That means a stale
 * `<img src=small srcset=…>` contributes only the selected ~1600px candidate —
 * not also its fallback `src`, which the browser never requests — so a
 * responsive image is one fetch + one cache entry, and the warmed URL is always
 * the one the rendered `<img>` actually loads. Used by `useOfflineCacheLock` to
 * fire background fetches so the service worker caches images for offline reading.
 */
export function extractProxiedImageUrls(html: string): string[] {
  // Collapse first so img fallback `src` + srcset can't warm two URLs for one
  // image; after collapse a proxied srcset survives only on <source>.
  const collapsed = collapseProxiedSrcset(html);
  const urls = new Set<string>();

  // src and poster single-URL attributes.
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(collapsed)) !== null) {
    urls.add(m[1]);
  }

  // <source> srcset survives collapse as a single candidate; resolve it.
  SRCSET_ATTR_RE.lastIndex = 0;
  while ((m = SRCSET_ATTR_RE.exec(collapsed)) !== null) {
    const chosen = pickProxiedSrcsetCandidate(m[1]);
    if (chosen) urls.add(chosen);
  }

  return [...urls];
}
