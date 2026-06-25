# Readmo — Backend Setup

This document covers the Readmo **backend**: the Supabase project (Postgres +
Auth + Edge Functions), the SQL migrations, OAuth configuration, environment
variables, function deployment, and the scheduled poller. The frontend
(React + Vite on Vercel) is set up separately.

> **Security guardrails baked into this backend** (do not weaken):
> - **Every server-side fetch routes through the SSRF-hardened helper**
>   (`supabase/functions/_shared/ssrf.ts`). Feed URLs and site URLs are
>   user-supplied and therefore untrusted.
> - **All publisher HTML is sanitized server-side** before it is stored
>   (`supabase/functions/_shared/sanitize.ts`). Raw publisher HTML is never
>   stored or served.
> - **RLS is the per-user boundary.** `feeds`/`items` are shared but **not**
>   world-readable; `secret_url` is server-only. The service-role key never
>   reaches the client.

---

## 1. Prerequisites

- A [Supabase](https://supabase.com) account.
- The [Supabase CLI](https://supabase.com/docs/guides/cli):
  ```sh
  npm install -g supabase     # or: brew install supabase/tap/supabase
  supabase --version
  ```
- [Deno](https://deno.com) (the Edge Functions runtime) for local function
  development.

---

## 2. Create the Supabase project

1. In the Supabase dashboard, create a new project. Pick a region close to your
   users and the publishers you poll.
2. Note these values from **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL` (e.g. `https://abcd1234.supabase.co`).
   - **anon public key** → `SUPABASE_ANON_KEY` (safe to ship to the client).
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY`
     (**server-only — never ship this to the browser**).
3. Link the CLI to the project:
   ```sh
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

---

## 3. Run the database migrations

The migrations live in `supabase/migrations/` and apply in sortable order:

| File | Purpose |
|------|---------|
| `0001_schema.sql` | Tables (`feeds`, `items`, `subscriptions`, `item_state`, `folders`), indexes (incl. the partial `item_state` pinned/done/hidden indexes). |
| `0002_rls.sql` | Enables RLS + policies; `feeds`/`items` visibility scoped to subscription **or** permanent state; keeps `secret_url` server-only via column revoke + the `feeds_public` view. |
| `0003_item_state_version.sql` | Server-assigned monotonic `version` bump + state-exclusivity enforcement + `*_at` timestamping trigger on `item_state`. |
| `0004_access_rpcs.sql` | Closes the access-by-UUID escalation: `subscribe_to_feed` / `set_item_state` SECURITY DEFINER RPCs (authorize by URL possession / current item visibility) and **revokes direct client `INSERT`** on `subscriptions` + `item_state`. |

Apply them:

```sh
# Push all pending migrations to the linked project:
supabase db push

# (Local dev alternative — run against a local Postgres in Docker:)
supabase start
supabase db reset      # re-applies every migration from scratch
```

**Verify** after pushing:
- `feeds`, `items`, `subscriptions`, `item_state`, `folders` exist.
- RLS is **enabled** on all five (Dashboard → Authentication → Policies).
- The `feeds_public` view exists and does **not** expose `secret_url`.
- Client roles (`anon`, `authenticated`) have **no** column access to
  `feeds.secret_url`.
- `anon`/`authenticated` have **no** direct `INSERT` on `subscriptions` or
  `item_state`, **no** direct `UPDATE` on `item_state`, and may update only
  `folder`/`title_override`/`muted`/`sort` (never `feed_id`) on `subscriptions`
  — clients write via `subscribe_to_feed` / `set_item_state`.
- Optional regression check: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f
  supabase/tests/access_rpcs.sql` prints `PASS …` for each access check.

---

## 4. Configure OAuth (Google + Discord)

MVP ships **Google** and **Discord** sign-in (Apple is deferred). No passwords
are stored by Readmo. In **Authentication → Providers**:

### Google
1. In the [Google Cloud Console](https://console.cloud.google.com), create an
   OAuth 2.0 Client ID (type: Web application).
2. Authorized redirect URI:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the **Client ID** and **Client Secret** into Supabase → Providers →
   Google. Enable it.

### Discord
1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create a **New Application**, then open **OAuth2**.
2. Add a redirect:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the **Client ID** and **Client Secret** into Supabase → Providers →
   Discord. Enable it.

### Redirect URLs
Under **Authentication → URL Configuration**, add your app origins to
**Redirect URLs** (e.g. `https://readmo.app/**`, plus any Vercel preview
origins and `http://localhost:5173/**` for local dev).

> OAuth **client secrets** are stored in Supabase and are **server-only**.
> They never reach the browser.

---

## 5. Environment variables

| Variable | Where it lives | Secret? |
|----------|----------------|---------|
| `SUPABASE_URL` | client **and** server | No (public) |
| `SUPABASE_ANON_KEY` | client **and** server | No (public, RLS-gated) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** (Edge Functions / poller) | **Yes — never ship to client** |
| Google / Discord client secrets | Supabase Auth config | **Yes — server only** |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_TLS` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` / `SIGNUP_NOTIFY_TO` | **server only** (`notify-signup` function) — `supabase secrets set …`; see §9 | **`SMTP_PASSWORD` yes — never ship to client** |

**Client build** (Vite) gets only `SUPABASE_URL` + `SUPABASE_ANON_KEY` as
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — copy `.env.example` to
`.env.local` and fill these in. The Supabase client (`src/lib/supabase/client.ts`)
and `SupabaseDataSource` read exactly these two vars; when they are absent the
app falls back to the mock auth + `MockDataSource` so it still runs with no
backend. The service-role key and OAuth secrets must **never** be referenced in
any `VITE_*`/client variable.

**Edge Functions** read `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` from the Functions environment, but you do **not**
set these yourself — Supabase **auto-injects** them into the deployed runtime.
The CLI reserves the `SUPABASE_` prefix and refuses to set them:

```
$ supabase secrets set SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=…
Env name cannot start with SUPABASE_, skipping: SUPABASE_URL
Env name cannot start with SUPABASE_, skipping: SUPABASE_ANON_KEY
Env name cannot start with SUPABASE_, skipping: SUPABASE_SERVICE_ROLE_KEY
```

That warning is expected — there is nothing to set for deployment. Use
`supabase secrets set` only for *custom* (non-`SUPABASE_`) names — the
`SMTP_*` / `SIGNUP_NOTIFY_TO` values for `notify-signup` (§9) are the only ones.
The service-role key is needed by hand in only two places: the **cron poller**
(§7, passed as a bearer token) and **local** `supabase functions serve`
(off-platform, so put the three vars in a local, untracked `.env`; see
`supabase/functions/.env.example`).

---

## 6. Deploy the Edge Functions (with the import map)

The shared server modules under `supabase/functions/_shared/` are authored as
plain TypeScript using **bare npm specifiers** (`fast-xml-parser`,
`sanitize-html`) so they can be unit-tested under vitest (node) directly from
`node_modules`. Deno does not resolve bare npm specifiers on its own, so
`supabase/functions/import_map.json` rewrites them to `npm:` specifiers for the
Deno runtime. **You must pass the import map when serving/deploying.**

```sh
# Local serve (one function), with the import map:
supabase functions serve discover --import-map supabase/functions/import_map.json

# Apply pending migrations then deploy all functions:
make deploy

# Or just run migrations:
make migrate

# Or deploy individually:
supabase functions deploy discover --import-map supabase/functions/import_map.json
supabase functions deploy refresh  --import-map supabase/functions/import_map.json
supabase functions deploy fulltext --import-map supabase/functions/import_map.json
supabase functions deploy poll     --import-map supabase/functions/import_map.json --no-verify-jwt
supabase functions deploy img      --import-map supabase/functions/import_map.json --no-verify-jwt
supabase functions deploy notify-signup --import-map supabase/functions/import_map.json --no-verify-jwt
```

> **`img` must deploy with `--no-verify-jwt`.** It's the image proxy: the
> browser loads it via `<img src="…/functions/v1/img?url=…">`, and an `<img>`
> tag can't send an `Authorization` header — with JWT verification on (the
> default) every image would 401. It's safe to expose: the function only relays
> `image/*` through the SSRF-hardened `safeFetch` (no auth-bearing logic, no DB
> writes). The others keep JWT verification **on** — `discover`/`refresh`/
> `fulltext` run as the calling user (RLS-scoped), and `poll` checks the
> service-role bearer itself.

> If you prefer a project-level config, add the same `imports` map to a
> `supabase/functions/deno.json` and reference it via `--config`; the
> entrypoints import the bare specifiers either way.

The functions:

| Function | Route | Role |
|----------|-------|------|
| `poll` | scheduled (cron) | Polls due feeds with ≥1 subscriber, conditional GET via `safeFetch`, parse → sanitize → upsert, adaptive backoff + circuit breaker. Service role. |
| `discover` | `POST /functions/v1/discover` | Discover + validate feed candidates from a site/feed URL (incl. Reddit `.rss`). |
| `refresh` | `POST /functions/v1/refresh` | On-demand fetch for the caller's subscribed feed(s); debounced. |
| `fulltext` | `POST /functions/v1/fulltext` | Reading mode: fetch + extract (Readability) + sanitize the full article for a truncated item, cache it on the shared row. RLS-scoped to the caller. |
| `img` | `GET /functions/v1/img?url=…` | SSRF-hardened image proxy (offline images + hotlink/reliability; privacy is incidental — see SPEC *Image proxy*). |
| `notify-signup` | `POST /functions/v1/notify-signup` | Emails the operator over SMTP when a new user signs up. Called server-to-server by the `auth.users` insert trigger (§9); verifies the service-role bearer itself, so deploy with `--no-verify-jwt`. |

> **Same-origin `/api/img` shim (Vercel).** Sanitized `content_html` points
> every `<img src>` at the same-origin path `/api/img?url=…` (not the Supabase
> URL directly) so the browser only talks to our origin and the service worker
> can cache the bytes offline. The thin Vercel Edge Function `api/img.ts` backs
> that route: it forwards `/api/img` to `…/functions/v1/img`, reading the
> Supabase origin from the `SUPABASE_URL` env var (falls back to
> `VITE_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, matching the client in
> `src/lib/supabase/client.ts`). It never fetches the user-supplied `url`
> itself — that
> stays inside the SSRF-hardened `img` function. Both the function and the shim
> refuse `image/svg+xml` (an SVG served same-origin can execute script as a
> top-level document) and set `X-Content-Type-Options: nosniff` + a
> `default-src 'none'; sandbox` CSP on the served bytes. Make sure `SUPABASE_URL`
> is set in the Vercel project env. Cost/reliability: negligible — one extra
> same-region hop (Vercel → Supabase) on a cache miss, well within Vercel's
> free Edge invocation tier; on misconfig it returns `503` and images fall back
> to the broken-image placeholder (no crash). The shim marks every error
> response `Cache-Control: no-store`; **only** a 200 with image bytes carries the
> long immutable cache-control, so a shared cache (below) never freezes a
> transient hotlink 403 / publisher 5xx for the image's week-long TTL.

> **Shared image cache via Cloudflare (recommended).** Without a cache between
> the publisher and each client's service worker, a popular article fetches the
> same image from the publisher once per *cold client* through a few server IPs
> — the concentration that risks the publisher rate-limiting/banning the proxy
> (SPEC *Image proxy* / *Shared image cache*). Vercel does **not** cache
> `/api/img` today (its Edge Cache needs `s-maxage`/`CDN-Cache-Control`; the shim
> sends only `max-age`, which is browser-only). Since Cloudflare already fronts
> the API for rate limiting (`infra/cf-gateway/`), reuse it for the image bytes
> with a **Cache Rule** on the image route:
> - **Match** the image path (the app-origin `/api/img*`, on whichever zone
>   serves it to browsers) → **Eligible for cache / "Cache Everything"** — a
>   `/api/...` path with a query string is treated as dynamic and is not cached
>   by default, so it must be opted in explicitly.
> - **Cache key = full query string.** The whole image identity is `?url=…`, so
>   `?url=A` and `?url=B` must be distinct entries (Cloudflare's default — just
>   don't enable any "ignore query string" option for this path).
> - **Cache by status:** cache `200` for the long origin TTL (the shim's
>   `immutable` header is honored); do **not** cache `4xx`/`5xx` (the shim's
>   `no-store` already signals this — keep the rule from overriding it).
> - **Ignore cookies** for this path so a stray cookie doesn't bypass the cache
>   (`/api/img` sets none; auth is header/localStorage-based).
> - Optional, **free: Tiered Cache** (Smart/Generic Tiered Cache is included on
>   all plans) — funnels per-POP misses through a regional upper tier, so the
>   publisher is hit ~once per region instead of once per POP.
> - Optional, **paid: Argo Smart Routing** (~$5/mo + ~$0.10/GB, per
>   [Cloudflare pricing](https://www.cloudflare.com/plans/)) — pushes the
>   collapse toward a single global publisher fetch per image. Only worth it if
>   free Tiered Cache proves insufficient; **enabling it is a real recurring bill
>   — don't turn it on without deciding that trade (guardrail #5).**
>
> Cost/reliability: the cache itself and the one Rate Limiting Rule are **free**;
> Tiered Cache is **free**; Argo is the **only paid** option above and stays off
> by default. A cache HIT never reaches Vercel or Supabase, so it also cuts
> Vercel Edge invocations. Net: publisher hits drop from once-per-cold-client to
> ~once-per-POP free (→ ~once-per-region with free Tiered Cache, → ~once globally
> only with paid Argo).

---

## 7. Schedule the poller (pg_cron, ~5 min)

### 7a. Store the service-role key in Vault

The cron job reads the service-role key from Supabase Vault at runtime.
Store it once via the SQL editor (find the key in Project Settings → API):

```sql
select vault.create_secret(
  '<your-service-role-key>',  -- the long JWT from Project Settings → API
  'service_role_key'          -- must match the name used in the cron below
);
```

> **Dashboard alternative:** Project Settings → Vault → New secret →
> name `service_role_key`, value = service role JWT.

> **Note:** `ALTER DATABASE SET app.*` is not available on managed Supabase
> instances, so `current_setting()` cannot carry the key — the Vault subquery
> below is the correct approach.

### 7b. Enable extensions and schedule

Enable the scheduler extensions and schedule an invocation of the `poll`
function every 5 minutes. In the SQL editor:

```sql
-- Enable scheduling + HTTP-from-Postgres (one-time).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace <ref> with your Supabase project ref (the subdomain of your project URL).
-- To reschedule (e.g. to update the URL): unschedule first, then re-create.
-- select cron.unschedule('readmo-poll');

select cron.schedule(
  'readmo-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/poll',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'service_role_key'
      ),
      'Content-Type', 'application/json'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

The poller is idempotent and self-throttling (adaptive `fetch_interval_s`,
exponential backoff + jitter on errors capped ~6h, circuit-breaker parking after
repeated failures). A flaky publisher cannot stall the app — per-feed isolation
keeps one bad feed from affecting others; a parked feed surfaces as a
feed-health badge with "retry now".

> **Reddit note:** send the descriptive `User-Agent`
> (`Readmo/1.0 (+https://readmo.app)`, already wired) and respect
> `Retry-After`; Reddit rate-limits by IP and all users share the poller's IP.
> Identical Reddit listings de-dup to one shared `feeds` row.

---

## 8. Tests

The shared server modules are unit-tested under vitest (node) without any live
DB or network:

```sh
npx vitest run supabase
```

These cover the feed parser (RSS 2.0 / Atom / RDF / JSON Feed + malformed +
missing-GUID + relative-URL absolutization), the HTML sanitizer (no script /
event-handler survives; relative URLs absolutized), the SSRF helper (rejects
loopback/link-local/private/metadata literals and a redirect to
`169.254.169.254`), discovery (`<link>` autodiscovery + Reddit `.rss`
derivation), and the signup-notification email builder (subject/body, recipient
+ SMTP config resolution, and CR/LF header-injection stripping).

---

## 9. Enable signup email notifications (SMTP)

When a new user signs up, the operator gets an email. Migration
`0012_signup_notification.sql` adds an `AFTER INSERT` trigger on `auth.users`
that fire-and-forget posts the new row to the `notify-signup` Edge Function via
`pg_net`; the function sends the alert over SMTP. **The trigger no-ops until
both the Vault config and the SMTP secrets below are set**, so signups keep
working before (and without) any of this.

### 9a. SMTP secrets

Set the SMTP relay credentials (any provider — Fastmail, Gmail App Password,
SES SMTP, …). These are custom (non-`SUPABASE_`) names, so the CLI sets them:

```sh
supabase secrets set \
  SMTP_HOST=smtp.example.com \
  SMTP_PORT=465 \
  SMTP_USERNAME=alerts@example.com \
  SMTP_PASSWORD='…' \
  SMTP_FROM=alerts@example.com
# Optional: SMTP_TLS=true|false (defaults: on for 465, STARTTLS for 587),
#           SIGNUP_NOTIFY_TO=… (defaults to mikel@mikelward.com).
```

See `supabase/functions/.env.example` for the local-serve equivalent.

### 9b. Vault config for the trigger

The trigger reads the function base URL + the service-role bearer from Vault
(same mechanism as the poller in §7a — `service_role_key` is already stored
there). Add the base URL once (replace `<ref>`):

```sql
select vault.create_secret(
  'https://<ref>.supabase.co/functions/v1',  -- no trailing slash needed
  'functions_base_url'
);
```

### 9c. Deploy

```sh
make migrate                 # applies 0012 (trigger + function)
make deploy-notify-signup    # deploys the function (--no-verify-jwt)
```

Send a test signup and confirm the alert arrives. The function logs
(`supabase functions logs notify-signup`) report `SMTP not configured`
(misconfig → 500) or `SMTP send failed` (relay rejected → 502) without ever
affecting account creation.

---

## 10. Cost & reliability (rule-11)

- **Supabase free tier** (Postgres 500MB, 50k MAU, scheduled functions) is **$0**
  at this scale; Pro is ~$25/mo if it grows. Poll cost scales with **distinct
  feeds**, not users; conditional GETs are a few KB and `304`s are nearly free.
- **New hard dependencies** vs. a stateless client: the DB and the OAuth
  provider. On a Supabase outage, login/sync fail but the offline cache still
  serves already-synced + pinned/favorited content. A flaky publisher cannot
  take the app down (per-feed isolation + circuit breaker). Egress-IP pooling
  for Reddit is **not** provisioned unless Reddit volume warrants it.
- **Signup notifications (SMTP):** cost is **negligible** — one outbound email
  per new account; every mainstream relay's free tier (Gmail, Fastmail,
  SES free tier) covers signup volume many times over. It is **off the user's
  critical path**: `pg_net` posts fire-and-forget after the insert commits, so a
  slow/failing relay never delays or blocks signup. Failure modes — relay down
  or rejecting (function returns 502), or secrets unset (no-op / 500) — only
  drop the *alert*; the account is still created. No new always-on dependency.

---

## 11. Frontend deploy (Vercel)

The frontend's Vercel project ("Framework Preset: Vite") is mostly
zero-config, but **one project env var is required**:

| Var | Value | Why |
| --- | --- | --- |
| `VERCEL_DEEP_CLONE` | `1` | Vercel's default `git clone --depth=10` defeats `git rev-list --count HEAD` at build time. The build aborts (`vite.config.ts → readBuildInfo`) if `commitCount` is 0 in a production build, because shipping `x-readmo-build: 0` would let the version gate (`supabase/functions/_shared/clientVersion.ts`) reject the newest client the moment the gate is armed. An in-build `git fetch --unshallow` is a silent no-op on Vercel, so `VERCEL_DEEP_CLONE=1` (per [vercel#5737](https://github.com/vercel/vercel/discussions/5737)) is the only fix that sticks. |

Also set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (see §5) — without
them the client falls back to the in-memory mock data source.
