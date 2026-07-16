// Readmo Reddit thumbnail → full-image upgrade.
//
// Reddit's RSS/Atom feed embeds a small, server-cropped *thumbnail* as the item
// body's <img> (a ~140px b.thumbs.redditmedia.com tile, or a downscaled
// preview.redd.it variant), while the full, uncropped image is served
// elsewhere. Rendered full-bleed in the reader, the b.thumbs tile shows a crop
// with its top (and sides) cut off (the "image is truncated at the top"
// report), and the downscaled preview.redd.it variant renders soft/blurry (the
// "image is blurry" report). This pre-pass rewrites the thumbnail's src to the
// full image so the reader shows the whole picture at full resolution.
//
// Two ways to recover the original:
//   1. The post's "[link]" anchor points at the submission target. For a single-
//      image post that target *is* the full image (i.redd.it/<id>.<ext> or an
//      external direct image), so we swap it in.
//   2. For a *gallery* ("[link]" → reddit.com/gallery/…), where the body
//      carries one downscaled preview.redd.it cover, we derive the original
//      from the thumbnail itself: an internal preview.redd.it URL shares its
//      media id with the full i.redd.it upload (preview.redd.it/<id>.<ext> ↔
//      i.redd.it/<id>.<ext>), and the query string's `width`/`crop` is the only
//      thing shrinking it, so dropping the host+query recovers full resolution.
//      Its signed `s=` param can't be re-widened anyway, so the host swap is the
//      only route. This mapping is only reliable for Reddit-hosted image/gallery
//      uploads, so it is gated on the gallery "[link]" shape — a video post's
//      preview.redd.it poster or a self/external post's preview may have no
//      matching i.redd.it asset, and those are left untouched (as before).
//
// It runs *before* sanitizeContent(): the swapped-in i.redd.it URL then flows
// through the normal <img> transform (absolutize + route through /api/img), so
// the stored body is still fully sanitized and proxied. Never store/serve raw
// publisher HTML — guardrail #6.
//
// Deliberately conservative — a no-op for every non-Reddit feed, for external-
// link, self, and video posts, and for external-preview.redd.it thumbnails
// (whose original lives off-site, not on i.redd.it). It only fires on the
// recognizable image/gallery-post shape: exactly one <img> from a known Reddit
// thumbnail host where either "[link]" is a direct image or "[link]" is a
// reddit.com/gallery/… URL and the thumbnail is an internal preview.redd.it URL.
//
// linkedom (already used by fulltext.ts) parses the snippet; the bare specifier
// is rewritten for Deno via supabase/functions/import_map.json.

import { parseHTML } from 'linkedom';

// Hosts that serve Reddit's cropped preview/thumbnail variant — the image we
// replace. NOT i.redd.it, which is the full original we swap *in*.
const REDDIT_PREVIEW_HOSTS = new Set(['preview.redd.it', 'external-preview.redd.it']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for a Reddit-served thumbnail/preview image src:
 * `*.thumbs.redditmedia.com` (a./b. tiles) or the preview hosts. */
function isRedditThumbnailSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  const host = hostOf(src);
  if (!host) return false;
  return host.endsWith('.thumbs.redditmedia.com') || REDDIT_PREVIEW_HOSTS.has(host);
}

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?)$/;

/** True when a URL resolves directly to image bytes — Reddit's own image CDN
 * (i.redd.it, which serves the full uncropped upload) or any http(s) URL whose
 * path ends in a known image extension. */
function isDirectImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname.toLowerCase() === 'i.redd.it') return true;
  return IMAGE_EXT_RE.test(u.pathname.toLowerCase());
}

/** True for a Reddit gallery submission target, `reddit.com/gallery/<id>` (the
 * "[link]" href of a gallery post). Gates the preview→i.redd.it derivation to
 * the one non-direct-"[link]" shape where that media-id mapping is reliable. */
function isRedditGalleryUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const isReddit = host === 'reddit.com' || host.endsWith('.reddit.com');
  return isReddit && u.pathname.toLowerCase().startsWith('/gallery/');
}

/** Map an internal Reddit preview URL to its full-resolution i.redd.it
 * original. `preview.redd.it/<id>.<ext>?width=…&crop=…&s=<sig>` and
 * `i.redd.it/<id>.<ext>` share the media id + extension; only the query string
 * (the downscale + signature) differs, so dropping the host+query yields the
 * uncropped upload. Returns null for any other host — notably
 * external-preview.redd.it, whose original is off-site, not on i.redd.it. */
function fullImageFromPreview(src: string | null | undefined): string | null {
  if (!src) return null;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== 'preview.redd.it') return null;
  // pathname is `/<id>.<ext>`; i.redd.it serves the identical path, no query.
  return `https://i.redd.it${u.pathname}`;
}

/**
 * Rewrite a Reddit feed body's cropped/downscaled thumbnail <img> to the full
 * uncropped, full-resolution image — the one linked as "[link]" (image posts)
 * or the i.redd.it original derived from a preview.redd.it cover (galleries).
 * Returns `html` unchanged for non-Reddit content, external/self posts, and
 * anything that doesn't match the exact one-thumbnail shape.
 */
export function upgradeRedditThumbnails(html: string | null | undefined): string {
  if (!html) return html ?? '';
  // Fast bail: every Reddit item body carries a literal "[link]" anchor and
  // almost nothing else does, so skip the DOM parse for the common case. Case-
  // insensitive to stay consistent with the anchor match below.
  if (!/\[link\]/i.test(html)) return html;

  let doc: Document;
  try {
    ({ document: doc } = parseHTML(
      `<!doctype html><html><body>${html}</body></html>`,
    ) as unknown as { document: Document });
  } catch {
    return html;
  }

  // Exactly one Reddit thumbnail in the body — the post's preview tile. Bail on
  // zero or several (an unexpected shape we won't second-guess).
  const thumbs = [...doc.querySelectorAll('img')].filter((im) =>
    isRedditThumbnailSrc(im.getAttribute('src')),
  );
  if (thumbs.length !== 1) return html;
  const img = thumbs[0];

  // The "[link]" anchor points at the submission target. For a single-image
  // post that target is itself the full image, so prefer it. For a gallery
  // ("[link]" → reddit.com/gallery/…) — where "[link]" names no direct image —
  // fall back to deriving the i.redd.it original from the preview.redd.it cover.
  // Only galleries get the fallback: the media-id mapping is unreliable for
  // video posters and external/self previews, so those are left unchanged. Bail
  // if neither route yields a full image.
  const linkAnchor = [...doc.querySelectorAll('a')].find(
    (a) => (a.textContent ?? '').trim().toLowerCase() === '[link]',
  );
  const linkHref = linkAnchor?.getAttribute('href') ?? '';
  const fullUrl = isDirectImageUrl(linkHref)
    ? linkHref
    : isRedditGalleryUrl(linkHref)
      ? fullImageFromPreview(img.getAttribute('src'))
      : null;
  if (!fullUrl) return html;

  img.setAttribute('src', fullUrl);
  // The thumbnail's srcset and intrinsic width/height describe the cropped
  // tile, not the full image — drop them so the browser uses the real picture's
  // dimensions and the reader's full-bleed CSS isn't fed a 140×140 square.
  img.removeAttribute('srcset');
  img.removeAttribute('width');
  img.removeAttribute('height');

  return doc.body?.innerHTML ?? html;
}
