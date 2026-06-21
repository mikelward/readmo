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

---

## 4. Configure OAuth (Google + GitHub)

MVP ships **Google** and **GitHub** sign-in (Apple is deferred). No passwords
are stored by Readmo. In **Authentication → Providers**:

### Google
1. In the [Google Cloud Console](https://console.cloud.google.com), create an
   OAuth 2.0 Client ID (type: Web application).
2. Authorized redirect URI:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the **Client ID** and **Client Secret** into Supabase → Providers →
   Google. Enable it.

### GitHub
1. In GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Authorization callback URL:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the **Client ID** and **Client Secret** into Supabase → Providers →
   GitHub. Enable it.

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
| Google / GitHub client secrets | Supabase Auth config | **Yes — server only** |

**Client build** (Vite) gets only `SUPABASE_URL` + `SUPABASE_ANON_KEY` (e.g. as
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`). The service-role key and OAuth
secrets must **never** be referenced in any `VITE_*`/client variable.

**Edge Functions** read their secrets from the Supabase Functions environment:

```sh
supabase secrets set \
  SUPABASE_URL="https://<ref>.supabase.co" \
  SUPABASE_ANON_KEY="<anon-key>" \
  SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
```

(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in the
Functions runtime on most projects; set them explicitly if running locally.)

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

# Deploy each function:
supabase functions deploy discover --import-map supabase/functions/import_map.json
supabase functions deploy refresh  --import-map supabase/functions/import_map.json
supabase functions deploy img      --import-map supabase/functions/import_map.json
supabase functions deploy poll     --import-map supabase/functions/import_map.json
```

> If you prefer a project-level config, add the same `imports` map to a
> `supabase/functions/deno.json` and reference it via `--config`; the
> entrypoints import the bare specifiers either way.

The functions:

| Function | Route | Role |
|----------|-------|------|
| `poll` | scheduled (cron) | Polls due feeds with ≥1 subscriber, conditional GET via `safeFetch`, parse → sanitize → upsert, adaptive backoff + circuit breaker. Service role. |
| `discover` | `POST /functions/v1/discover` | Discover + validate feed candidates from a site/feed URL (incl. Reddit `.rss`). |
| `refresh` | `POST /functions/v1/refresh` | On-demand fetch for the caller's subscribed feed(s); debounced. |
| `img` | `GET /functions/v1/img?url=…` | SSRF-hardened image proxy (privacy + offline images). |

---

## 7. Schedule the poller (pg_cron, ~5 min)

Enable the scheduler extensions and schedule an invocation of the `poll`
function every 5 minutes. In the SQL editor:

```sql
-- Enable scheduling + HTTP-from-Postgres (one-time).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Invoke the poll Edge Function every 5 minutes.
-- Replace <ref> and the service-role JWT (store the JWT via Vault in
-- production rather than inlining it).
select cron.schedule(
  'readmo-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/poll',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
      'Content-Type',  'application/json'
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
`169.254.169.254`), and discovery (`<link>` autodiscovery + Reddit `.rss`
derivation).

---

## 9. Cost & reliability (rule-11)

- **Supabase free tier** (Postgres 500MB, 50k MAU, scheduled functions) is **$0**
  at this scale; Pro is ~$25/mo if it grows. Poll cost scales with **distinct
  feeds**, not users; conditional GETs are a few KB and `304`s are nearly free.
- **New hard dependencies** vs. a stateless client: the DB and the OAuth
  provider. On a Supabase outage, login/sync fail but the offline cache still
  serves already-synced + pinned/favorited content. A flaky publisher cannot
  take the app down (per-feed isolation + circuit breaker). Egress-IP pooling
  for Reddit is **not** provisioned unless Reddit volume warrants it.
