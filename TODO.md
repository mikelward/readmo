# TODO

Deferred work, tracked here so it isn't lost. Each item links to where the
constraint is documented in more detail.

## Decisions needing review

Calls that haven't been settled — guesses autopilot made without asking, and
decisions deliberately postponed — recorded so they don't silently become
permanent by default. Each is cheap to change.

- **UNDECIDED: whether to hold a remotely-adopted filter list until the list
  rematerializes** (Codex P2 on #623). A filter list adopted from another device
  currently applies to the list already on screen, removing rows under a reader
  who did nothing — against the stable-set invariant. A *local* add must stay
  immediate (the reader just tapped Filter… and SPEC promises the article
  vanishes), so only the remote case would defer, and telling them apart means
  threading provenance from the settings store into `visibleItems`, which already
  carries two overlays with their own retention rules (`struckIdsRef`,
  `localDismissedIdsRef`). **The decision is postponed, not made** — shipped as-is
  for now because it needs a cross-device edit against a still-open tab to
  trigger and the effect is the feature applying early rather than data loss.
  Worth noting the premise is arguable: a filter set on one device taking effect
  on another reads as sync working, not as a violation — the invariant is about
  content moving under a reader's thumb, and a list that quietly loses rows the
  reader has already filtered elsewhere may be exactly what they want. Revisit
  when the server-side follow-up touches that materialization path; the options
  are to defer remote adoption there, or to accept the current behavior
  deliberately and say so in SPEC.
- **Keyword filtering: the server-side half is a follow-up, not this PR**
  (#623). `feed_items` / `feed_unread_counts` still need the same title
  predicate so badge counts stay honest and a filtered article **frees its slot
  in the per-feed floor** — without it, a feed whose newest 10 all match shows
  nothing instead of the next 10. Alternative was one larger PR spanning both
  halves; split because the client half is useful alone and needs no deploy to
  be correct. Reversible: the follow-up is additive.
- **`title_filters` is a `text[]` on `user_settings`, not its own table**
  (0071). Consequence: two devices editing the list before either syncs resolve
  last-write-wins over the **whole list**, not per word. Judged fine for a list
  edited a few times a year, and it rides the existing sync engine with no new
  read path. Reversible: a `title_filters` child table is the fix if it bites.
- **A short all-caps acronym folds onto its lowercase homograph** — filtering
  `US` also matches the pronoun "us". Recorded in a test rather than fixed; the
  menu never offers it (`us` is a stopword), so it takes typing `US` by hand,
  and removing the entry undoes it. The fix is case-preserving storage plus
  case-sensitive matching for all-caps entries, which is its own change.
- **Filtered words is its own Settings section**, between Reading and
  Appearance, rather than a subsection of Reading. Purely presentational;
  reversible in one edit.

## Offline / PWA

- **Background Sync API.** Writes queued in the outbox while offline are
  flushed on the next page open / focus-return. The
  [Background Sync API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
  would let the service worker flush the outbox in the background — even when
  the tab is closed — on browsers that support it (Chrome/Android, not Safari).
  The outbox already delivers reliably (per-field LWW makes a crash/lost-ack
  replay idempotent — see SPEC.md §Sync), so this is gated only on browser
  support and priority.

## Storage / dedup

- **Cross-feed item dedup.** Same-feed dupes (a publisher re-issuing the same
  URL under a new `<guid>`) are now collapsed by the `(feed_id, url)` partial
  unique index and the `upsert_feed_items` RPC (migration `0013`), with the URL
  first canonicalized (fragment + tracking params stripped) so cosmetic
  re-issues collapse too (migration `0048`, parser `canonicalizeItemUrl`). The
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

## Fetching / robots.txt

- **Consider honoring robots.txt on the poller and/or discovery fetches.**
  Today only the full-text reading-mode fetch consults robots.txt
  (`supabase/functions/_shared/robots.ts`, wired into `fulltext/index.ts`; see
  SPEC.md §"Full-text reading mode" and PR #271). The poller and `/discover`
  were deliberately left ungated — a subscribed feed URL is published *for*
  syndication, and discovery is a one-time, explicitly user-pasted URL — but
  whether to extend robots honoring to them is worth revisiting. Open
  questions / tradeoffs:
  - **Poller:** the recurring automated crawl is the most "crawler-like" path,
    so it's the strongest candidate for politeness. Risk: a publisher blanket
    `Disallow: /` (common for unknown bots) would park a feed the user
    explicitly subscribed to — arguably the wrong call for an opt-in feed
    reader. Would also want robots cached per-origin (a robots fetch per feed
    poll is wasteful) and a clear feed-health surface when a feed is parked for
    robots rather than an error.
  - **Discover:** user-initiated and one-shot; gating it could block a feed the
    user is actively trying to add, which is a worse UX than the politeness win.
  - **Shared seam:** if we do gate either, the clean home is a per-hop
    authorization hook in `safeFetch` (the shared SSRF funnel) rather than a
    per-caller re-check — that also closes the redirect-target gap the
    full-text path accepts as a residual today (one GET to a redirected
    disallowed URL before discarding; see the open thread on PR #271). Cons of
    the hook: it touches the shared security module every consumer routes
    through, must avoid re-entrancy (the robots fetch itself goes through
    `safeFetch`), and adds a robots fetch per hop without an origin cache.
  Revisit if a publisher complains, or when we next touch the poller's
  politeness logic (it already honors `Retry-After`/`ttl`).

## Server RPCs

- **Server-side subscription-scoped feed RPC for very large libraries.** Home/
  folder reads use `.in('feed_id', feedIds)`; a user with hundreds of
  subscriptions could exceed request-line limits. The scalable fix is the
  server-side subscription-scoped feed join (the `feed_items` RPC already covers
  the paged path). See `SupabaseDataSource.feedView` and SPEC.md §Data.

- **`feed_unread_ids` RPC for exact section badges.** The per-feed unread badge
  reads `getFeedUnreadCounts` (a server-only *count*), so it lags local triage by
  a sync round-trip. The client reconciles this with `UnreadDecrementLedger`
  (`src/lib/unreadAdjust.ts`): a dismissal's decrement applies immediately and
  holds until a count response that provably reflects the synced write lands, so
  the flicker at sync-completion (the badge bouncing to the stale count between
  outbox drain and count refetch — Codex P2 threads on PR #194) is gone. What
  remains approximate: a pinned-then-read row later marked Done lags until its
  write syncs (the conservative predicate can't tell it was server-counted); an
  Undo *after* the dismissal synced under-counts for one round-trip in the other
  direction; and a count fetch that starts pre-drain but is evaluated post-commit
  server-side double-discounts its item (badge one low) until the drain-triggered
  refetch lands — a bare count can't reveal whether it includes a given write. The exact fix is a `feed_unread_ids` RPC returning the
  per-feed unread **ID list** (~tens of KB; the listable set is already capped
  under the PostgREST row limit): the client holds the unread set and mutates it
  atomically with triage, so the badge is exact with no approximation at all.
  Backend migration + manual `make migrate`/`make deploy`; keep the client
  tolerant of the count-only backend until it lands. See SPEC.md §"Per-feed
  unread count" and PR #194.

## newshacker mirror

- **Event-driven newshacker → Readmo push (webhook + Realtime).** Deliberately
  deferred (2026-07): with newshacker's flush-on-hide upload and the cheap
  set-based reverse pull on every focus/PTR, pull-on-focus covers the
  single-device flow — staleness is only observable when the user looks at
  Readmo, which is exactly what triggers the pull. The two gaps pull can't
  close, and what each half buys if they ever matter: (1) *the handoff race*
  (return-focus pull vs newshacker's just-flushed upload) — mitigated by the
  PR #496 retry ladder; fully removed only by a webhook from newshacker's
  `/api/sync` POST handler to a new Readmo Edge Function (auth: the same
  linked bearer token; best-effort, the pull stays the reconciler);
  (2) *two screens visible at once* (Readmo already open + focused while
  triaging on newshacker elsewhere — no focus event ever fires) — needs
  Supabase Realtime on `item_state` (free tier: 200 concurrent connections,
  2M messages/mo — family-scale is nothing), which also gives
  Readmo↔Readmo cross-device instant updates on its own and is the half to
  build first. Rejected shape: a long-poll/pubsub endpoint on newshacker —
  Readmo's client can't hold the newshacker token (server-only by design),
  and Supabase Realtime already is the pubsub.

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

- **Promote a locally-pinned row the refreshed grouped read dropped
  entirely.** In the group-by-feed windowed view, PR #418 makes `mergedRaw`
  fill each section pinned-first over the whole *base run* (`items[]`), so a
  pin sitting outside the sticky window still renders. That covers the common
  case (the pin is in the read but past the window). It does **not** cover the
  live-path edge Codex flagged (#418 review, `discussion_r3539240069`): a row
  pinned **this session, before the outbox syncs the pin**, in a **busy** feed
  (≥ `PER_FEED_WINDOW+1` newer non-dismissed rows). There, the server
  `feed_items` read caps each feed to its newest N by date and — because the
  pin isn't server-side yet, so the "pinned, any age" branch (`0031` branch c)
  doesn't rescue it — the pinned older row is absent from `items[]` altogether;
  `SupabaseDataSource` overlays local *state* onto returned rows but can't
  re-insert an absent one. The pinned-first pass scans only `baseRun`, never
  `rowCacheRef`, so the row (still pinned in the local store, and cached from
  before the refresh) is dropped and its section can collapse to a phantom
  "More" until the next focus/resync re-pulls with the pin synced. Not the
  reported bug (that feed was sparse, so the pin was in the read). Fix options
  weighed: (a) **flush the outbox and await pending pins before PTR refetches**
  so the server returns the pin via branch c — cleanest, but adds PTR latency
  and changes the refresh contract (risk when offline); (b) **promote
  locally-pinned rows from `rowCacheRef` that the server dropped** — client-
  only, no latency, but carries a resurrection tradeoff (a pin genuinely
  removed on another device could linger until sync) and is more invasive to
  the windowing. Lean toward (a). See the code comment on the pinned-first pass
  in `ItemList.tsx`.

- **Consider scrolling the feed in an inner container to retire the
  dynamic-toolbar scroll-jump machinery.** The feed currently scrolls the
  *window*, so the reader's max scroll depends on `window.innerHeight` — the
  exact value Chromium's mobile dynamic toolbar momentarily doubles, which
  clamps `scrollY` and produces the bottom-of-list "scroll jump." A large
  subsystem in `ItemList.tsx` exists only to survive that: the min-height
  freeze, spike detection (`viewportIsHonest`/`layoutViewportHeight`), the
  spike-safe deferred hold + `deviceSpikesRef` latch, and the reactive restore
  (settle watch). If the feed instead scrolled inside its own
  `overflow-y: auto` region sized off a *stable* height (not the buggy viewport
  metric), the `innerHeight` spike wouldn't reach it and most of that code
  could be deleted. Cost: it loses native mobile URL-bar auto-hide and diverges
  from newshacker's window-scroll (guardrail #9), so it needs a real
  spike/experiment and a UX call, not a drive-by change. Raised while hardening
  the window-scroll path (PRs #405/#406). Weigh against option of just keeping
  the current, now-well-tested mechanism.

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

## Allowlist / gating

- **Close the direct-RPC Google News bypass.** `discover` is the authoritative
  Google News gate (real `new URL()` — see `_shared/googleNews.ts`), and it
  covers every normal subscribe path (Add-a-feed, OPML, curated catalog). The
  one remaining bypass is a *hand-crafted* direct `subscribe_to_feed(...)` RPC
  call with a Google News URL by a non-allowlisted caller while the allowlist is
  armed. An earlier attempt gated this **in SQL** inside `subscribe_to_feed`, but
  matching "is this Google News" requires real WHATWG/IDNA URL canonicalization
  (percent-encoding, control/space stripping, slash/backslash, Unicode dots, …)
  which a Postgres regex can't faithfully replicate — it turned into an unbounded
  series of normalization edge cases, so the SQL gate was removed. The correct
  fix is to do the canonical check in an **Edge layer** (where `new URL()`
  exists): e.g. route subscribes through a thin Edge function that canonicalizes
  + checks the allowlist before calling the RPC, or have the poller refuse to
  fetch a Google News feed for a feed with no allowlisted subscriber. Low
  priority — `discover` already covers the UI, and an empty allowlist is open to
  all. See `supabase/migrations/0028_allowlist_admin.sql` and SPEC *Feed
  discovery*.

