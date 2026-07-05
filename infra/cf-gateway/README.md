# readmo API gateway (Cloudflare Worker)

A thin Cloudflare Worker that fronts Supabase so a **free Cloudflare Rate
Limiting Rule** can shed a request storm (e.g. a client stuck in a refetch loop)
**before it reaches Postgres** — the gap hosted Supabase can't close itself (no
per-request rate limit on the REST/RPC path).

```
client → https://api.readmo.app   (Cloudflare WAF rate-limit → this Worker)   →  https://<ref>.supabase.co
             /rest/v1/…  (PostgREST reads/writes + RPC)
             /functions/v1/…  (Edge Functions: discover, refresh, summary, fulltext, newshacker-sync)
             /auth/v1/… /storage/v1/…  (proxied, but never rate-limited or version-gated)
```

The client points `VITE_SUPABASE_URL` at `api.readmo.app`; the Worker rewrites
each request to the real Supabase origin. This is path-agnostic, so it fronts
**both** the REST/RPC API (`/rest/v1/`) **and the browser-invoked Edge
Functions** (`/functions/v1/`) — supabase-js's `functions.invoke()` builds its
URL off the same base, so the moment the client points at the gateway, function
calls route through it too, with the same CORS and version-gate handling. **No
Supabase custom-domain add-on ($10/mo) is needed** — that's only for proxying
straight to Supabase's origin, which the Worker sidesteps.

### What reaches the gateway (and what bypasses it)

Only **browser-originated** traffic hits `api.readmo.app`. Server-to-server
calls keep talking to Supabase directly and are unaffected by anything here —
which is intended, since they're trusted and can't carry `x-readmo-build`:

| Edge Function | Reaches the gateway? | Why |
|---|---|---|
| `discover`, `refresh`, `summary`, `fulltext`, `newshacker-sync` | **Yes** — `/functions/v1/<fn>` | Browser-invoked via supabase-js `functions.invoke()`; CORS-enabled. |
| `poll` | No | Invoked by `pg_cron` inside Postgres — never leaves the DB. |
| `notify-signup` | No | Fired by the `auth.users` insert trigger via `pg_net` — server-side. |
| `db-perf` | No | Called out-of-band (runbook / Grafana → Supabase directly) with the `service_role` **Bearer** token (`Authorization: Bearer $SERVICE_ROLE_KEY`). |
| `img` | No | Browser `<img>` → Vercel `/api/img` shim → server-side fetch to `SUPABASE_URL` (kept **direct**, see step 5). Images are cached separately (SETUP §6), so the functions rate-limit never throttles them. |

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
4. **Add the rate-limit rule(s)** (the actual protection) — Security → WAF →
   Rate limiting rules → Create. **Free-plan compatible version:**
   - **REST/RPC rule — `http.request.uri.path` contains `/rest/v1/`.** This is
     the proven incident vector (the June refetch loop was 116M `set_config`
     calls, all REST). Path is a Free-tier expression field.
   - **Edge-functions rule — `http.request.uri.path` contains
     `/functions/v1/`.** A second rule (same builder) covers the function path.
     Give it a **lower** threshold than REST: a session makes far fewer function
     calls (a handful of `summary`/`fulltext`/`discover`/`refresh` requests) than
     PostgREST reads, and `summary`/`fulltext` are seconds-long AI calls you
     never want a client hammering. `img` doesn't count here — it bypasses the
     gateway (see the table above), so this rule won't throttle images.
   - **Rate:** > N requests per **10 s** (Free's only counting period), keyed by
     client IP (Free's default characteristic). Pick N well above a real user's
     10 s burst, well below a loop's — tuned per rule (REST higher, functions
     lower).
   - **Action: Block** (returns 429). **Not** "Managed Challenge" — no CAPTCHA.
   - Free can't match on `http.request.method`, so it can't exempt `OPTIONS` —
     but that's fine here: CORS preflights are cached 24 h (the Worker's
     `Access-Control-Max-Age`) and a refetch loop sends GETs/POSTs, not
     preflights, so OPTIONS volume never trips a sane threshold.
   - **If your plan caps the number of rate-limiting rules** (Free is limited —
     check the availability table below), keep the **`/rest/v1/`** rule (the
     proven vector) and rely on the Worker's version gate plus Supabase's own
     per-function limits to bound functions; add the `/functions/v1/` rule when
     you have the rule budget or move to Paid.

   **Paid WAF** unlocks a longer window (e.g. 1 min), matching on
   `http.request.method` (to exempt `OPTIONS` explicitly) and other fields,
   custom characteristics (e.g. key by the `Authorization` header for
   per-session limiting), and enough rules to run both paths at once. Check
   Cloudflare's *Rate limiting rules → Availability* table for exactly which
   fields/periods/rule-counts your plan exposes.
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
pagination (this checks `Content-Range` is exposed), pinning/marking done,
add-feed (exercises the `discover` **function** through the gateway), and pull-to
-refresh (the `refresh` function). Or by hand:

```
# Preflight should echo the requested headers (same handler for REST and functions):
curl -i -X OPTIONS https://api.readmo.app/rest/v1/ \
  -H 'Origin: https://readmo.app' \
  -H 'Access-Control-Request-Headers: apikey, authorization, x-readmo-build'

# A normal read should pass through (401/empty is fine — proves routing + CORS):
curl -i https://api.readmo.app/rest/v1/ -H 'Origin: https://readmo.app'

# An Edge Function preflight + call should route the same way (401 without a JWT
# is fine — it proves /functions/v1/ reaches Supabase through the gateway):
curl -i -X OPTIONS https://api.readmo.app/functions/v1/refresh \
  -H 'Origin: https://readmo.app' \
  -H 'Access-Control-Request-Headers: authorization, content-type, x-readmo-build'
curl -i -X POST https://api.readmo.app/functions/v1/refresh \
  -H 'Origin: https://readmo.app' -H 'content-type: application/json' -d '{}'
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
