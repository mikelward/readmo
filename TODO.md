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
