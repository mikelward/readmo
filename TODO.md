# TODO

Deferred work, tracked here so it isn't lost. Each item links to where the
constraint is documented in more detail.

## Offline / PWA

- **Background Sync API.** Writes queued in the outbox while offline are
  flushed on the next page open / focus-return. The
  [Background Sync API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
  would let the service worker flush the outbox in the background — even when
  the tab is closed — on browsers that support it (Chrome/Android, not Safari).
  Worth considering once the outbox is reliable (idempotency keys done);
  deferred until then.

## Sync / write path

- **Idempotency keys for exactly-once outbox delivery.** The item-state outbox
  is currently at-least-once: a `set_item_state` write can commit on the server
  while the client crashes or loses the response before recording the returned
  `version`. On replay the optimistic-concurrency check (`0007`) sees the row
  already advanced and rejects with `40001`, so that write — and any same-item
  follow-up queued behind it — reconciles away. State stays *consistent* with
  what committed; at most one triage toggle in that crash-during-ack window is
  dropped. The complete fix is a per-write idempotency token the server dedups
  on (a replay of a committed write returns success + the new version, letting
  the outbox advance the successor's base). A client-only dependency hack can't
  close it — the predecessor's own replay conflicts without server dedup. Needs
  its own migration + token plumbing through the write path. See SPEC.md §Sync
  and PR #14 (Codex thread on `src/lib/data/itemStateOutbox.ts`).

- **Per-field version conflict (refinement).** The `0007` version check is
  row-level, so two devices editing the *same item* conflict even on independent
  flags (the loser re-reconciles). Per-field versioning would let independent
  edits both land. Conservative-but-safe today. See SPEC.md §Sync.

## Storage / dedup

- **Cross-feed item dedup.** Same-feed dupes (a publisher re-issuing the same
  URL under a new `<guid>`) are now collapsed by the `(feed_id, url)` partial
  unique index and the `upsert_feed_items` RPC (migration `0013`). The
  remaining case is when the SAME article URL shows up in two DIFFERENT feed
  subscriptions — e.g. a user subscribed to both "BBC News - Home" and "BBC
  News - Top Stories", which carry overlapping articles. Today those land as
  separate `items` rows (one per `feed_id`) and the user sees two rows for the
  same story. Options to consider, with tradeoffs:
  - **De-dup at read time in `feed_items`** (`distinct on (lower(url))`,
    keep the newest): cheapest, reversible, but hides the duplication rather
    than fixing storage; needs care with the section/order_by to avoid losing
    the Pinned-first guarantee.
  - **Share `items` rows across feeds**: lift the `feed_id` off `items` into a
    join table; biggest schema change, but the cleanest. Costs a migration on
    the hottest table and the `feed_items` RPC.
  - **Subscription-level dedup hint**: let the user pick a "primary" feed when
    two of their subscriptions share articles. Lowest impact, requires UI.
  See SPEC.md §Data → De-dup.

## Feed discovery

- **Section discovery for curated autocomplete feeds/sites.** Typed URLs that
  advertise multiple feeds now surface a multi-select picker so a user can
  follow a specific section (Sport, World news, …) — see SPEC.md §Feed
  discovery. Curated `POPULAR_FEEDS` autocomplete entries still bypass discovery
  entirely (each points at one direct feed URL), so they never offer sections.
  Extend the curated path to support sections too: either tag curated entries
  that represent a *site* (vs. a single feed) and route their submit through
  `discover()` → the picker, or carry an explicit per-entry section list in
  `popularFeeds.ts` and show the picker without a network round-trip. Keep the
  bot-block resilience the curated direct-subscribe path was added for (don't
  force every popular feed through discovery). See `src/pages/SettingsPage.tsx`
  (`onSubmitAddFeed`) and `src/lib/popularFeeds.ts`.

## Server RPCs

- **Authenticated OPML-export RPC.** `feeds_public` exposes only `site_url`
  (never `url`/`secret_url`), so the client can't emit real feed fetch URLs;
  live `exportOpml` carries homepage URLs until a server-side export exists.
  See SPEC.md §Sync.

- **Server-side subscription-scoped feed RPC for very large libraries.** Home/
  folder reads use `.in('feed_id', feedIds)`; a user with hundreds of
  subscriptions could exceed request-line limits. The scalable fix is the
  server-side subscription-scoped feed join (the `feed_items` RPC already covers
  the paged path). See `SupabaseDataSource.feedView` and SPEC.md §Data.

## Server / batch query limits

- **Decide whether `service_role` (poll / refresh / import batch) needs an
  explicit query ceiling.** `0013_user_query_statement_timeout.sql` caps
  `statement_timeout` for *user-initiated* queries (`authenticated` 5 s, `anon`
  3 s) but does not change `service_role`. That does **not** leave batch work
  unbounded: an unset `service_role` timeout inherits the `authenticator`
  default (8 s per Supabase's
  [timeouts docs](https://supabase.com/docs/guides/database/postgres/timeouts)),
  so a batch statement running past ~8 s is already canceled — possibly aborting
  a legitimately long feed sync mid-batch. So the real decision is whether 8 s is
  the right batch ceiling, or whether to set `service_role` explicitly (to `0`
  for no limit, or a generous value like 30–60 s) and reload PostgREST. Options
  to weigh:
    - A *generous* `service_role` statement_timeout (e.g. 30–60 s) as a safety
      net for truly-stuck queries, set well above any healthy batch.
    - Per-operation `SET LOCAL statement_timeout` inside the function around the
      known-heavy statements (the item upserts), leaving the role default unset.
    - Rely on the bounds that already exist: the poller chunks ~25 feeds/run,
      `safeFetch` caps each upstream fetch at 10 s, and Edge Functions have a
      platform wall-clock limit — so total batch time is already loosely bounded.
  Not urgent: batch volume is small today and the fetch timeout covers the common
  stall. Revisit if a stuck batch query is ever seen pinning a connection. See
  `0013_user_query_statement_timeout.sql` and SCALING.md.

## Infrastructure / hosting

- **Consider consolidating the frontend onto Cloudflare (Vercel → CF Pages).**
  Once the Cloudflare gateway (`infra/cf-gateway/`) is in the picture, we
  considered moving the rest of the front end off Vercel too — the SPA bundle to
  **Cloudflare Pages** and the one Vercel function (`api/img.ts`) to a Worker —
  to drop a platform and the Vercel Pro (~$20/mo). The move would be *small*
  because Vercel does very little here: it serves the static SPA, runs the single
  `api/img.ts` image shim, and supplies the `VERCEL_*` build-env vars; the
  lock-in is minimal. **Decided against it for now** — the **GitHub PR preview
  DX** (the `vercel[bot]` preview deployments + inspector) is valued, and CF
  Pages' previews, while real, are less polished. The blocker is DX preference,
  not feasibility.

  If revisited, the move is roughly: SPA → CF Pages (the `vercel.json` SPA
  rewrite becomes a `_redirects` / `_routes.json` rule); `api/img.ts` → a Worker
  or Pages Function (or fold it into the gateway Worker, which already proxies
  `/functions/`); and `vite.config.ts` must accept CF Pages' build-env vars
  (`CF_PAGES`, `CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`) in place of `VERCEL_*`
  **and re-gate the production poison-pill guard** (currently
  `VERCEL_ENV === 'production'`) on CF Pages' "is production" signal, or it would
  silently never fire. Revisit if the Vercel preview DX stops mattering, if CF
  Pages previews improve, or to cut the Vercel Pro cost. (Moving the *backend* —
  Postgres / Auth / RLS / Edge Functions — off Supabase is a separate, much
  larger re-platforming and is **not** what this is about.)
