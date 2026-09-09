// Cloudflare Worker — readmo's API gateway in front of Supabase.
//
// WHY THIS EXISTS
// Hosted Supabase exposes no per-request rate limit on the REST/RPC path, so a
// client stuck in a refetch loop can hammer `feed_items` unbounded (see the
// June incident: 116M `set_config` calls = 116M API requests). This Worker puts
// a gateway we control in front of Supabase so a Cloudflare Rate Limiting Rule
// can reject the storm *before* it reaches Postgres.
//
// WHY A WORKER (and not Supabase's $10 custom-domain add-on): the client points
// VITE_SUPABASE_URL at api.readmo.app; this Worker rewrites each request to the
// real <ref>.supabase.co origin via fetch(). Supabase therefore never needs to
// know about our domain — the add-on is only required for the "Cloudflare
// proxies straight to Supabase's origin" path, which we sidestep.
//
// WHAT IT DOES: CORS (preflight + response headers), an optional client-version
// gate (off by default), and a transparent proxy to Supabase. The actual rate
// limiting is a free Cloudflare WAF Rate Limiting Rule on the route, which runs
// *before* the Worker in Cloudflare's pipeline — so blocked storm traffic never
// even invokes this Worker (no quota burned). See README.md.
//
// Config comes from wrangler.toml [vars]: SUPABASE_ORIGIN, APP_ORIGINS
// (comma-separated), MIN_CLIENT_BUILD ('0' = version gate disarmed).
//
// The app uses no Supabase Realtime/WebSockets, so this is plain HTTP proxying
// with no upgrade handling. If Realtime is ever added, this Worker needs
// explicit WebSocket-upgrade support.

/**
 * Choose the `Access-Control-Allow-Origin` value: echo the caller's Origin when
 * it's on the allow-list (so credentialed/cross-origin calls work), else fall
 * back to the first configured origin. Never returns '*', so it stays valid even
 * if credentials are later added.
 */
export function pickAllowOrigin(origin, allowed) {
  return allowed.includes(origin) ? origin : (allowed[0] ?? '');
}

/**
 * Client-version gate. floor <= 0 (the default) allows everything, including
 * header-less callers, so arming it is deliberate. Once armed, a build below the
 * floor — or a missing/garbage header (a build predating the stamp) — is
 * rejected with 426. Mirrors supabase/functions/_shared/clientVersion.ts.
 */
export function checkClientBuild(header, floor) {
  if (!Number.isFinite(floor) || floor <= 0) return { allowed: true };
  const trimmed = (header ?? '').trim();
  const build = trimmed === '' ? NaN : Number(trimmed);
  if (!Number.isInteger(build) || build < floor) return { allowed: false, floor };
  return { allowed: true };
}

/**
 * Whether the client-version gate applies to a path. Only the *stamped* data
 * paths (REST/RPC + edge functions) — a signed-out user's OAuth sign-in is a
 * browser navigation to `/auth/v1/authorize` that can't carry the
 * `x-readmo-build` header, so gating auth (or storage) navigations would 426 a
 * legitimate user on the current build. Auth/storage are never gated here.
 */
export function isGatedPath(pathname) {
  return pathname.startsWith('/rest/') || pathname.startsWith('/functions/');
}

export default {
  async fetch(req, env) {
    const allowed = (env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowOrigin = pickAllowOrigin(req.headers.get('Origin') ?? '', allowed);

    // CORS preflight: echo back exactly the headers the client asked for, so we
    // never miss one of supabase-js's custom headers (apikey, prefer,
    // accept-profile, x-readmo-build, …).
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') ?? '',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin, Access-Control-Request-Headers',
        },
      });
    }

    const url = new URL(req.url);

    // Optional version gate (disarmed unless MIN_CLIENT_BUILD > 0), scoped to
    // the stamped data paths so it never blocks an OAuth navigation (see
    // isGatedPath).
    if (isGatedPath(url.pathname)) {
      const gate = checkClientBuild(req.headers.get('x-readmo-build'), Number(env.MIN_CLIENT_BUILD ?? '0'));
      if (!gate.allowed) {
        return new Response(JSON.stringify({ error: 'client too old, please update', minBuild: gate.floor }), {
          status: 426,
          headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': allowOrigin, 'Vary': 'Origin' },
        });
      }
    }

    // Proxy to Supabase: same path + query, forward method/headers/body. Drop
    // Host so fetch sets it from the target URL (else Supabase sees
    // api.readmo.app and can't route). redirect:'manual' so auth 3xx flows pass
    // through to the browser untouched.
    const headers = new Headers(req.headers);
    headers.delete('Host');
    const init = { method: req.method, headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body;
      init.duplex = 'half'; // required when streaming a request body
    }
    const upstream = await fetch(env.SUPABASE_ORIGIN + url.pathname + url.search, init);

    // Pass the response through, adding CORS. Expose Content-Range — PostgREST
    // returns the row range / exact count there, and the client's pagination
    // ("More") reads it; without exposing it cross-origin, paging breaks.
    const out = new Headers(upstream.headers);
    out.set('Access-Control-Allow-Origin', allowOrigin);
    out.append('Vary', 'Origin');
    out.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
