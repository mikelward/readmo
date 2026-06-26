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

- **Support sites that don't publish a feed (e.g. inews.co.uk).** Today
  discovery fails on sites with no `<link rel="alternate">` and no
  well-known `/feed`/`/rss` path. Two paths considered:

  - **[RSSHub](https://docs.rsshub.app/) (community-maintained scraper that
    emits RSS).** Open-source Node service with ~1,500 per-site routes
    (Twitter, YouTube channels, lots of news sites, …). Two consumption
    modes:
    - *Public instance* (`rsshub.app`): free, no infra to run, but
      rate-limited and frequently IP-blocked by upstream publishers; the
      single shared IP gets hammered, so reliability is poor. Fine for
      hobby use, not for a reader users depend on.
    - *Self-hosted*: long-running container with in-process cache. The
      existing stack doesn't fit well — Supabase Edge Functions are Deno
      (RSSHub is Node-only); Vercel serverless technically works via
      RSSHub's "Vercel mode" but the project itself flags it as
      not-recommended (cold starts kill the cache, ~250 MB bundle bumps
      against Vercel limits, every poll re-scrapes upstream → faster
      blocks). The right shape is a $5/mo container on Fly.io / Railway /
      Render plus Upstash Redis (free tier) for cache/dedup state. Adds
      one more service to monitor; upstream routes break when sites
      redesign, but the *community* wears that maintenance, not us.
    Either way the integration on our side is trivial — RSSHub URLs are
    just RSS, so the existing poller handles them unchanged. Decision is
    "is the operational cost worth the coverage."

  - **DIY user-supplied selector.** Per-feed CSS selector
    (e.g. `article h2 a`) stored on the `feeds` row; the poller fetches
    via the SSRF-hardened helper and emits one item per match (title +
    absolute href, no body — tap opens the publisher externally, same
    path as today's "open original"). Zero extra infra, but fragile:
    every site redesign silently breaks the feed, and the user has to
    re-author the selector. Would need a per-feed "last successful
    parse" health signal and a graceful empty-state in the UI. Lower
    coverage than RSSHub (one site at a time, by hand), but no third
    party in the loop.

  Not mutually exclusive — RSSHub for the long tail of popular sites,
  selector feeds as the always-available fallback. Revisit when a user
  asks for a no-feed site we care about.

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

- **`feed_unread_ids` RPC for exact, flicker-free section badges.** The per-feed
  unread badge reads `getFeedUnreadCounts` (a server-only *count*), so it lags
  local triage by a sync round-trip. The client patches this with
  `adjustUnreadCounts` (discount loaded rows with a pending Sweep/Done write),
  which removes the multi-second post-sweep lag but leaves a sub-second blip at
  sync-completion: the pending id drains at write-confirm, one round-trip before
  the invalidated count refetch returns, so the badge briefly reads the stale
  count. A *number* can't be reconciled atomically with local triage — there's
  always a window where count and the local signal disagree (Codex P2 threads on
  PR #194). The exact fix is a `feed_unread_ids` RPC returning the per-feed
  unread **ID list** (~tens of KB; the listable set is already capped under the
  PostgREST row limit): the client holds the unread set and mutates it
  atomically with triage, so the badge is exact with no transient. Backend
  migration + manual `make migrate`/`make deploy`; keep the client tolerant of
  the count-only backend until it lands. See `src/lib/unreadAdjust.ts`, SPEC.md
  §"Per-feed unread count", and PR #194.

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

## UI / layout

- **Consider upping the tap targets and/or the min row height to match
  newshacker's density.** readmo currently keys the list row body's `min-height`
  to the bare `--rm-tap: 44px` touch floor (`ItemRow.css`), so a non-wrapping
  row is `44 + 12px` padding = **56px** (see the hard-coded skeleton height in
  `ItemList.css`). newshacker instead sets story rows to **48px** above the same
  44px touch floor (`--tap-min: 48px`), making its rows `48 + 12` = **60px**.
  Net effect: on the same viewport readmo packs ~7% more rows (~18.3 vs ~17),
  which reads as more cramped — counter to guardrail #9 ("match newshacker's UX
  by default"). Two ways to close the gap: (a) give `.item-row__body` its own
  `min-height: 48px` (and bump the `56px` skeleton to `60px`) while keeping
  `--rm-tap: 44px` as the genuine touch floor for buttons — targeted, doesn't
  inflate other controls; or (b) raise `--rm-tap` to 48px, which also enlarges
  every pin button / control keyed off it. Lean toward (a). Update `SPEC.md`'s
  story-row layout section in the same commit.

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
