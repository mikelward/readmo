// Readmo image proxy — Edge Function (skeleton).
//
// GET /functions/v1/img?url=<encoded>
// Stored content_html has its <img src> rewritten to point here so the
// publisher sees only the proxy's IP, not the reader's — and so images work
// offline and third-party tracking pixels are stripped. The proxy fetches the
// upstream image through the SSRF-hardened helper, caches, and serves the
// bytes. SPEC.md "Privacy" (server-side image proxy).
//
// Thin entrypoint; SSRF + caps live in _shared.safeFetch (tested). Deno
// resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { safeFetch, SsrfError } from '../_shared/ssrf.ts';

// Only proxy real image bytes — never let the endpoint relay arbitrary content
// types (it would otherwise become an open SSRF/exfil relay).
const ALLOWED_PREFIX = 'image/';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// SVG is an image type but also an active document: `image/svg+xml` can carry
// inline <script>, so serving it (even via the same-origin /api/img shim) is a
// same-origin XSS vector if opened as a top-level document. Refuse it here at
// the source; the shim enforces the same rule as defense in depth.
function isServeableImageType(contentType: string): boolean {
  const type = contentType.toLowerCase().trim();
  return type.startsWith(ALLOWED_PREFIX) && !type.startsWith('image/svg');
}

Deno.serve(async (req: Request) => {
  const target = new URL(req.url).searchParams.get('url');
  if (!target) return new Response('Missing url', { status: 400 });

  try {
    const res = await safeFetch(target, {
      timeoutMs: 10_000,
      maxBytes: MAX_IMAGE_BYTES,
      headers: { Accept: 'image/*', 'User-Agent': 'Readmo/1.0 (+https://readmo.app)' },
    });
    if (res.status >= 400) return new Response('Upstream error', { status: 502 });

    const contentType = res.headers.get('content-type') ?? '';
    if (!isServeableImageType(contentType)) {
      // Refuse non-image responses (and SVG) — strips beacons, blocks content
      // smuggling, and closes the same-origin SVG-script XSS vector.
      return new Response('Not an image', { status: 415 });
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': contentType,
        // Long, immutable cache — the SW also caches this (vite.config.ts
        // StaleWhileRevalidate / CacheFirst).
        'cache-control': 'public, max-age=604800, immutable',
        // Defense in depth: stop MIME sniffing and neutralize scripts if the
        // bytes are ever loaded as a top-level document instead of via <img>.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      console.warn('img: blocked by SSRF guard:', err.message, '(', target, ')');
      return new Response('Blocked', { status: 400 });
    }
    console.error('img: proxy error for', target, ':', err);
    return new Response('Proxy error', { status: 502 });
  }
});
