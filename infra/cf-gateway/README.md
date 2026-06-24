# readmo API gateway (Cloudflare Worker)

A thin Cloudflare Worker that fronts Supabase so a **free Cloudflare Rate
Limiting Rule** can shed a request storm (e.g. a client stuck in a refetch loop)
**before it reaches Postgres** — the gap hosted Supabase can't close itself (no
per-request rate limit on the REST/RPC path).

```
client → https://api.readmo.app   (Cloudflare WAF rate-limit → this Worker)   →  https://<ref>.supabase.co
```

The client points `VITE_SUPABASE_URL` at `api.readmo.app`; the Worker rewrites
each request to the real Supabase origin. **No Supabase custom-domain add-on
($10/mo) is needed** — that's only for proxying straight to Supabase's origin,
which the Worker sidesteps.

## Cost

Likely **$0**. Worker invocations happen only for *allowed* traffic (your normal
load); a storm is blocked at the WAF layer, which runs *before* Workers, so it
never invokes the Worker. Under 100k req/day = Workers free tier. Above that,
Workers Paid is $5/mo with **10M requests/month included** (~333k/day), then
~$0.30 per additional million. The WAF Rate Limiting Rule that does the
protecting is free — coarser on the Free plan (10 s window, path-only match; see
step 4), which is enough to shed a loop.

## One-time setup

1. **Set the config vars** (kept out of git — they're project-specific, though
   not secret). For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`
   (gitignored) and fill it in. For the deployed Worker, set `SUPABASE_ORIGIN`,
   `APP_ORIGINS`, and `MIN_CLIENT_BUILD` as plaintext **Variables** in the
   dashboard (Worker → Settings → Variables) — or uncomment the `[vars]` block in
   a *local* `wrangler.toml` and don't commit the real values. (No real secrets
   go here; the Worker doesn't use the service_role key or JWT secret.)
2. **Deploy the Worker:** from this directory, `npx wrangler deploy`
   (after `wrangler login`).
3. **Bind the hostname:** add `api.readmo.app` as a Worker **Custom Domain**
   (Workers & Pages → your Worker → Settings → Domains & Routes). This provisions
   DNS + TLS. (Alternatively uncomment the `routes` block in `wrangler.toml`.)
4. **Add the rate-limit rule** (the actual protection) — Security → WAF → Rate
   limiting rules → Create. **Free-plan compatible version:**
   - **If** `http.request.uri.path` contains `/rest/v1/` (path is a Free-tier
     expression field; start here, add `/functions/v1/` later).
   - **Rate:** > N requests per **10 s** (Free's only counting period), keyed by
     client IP (Free's default characteristic). Pick N well above a real user's
     10 s burst, well below a loop's.
   - **Action: Block** (returns 429). **Not** "Managed Challenge" — no CAPTCHA.
   - Free can't match on `http.request.method`, so it can't exempt `OPTIONS` —
     but that's fine here: CORS preflights are cached 24 h (the Worker's
     `Access-Control-Max-Age`) and a refetch loop sends GETs, not preflights, so
     OPTIONS volume never trips a sane threshold.

   **Paid WAF** unlocks a longer window (e.g. 1 min), matching on
   `http.request.method` (to exempt `OPTIONS` explicitly) and other fields, and
   custom characteristics (e.g. key by the `Authorization` header for
   per-session limiting). Check Cloudflare's *Rate limiting rules → Availability*
   table for exactly which fields/periods your plan exposes.
5. **Point the *client* at it:** set `VITE_SUPABASE_URL=https://api.readmo.app`
   in Vercel and redeploy. **Test on a preview deployment first** (see below) — a
   CORS gap would break the live app.
   - **Keep `SUPABASE_URL` (the server-side var) the direct
     `https://<ref>.supabase.co` origin — do not move it to the gateway.** The
     Vercel image shim (`api/img.ts`) builds `…/functions/v1/img` from
     `SUPABASE_URL ?? VITE_SUPABASE_URL`, and that server-side fetch can't carry
     `x-readmo-build`; routed through the gateway it would be 426'd the moment the
     version gate is armed, breaking article images. Trusted server-side calls
     should bypass the gateway anyway, so set `SUPABASE_URL` explicitly to the
     direct origin (don't let it fall back to `VITE_SUPABASE_URL`).

## Test before flipping production

Point a Vercel **preview** at the gateway and exercise sign-in, the feed, "More"
pagination (this checks `Content-Range` is exposed), pinning/marking done, and
add-feed. Or by hand:

```
# Preflight should echo the requested headers:
curl -i -X OPTIONS https://api.readmo.app/rest/v1/ \
  -H 'Origin: https://readmo.app' \
  -H 'Access-Control-Request-Headers: apikey, authorization, x-readmo-build'

# A normal read should pass through (401/empty is fine — proves routing + CORS):
curl -i https://api.readmo.app/rest/v1/ -H 'Origin: https://readmo.app'
```

## Rollback

Set `VITE_SUPABASE_URL` back to `https://<ref>.supabase.co` and redeploy — the
app talks to Supabase directly again, gateway bypassed. Or set the WAF rule to
**Log** instead of Block to disable enforcement without touching the app.

## Notes & gotchas

- **Per-IP keying** is blunt on NAT (shared IPs) but free and fine to start.
  Per-user keying would need the Worker to decode the JWT `sub` — a later step.
- **Version gate:** applies only to the stamped data paths (`/rest/`,
  `/functions/`), never to `/auth/` or `/storage/` — an OAuth sign-in is a
  browser navigation that can't carry the header, so gating it would 426 a
  signed-out user on the current build. Leave `MIN_CLIENT_BUILD = "0"` until the
  `x-readmo-build`-stamping client has propagated, or you'll 426 users on the
  header-less build. Raise it past a known-bad build during an incident, then
  `wrangler deploy`.
- **Auth redirect URLs** are unaffected — Supabase Auth's Site URL / redirect
  allow-list point at the app (`readmo.app`), not the API host.
- **No Realtime:** the app uses only REST/RPC + auth + edge functions, so this
  Worker does plain HTTP proxying. If Supabase Realtime is ever added, the
  Worker needs explicit WebSocket-upgrade handling.
- The anon key is public, so the Worker holds no secret — it's a dumb forwarder.

`worker.test.js` covers the pure logic (CORS origin selection, version gate);
the proxy/CORS wiring is verified by the preview/curl checks above.
