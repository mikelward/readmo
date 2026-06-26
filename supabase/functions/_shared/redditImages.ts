// Readmo Reddit thumbnail → full-image upgrade.
//
// Reddit's RSS/Atom feed embeds a small, server-cropped *thumbnail* as the item
// body's <img> (a ~140px b.thumbs.redditmedia.com tile, or a cropped
// preview.redd.it variant), while the full, uncropped image is only linked
// separately as the "[link]" anchor that points at i.redd.it/<id>.<ext>.
// Rendered full-bleed in the reader, that thumbnail shows a crop of the picture
// with its top (and sides) cut off — the source of the "image is truncated at
// the top" report. This pre-pass rewrites the thumbnail's src to the full image
// so the reader shows the whole picture.
//
// It runs *before* sanitizeContent(): the swapped-in i.redd.it URL then flows
// through the normal <img> transform (absolutize + route through /api/img), so
// the stored body is still fully sanitized and proxied. Never store/serve raw
// publisher HTML — guardrail #6.
//
// Deliberately conservative — a no-op for every non-Reddit feed and for Reddit
// gallery posts ("[link]" → /gallery/…), external-link posts, and self posts.
// It only fires on the recognizable image-post shape: a "[link]" anchor whose
// href is a direct image URL, plus exactly one <img> served from a known Reddit
// thumbnail/preview host.
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

/**
 * Rewrite a Reddit feed body's cropped thumbnail <img> to the full uncropped
 * image linked as "[link]". Returns `html` unchanged for non-Reddit content,
 * gallery/external/self posts, or anything that doesn't match the exact
 * one-thumbnail-plus-image-"[link]" shape.
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

  // The "[link]" anchor points at the submission target. Only upgrade when it
  // is itself a direct image (an image post) — galleries and external links are
  // left alone.
  const linkAnchor = [...doc.querySelectorAll('a')].find(
    (a) => (a.textContent ?? '').trim().toLowerCase() === '[link]',
  );
  const fullUrl = linkAnchor?.getAttribute('href') ?? '';
  if (!isDirectImageUrl(fullUrl)) return html;

  // Exactly one Reddit thumbnail in the body — the post's preview tile. Bail on
  // zero or several (an unexpected shape we won't second-guess).
  const thumbs = [...doc.querySelectorAll('img')].filter((im) =>
    isRedditThumbnailSrc(im.getAttribute('src')),
  );
  if (thumbs.length !== 1) return html;

  const img = thumbs[0];
  img.setAttribute('src', fullUrl);
  // The thumbnail's srcset and intrinsic width/height describe the cropped
  // tile, not the full image — drop them so the browser uses the real picture's
  // dimensions and the reader's full-bleed CSS isn't fed a 140×140 square.
  img.removeAttribute('srcset');
  img.removeAttribute('width');
  img.removeAttribute('height');

  return doc.body?.innerHTML ?? html;
}
