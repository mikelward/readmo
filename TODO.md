# TODO

Deferred work, tracked here so it isn't lost. Each item links to where the
constraint is documented in more detail.

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

## Dev / diagnostics

- **Debug page — shipped** (`/debug`, `src/pages/DebugPage.tsx`): build id
  (commit-count build number on production, short SHA on preview/local), backend
  mode + project ref, auth status, live `item_state`/`feeds_public` read pings
  (so a 42501/JWT problem shows immediately), and service-worker/cache state.
  Possible follow-ups: gate behind a signed-in or dev-only check (open to all for
  now); add a Vercel deployment-id row; surface the cron poller's last run.

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
