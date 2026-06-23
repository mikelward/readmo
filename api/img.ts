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

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
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
    return new Response('Image proxy not configured', { status: 503 });
  }

  const target = new URL(req.url).searchParams.get('url');
  const upstream = buildUpstreamUrl(base, target);
  if (!upstream) return new Response('Missing url', { status: 400 });

  let res: Response;
  try {
    res = await fetch(upstream, { headers: { Accept: 'image/*' } });
  } catch {
    return new Response('Proxy error', { status: 502 });
  }

  // Pass through the status and image bytes, preserving content-type and the
  // long immutable cache-control the `img` function already sets.
  const headers = new Headers();
  const contentType = res.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const cacheControl = res.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);

  return new Response(res.body, { status: res.status, headers });
}
