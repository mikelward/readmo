// Derived, list-only presentation for the larger Article-layout card variants
// (Settings → Appearance → Article layout). Pure helpers so the row stays a thin
// renderer and the logic is unit-testable:
//
//  - leadImageUrl(item)   — a thumbnail URL for the "Title + thumbnail" layout.
//  - itemPreviewText(item) — a plain-text preview for the "Title + excerpt" layout.
//
// Both source from data the client already has (`contentHtml`, `enclosures`), so
// the larger layouts ship with no backend change and work against the currently
// deployed backend (guardrail #11).

import type { Item } from './types';
import { isSafeHttpUrl } from './itemMeta';
import { extractProxiedImageUrls } from './extractProxiedImageUrls';

/** Wrap a publisher image URL in our first-party image proxy — mirrors the
 * server sanitizer's `proxyImageUrl` (`supabase/functions/_shared/sanitize.ts`).
 * The proxy is the SSRF-hardened, privacy-preserving fetch path (guardrail #6),
 * so an enclosure URL is never loaded directly. `/api/img` is a Vercel function
 * that ships with the frontend, so it's always available to the newest client. */
function proxyImageUrl(url: string): string {
  return `/api/img?url=${encodeURIComponent(url)}`;
}

/**
 * A thumbnail URL for an item, or `null` when the item has no usable image (the
 * row then collapses to the title-only look — the graceful-empty path).
 *
 * Sourcing, in order:
 *  1. The first image already embedded in the sanitized `contentHtml`. These are
 *     rewritten to our `/api/img` proxy server-side and responsive `srcset`s are
 *     collapsed to one candidate, so we reuse `extractProxiedImageUrls` — the
 *     same vetted extractor the offline prefetch uses.
 *  2. Failing that, the first raw `http(s)` `<img>` in the body, routed through
 *     the proxy ourselves. Prod content is already proxied (tier 1 wins), so
 *     this is defense-in-depth for any not-yet-proxied body.
 *  3. Failing that, the first `image/*` enclosure (media RSS / podcast art),
 *     routed through the proxy like any other publisher image.
 *
 * Content images win because they're the ones the reader itself renders; the
 * enclosure is the fallback for feeds that carry the lead image only as an
 * attachment. Every non-proxied URL goes through `/api/img`, never a direct
 * publisher fetch (guardrail #6).
 */
export function leadImageUrl(item: Item): string | null {
  const fromProxiedContent = extractProxiedImageUrls(item.contentHtml)[0];
  if (fromProxiedContent) return fromProxiedContent;

  // The captured src is an HTML attribute value, so it's entity-encoded — the
  // sanitizer serializes & as &amp; — and must be decoded before use, or a
  // multi-param URL (?w=800&amp;h=600) reaches the proxy with literal "amp;h"
  // params and the upstream fetch 404s/403s (broken thumbnail).
  const rawContentImg = FIRST_RAW_IMG_SRC_RE.exec(item.contentHtml)?.[1];
  if (rawContentImg) {
    const decoded = decodeEntities(rawContentImg);
    if (isSafeHttpUrl(decoded)) return proxyImageUrl(decoded);
  }

  const imageEnclosure = item.enclosures.find(
    (enc) =>
      enc.type?.toLowerCase().startsWith('image/') && isSafeHttpUrl(enc.url),
  );
  if (imageEnclosure) return proxyImageUrl(imageEnclosure.url);

  return null;
}

// First `<img>` whose src is an absolute http(s) URL (not already a proxied
// `/api/img` one — those are handled above). Body HTML is sanitized server-side
// (well-formed, double-quoted attrs), so a simple attribute match is safe.
const FIRST_RAW_IMG_SRC_RE = /<img\b[^>]*\ssrc="(https?:\/\/[^"]+)"/i;

// Named HTML entities common in feed bodies. Numeric (`&#39;`, `&#x2019;`) are
// handled separately below.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * A plain-text preview of the item's own feed content — the RSS body with tags
 * stripped, entities decoded, and whitespace collapsed. Returns `''` when the
 * body is empty (the excerpt line then simply doesn't render).
 *
 * This is the *feed's* content, deliberately not the AI `summary` — the "Title +
 * excerpt" layout previews what the publisher wrote, and works for every item
 * regardless of allowlist/summary availability. Visual truncation to three lines
 * is done in CSS (`-webkit-line-clamp`), so the full text is returned here.
 */
export function itemPreviewText(item: Item): string {
  const withoutTags = item.contentHtml
    // Drop script/style wholesale (the body is sanitized, so this is defensive).
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags)
    .replace(/\s+/g, ' ')
    // Inline tags become spaces, which can leave a space before punctuation
    // ("Second <em>para</em>." → "…para ."). Reattach the punctuation.
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}
