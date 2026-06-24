# Scaling guide

Practical steps as user count grows. Each section notes the trigger (when
to act) and the action.

## Already done

- **React Query staleTime (5 min) + refetchOnWindowFocus gated by staleTime.**
  Feed views refetch on focus only when data is stale, not on every tab
  switch. Without this, each open tab per user generates a DB request on
  every window focus event. See PR #68.
- **Minimum-client-version gate + per-caller rate limit on Edge Functions.**
  The app stamps `x-readmo-build: <commitCount>` on every Supabase request;
  the `refresh` Edge Function turns away builds below `MIN_CLIENT_BUILD` (a
  secret, 0 = disarmed) with `426`, and rate-limits per caller in-memory
  before any DB work. This is the in-code half — it covers Edge Functions
  only, **not** the `feed_items` read RPC. See *Shedding an abusive or runaway
  client* below for the read-path (gateway) half that uses the same header.

---

## Database compute tier

**Trigger:** CPU regularly above ~60%, or p99 query latency climbing.

**Action:** Upgrade the Supabase compute tier (Dashboard → Settings →
Compute). The free/Micro tier has ~1 shared vCPU and 512 MB RAM — it will
saturate quickly under concurrent load. The Small tier (~2 GB RAM, dedicated
vCPU) is the first meaningful step and handles hundreds of concurrent users
comfortably.

---

## Connection pooling (Supavisor)

**Trigger:** Before going to production with real users, or if you see
"remaining connection slots are reserved" errors.

**Action:** Switch to Supabase's Supavisor pooler in **transaction mode**
(port 6543). The default direct connection (port 5432) opens one Postgres
connection per PostgREST worker; Supavisor multiplexes many client
connections over a small pool. The current pool size is 15 — that's fine
for development but a ceiling in production.

The Supabase JS client goes through the REST API (not a direct Postgres
connection), so this matters most for:
- Edge Functions that use a Postgres client directly
- Any future server-side query path (e.g. a background worker)

---

## `feed_items` RPC: `count(*) over()`

**Trigger:** The `feed_items` RPC appears in the slow-query log with high
`mean_time` or `total_time`.

**Action:** The window function `count(*) over()` in `0006_feed_rpcs.sql`
does a full scan of the filtered result set on every call to return the
total item count for pagination UI. With many items/subscriptions this
becomes expensive. Options:

1. **Drop the total count** — most feed readers don't show "X of Y"; remove
   `total_count` from the RPC return and the `total` field from the client.
2. **Estimate** — use `pg_class.reltuples` or a materialized count; good
   enough for "~1,200 items".
3. **Separate cheap count query** — issue a lightweight `count` query only
   when the user explicitly opens a page that shows the total.

---

## Client-side request volume

**Trigger:** `set_config` dominates the query-performance dashboard again
(it is PostgREST's per-request overhead — one row per API call).

**Likely causes and fixes:**

| Cause | Fix |
|---|---|
| staleTime reduced or removed | Restore `staleTime: 5 * 60 * 1000` in `main.tsx` |
| New `useQuery` without staleTime | Ensure all queries inherit or override with a reasonable staleTime |
| Supabase Realtime subscriptions | Each subscription keeps a WebSocket open but also makes REST calls; audit with the dashboard |
| Poller burst on cold start | Stagger `next_fetch_at` across feeds so they don't all come due at once after a restart |

---

## Shedding an abusive or runaway client (gateway)

**Trigger:** A shipped client build is hammering the backend — most visibly the
`feed_items` read RPC (a feed-invalidation/refetch loop), seen as a single
`sub`/IP dominating `/rest/v1/rpc/feed_items` in the Logs, DB CPU pinned, the
app painting "backend unavailable." A PWA can't be fixed by shipping a new
build: cached service workers keep the bad version alive on devices you can't
reach, so the defense has to be server-side.

**Already in place (in-code, Edge Functions only):** every request carries
`x-readmo-build: <commitCount>` (`src/lib/supabase/client.ts`); the `refresh`
function rejects builds below `MIN_CLIENT_BUILD` with `426` and rate-limits per
caller (`supabase/functions/_shared/{clientVersion,rateLimit}.ts`). This does
**not** cover the `feed_items` read RPC — PostgREST runs no code of ours — which
is exactly the path a refetch loop pounds. That half needs a gateway.

> [!IMPORTANT]
> **A gateway only sees traffic that goes through it — so it is a *forward*
> defense, not a retroactive one.** Each client has its Supabase URL baked into
> its bundle and service worker at build time. A bad build that already shipped
> pointing at `*.supabase.co` keeps calling that origin **directly**, bypassing
> Cloudflare entirely — so standing up the custom domain *now*, after the bad
> build is already in the wild, will **not** let the gate see its `feed_items`
> loop. The gate only catches a build that was *already* routing through the
> custom domain when it shipped.
>
> Practical consequences:
> - **Adopt the custom domain proactively**, before you need it, so every
>   shipped build already routes through Cloudflare and any *future* bad build is
>   gateable. This is the main reason to do the migration early.
> - **For a bad build already hammering `*.supabase.co` directly**, the gateway
>   can't help. Hosted Supabase has no clean "only allow via the custom domain"
>   switch for browser REST traffic, so the levers are: (a) the in-code `refresh`
>   gate still applies on the direct origin — but not the read RPC; (b) identify
>   and kill the offending session (see Trigger); (c) the nuclear option —
>   rotate the anon key / JWT secret, which invalidates *every* old client's
>   requests and forces a re-auth + update (disruptive, last resort).
> - Mitigating tailwind: the PWA uses `registerType: 'autoUpdate'`, so most
>   clients pick up the fixed build on their next navigation and the bad-build
>   population drains on its own — but a tight refetch loop may never navigate,
>   which is the case that needs one of the levers above.

**Action — front Supabase with Cloudflare so one ruleset covers every path
(Edge + REST). Best done proactively (see the note above), then armed when
needed:**

1. **Custom domain on Supabase** (Dashboard → Settings → Custom Domains; ~$10/mo
   add-on). Point e.g. `api.readmo.app` at the project. Prerequisite — you can't
   proxy `*.supabase.co` through your own Cloudflare otherwise.
2. **Proxy it through Cloudflare** (orange-cloud the DNS record). Now all of
   `/functions/v1/*` and `/rest/v1/*` flow through Cloudflare's WAF.
3. **Point the app at it:** set `VITE_SUPABASE_URL=https://api.readmo.app` and
   redeploy, so client traffic actually traverses Cloudflare. (The Workbox
   offline data-cache pattern is derived from this URL in `vite.config.ts`, so
   it follows the new origin automatically — no separate cache-rule edit, and no
   silent loss of offline feed reads.)
4. **Version-gate rule — the kill switch for the known-bad build.** Two tiers:
   - *Simple, no Worker:* block requests **missing** the header — the old
     looping build predates it, so it sends none (effective only for a build
     already routing through the gateway — see the note above). Expression: `http.request.method ne "OPTIONS" and not
     any(len(http.request.headers["x-readmo-build"][*]) > 0)` AND path under
     `/rest/` or `/functions/` → Block. **The `method ne "OPTIONS"` clause is
     load-bearing:** a CORS preflight is an `OPTIONS` that lists the header in
     `Access-Control-Request-Headers` but does **not** send it as an actual
     header, so a rule that didn't exempt `OPTIONS` would block every modern
     client's preflight and take the path down. Let preflights pass through to
     Supabase, which answers them.
   - *Precise numeric floor (a Worker):* to express "build `< N`" you need a
     tiny Worker — rule expressions don't do header→int compare. ~10 lines
     (below). Lets you raise the floor over time without editing rules.
5. **Rate-limit rule — backstop for a future loop that DOES send a header.**
   Cloudflare → Security → Rate limiting rules: on `/rest/v1/rpc/feed_items` and
   `/functions/v1/*`, e.g. > 120 req/min per client → `429` for 60s. Exempt
   `OPTIONS` here too (`http.request.method ne "OPTIONS"`) so a burst of
   preflights can't trip it and break CORS. Key by IP (free, but blunt — NAT
   lumps users together, the one keying where you could throttle yourself) or,
   more precisely, by the `Authorization` header (per session) on paid Advanced
   Rate Limiting. Set the ceiling well above human use; a refetch loop blows
   past it instantly.

**Sample Worker (version floor + 426):**
```js
const MIN_BUILD = 150; // bump past the known-bad build; keep in sync with MIN_CLIENT_BUILD
export default {
  async fetch(req) {
    // Let CORS preflights through — an OPTIONS doesn't carry x-readmo-build
    // (it only lists it in Access-Control-Request-Headers), so gating it would
    // block every modern client before its real request is sent.
    if (req.method === 'OPTIONS') return fetch(req);
    const raw = req.headers.get('x-readmo-build');
    const build = raw == null ? NaN : Number(raw.trim());
    if (!Number.isInteger(build) || build < MIN_BUILD) {
      return new Response(JSON.stringify({ error: 'client too old, please update' }), {
        status: 426, headers: { 'content-type': 'application/json' },
      });
    }
    return fetch(req); // pass through to Supabase
  },
};
```

**CORS caveat — verify before relying on the REST path.** Adding `x-readmo-build`
to every supabase-js request means the browser preflights it on the REST API
too. The Edge functions already allow it (`_shared/cors.ts`); Supabase's managed
REST gateway must also allow it. Verify with a preflight against `/rest/v1/` (an
`OPTIONS` carrying `Access-Control-Request-Headers: x-readmo-build` should echo
it in `Access-Control-Allow-Headers`). Behind your own Cloudflare/custom domain
you control CORS outright. If the managed gateway rejects it, fall back to
passing the build as an RPC argument instead of a header.

**Verification:** `curl -i https://api.readmo.app/rest/v1/rpc/feed_items` with no
header → blocked/426; with `-H 'x-readmo-build: 999'` → passes; confirm the live
app (newest build) still loads.

**Rollback:** set the rules to *Log* (not Block) or disable them; revert
`VITE_SUPABASE_URL` to the `*.supabase.co` origin. Cloudflare in front is a new
point of failure — highly available, but decide fail-open vs fail-closed for the
rules.

**Cost/reliability (guardrail #5):** Supabase custom domain ~$10/mo. Cloudflare
free tier covers WAF custom rules (the version gate) and basic IP rate limiting;
per-session (header) keying needs Advanced Rate Limiting (paid, ~$5/mo on Pro).
Added latency: one Cloudflare hop (single-digit ms) plus a Worker if used
(sub-ms). New failure mode: a Cloudflare/edge outage now sits in front of all
traffic.

---

## Poller at scale

**Trigger:** Many subscribed feeds; poller cron runs are slow or overlapping.

**Action:** The current poller (`supabase/functions/poll/index.ts`) fetches
all due feeds in a single Edge Function invocation. At scale this will hit
the Edge Function timeout. Split into:

1. A lightweight **scheduler** cron that pages through due feeds and enqueues
   them (e.g. via `pg_net` or a Supabase Queue).
2. A **worker** function invoked per-feed, with its own timeout budget.

This also naturally staggers DB writes instead of bursting them all at once.

---

## Read replicas

**Trigger:** Write latency climbing, or CPU split shows reads dominating.

**Action:** Supabase supports read replicas on Pro and above. The `feed_items`
RPC and all list reads are read-only and safe to route to a replica. The
Supabase JS client doesn't support this natively yet; you'd need to instantiate
a second client pointed at the replica URL for read paths.

---

## Indexes to add as data grows

| Query | Index to add |
|---|---|
| `feed_items` filtering by `user_id` + `sort_at` | Already covered by `items_feed_published_idx` and `item_state_user_item_idx`; revisit if EXPLAIN shows seq scans |
| Library views (pinned/done/hidden per user) | Partial indexes already exist (`item_state_pinned_idx`, etc.) |
| Subscription lookup by `user_id` + `feed_id` | Primary key covers this |

Run `EXPLAIN (ANALYZE, BUFFERS)` on slow queries before adding indexes — the
query planner often surprises you.
