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
