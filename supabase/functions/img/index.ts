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
    if (!contentType.startsWith(ALLOWED_PREFIX)) {
      // Refuse non-image responses — strips beacons and blocks content
      // smuggling through the proxy.
      return new Response('Not an image', { status: 415 });
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': contentType,
        // Long, immutable cache — the SW also caches this (vite.config.ts
        // StaleWhileRevalidate / CacheFirst).
        'cache-control': 'public, max-age=604800, immutable',
      },
    });
  } catch (err) {
    if (err instanceof SsrfError) return new Response('Blocked', { status: 400 });
    return new Response('Proxy error', { status: 502 });
  }
});
