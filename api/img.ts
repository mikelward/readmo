// Readmo same-origin image-proxy shim (Vercel Edge Function).
//
// The server-side sanitizer rewrites every publisher `<img src>` to the
// same-origin path `/api/img?url=…` (see supabase/functions/_shared/sanitize.ts
// `proxify`). That keeps article images same-origin so (a) the publisher only
// ever sees the proxy's IP, not the reader's, (b) tracking pixels are stripped,
// and (c) the service worker can cache the bytes for offline reading (the
// Workbox runtime rule in vite.config.ts matches `/api/img`).
//
// The actual fetch lives in the Supabase Edge Function `img`
// (supabase/functions/img/index.ts): it runs the user-supplied URL through the
// SSRF-hardened `safeFetch`, enforces `image/*`, and caps the body size. This
// shim only forwards `/api/img` to `…/functions/v1/img` so the browser talks to
// our own origin and never to Supabase directly.
//
// SSRF (guardrail #6): this shim NEVER fetches the user-supplied `url`. It only
// ever fetches our own, fixed Supabase functions origin (from `SUPABASE_URL`)
// and passes `url` straight through as a query param; the SSRF-hardened
// `safeFetch` inside the `img` function is what validates the resolved IP.

export const config = { runtime: 'edge' };

/**
 * Whether a response content-type is an image we will serve same-origin.
 *
 * SVG is deliberately excluded: `image/svg+xml` can carry inline `<script>`
 * that executes if `/api/img?url=…evil.svg` is opened as a top-level document
 * on the Readmo origin — a same-origin XSS with access to our IndexedDB caches
 * and Supabase session. The upstream `img` function blocks SVG too; this is the
 * app-origin enforcement point, so it must not depend on that alone.
 */
export function isServeableImageType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase().trim();
  return type.startsWith('image/') && !type.startsWith('image/svg');
}

/**
 * Build the upstream Supabase image-proxy URL from the configured base and the
 * caller-supplied target. Returns null when there is no target to proxy.
 * Pure + exported so the routing is unit-tested without a live deployment.
 */
export function buildUpstreamUrl(
  base: string,
  target: string | null,
): string | null {
  if (!target) return null;
  // Trim any trailing slashes off SUPABASE_URL so we don't emit a double slash.
  const root = base.replace(/\/+$/, '');
  return `${root}/functions/v1/img?url=${encodeURIComponent(target)}`;
}

/**
 * Build the auth headers required by the Supabase edge-function gateway.
 * Every edge function requires either `Authorization: Bearer <anon_key>` or
 * the equivalent `apikey` header — without it the gateway returns 401 and the
 * browser gets no image bytes. Returns an empty object when the key is absent
 * so callers can spread safely; the upstream will 401 in that case.
 */
export function buildAnonHeaders(
  anonKey: string | undefined,
): Record<string, string> {
  if (!anonKey) return {};
  return {
    Authorization: `Bearer ${anonKey}`,
    apikey: anonKey,
  };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return uncacheableError('Method not allowed', 405);
  }

  // SUPABASE_URL is the canonical name. Also accept VITE_SUPABASE_URL and
  // NEXT_PUBLIC_SUPABASE_URL so this matches the env the rest of the app reads
  // (src/lib/supabase/client.ts falls back the same way) — deployments wired
  // through the Supabase↔Vercel integration may only set the prefixed name.
  const base =
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    return uncacheableError('Image proxy not configured', 503);
  }

  // Supabase edge-function gateway requires the anon key on every request.
  // Mirrors the fallback chain in src/lib/supabase/client.ts.
  const anonKey =
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  const target = new URL(req.url).searchParams.get('url');
  const upstream = buildUpstreamUrl(base, target);
  if (!upstream) return uncacheableError('Missing url', 400);

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { Accept: 'image/*', ...buildAnonHeaders(anonKey) },
    });
  } catch {
    return uncacheableError('Proxy error', 502);
  }

  const contentType = res.headers.get('content-type');

  // Defense in depth: never serve SVG (or any non-image) as same-origin bytes.
  // Only gate successful responses so the upstream's own 4xx/5xx pass through
  // with their original status instead of being masked as 415.
  if (res.ok && !isServeableImageType(contentType)) {
    return uncacheableError('Unsupported image type', 415);
  }

  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  if (res.ok) {
    // Success: carry the long immutable cache-control the `img` function sets so
    // a shared cache (Cloudflare in front of /api/img) and the SW can keep the
    // bytes. This is the ONLY path that should be cacheable.
    const cacheControl = res.headers.get('cache-control');
    if (cacheControl) headers.set('cache-control', cacheControl);
  } else {
    // Upstream error passed through with its original status — never let a
    // shared cache store it. A transient publisher 5xx or a hotlink 403 must not
    // get frozen at the edge for the image's week-long TTL.
    headers.set('cache-control', 'no-store');
  }
  // Stop MIME sniffing and neutralize any script execution if this response is
  // ever loaded as a top-level document rather than via <img>.
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; sandbox");

  return new Response(res.body, { status: res.status, headers });
}

/**
 * Build a non-cacheable error response. `Cache-Control: no-store` keeps any
 * shared cache in front of `/api/img` (Cloudflare, once it fronts the app for
 * rate limiting) from caching a failure: under a "cache everything" rule a
 * transient hotlink 403 or publisher 5xx would otherwise stick for the long
 * image TTL and stay broken even after the upstream recovers. Only the 200
 * image-bytes path is cacheable.
 */
export function uncacheableError(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}
