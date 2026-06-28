-- Index the poller's feed-selection predicate.
--
-- The cron poller (supabase/functions/poll) selects the feeds due for a fetch
-- with `where next_fetch_at <= now() limit 25`. `feeds` carried only its primary
-- key and the unique(url) index, so that predicate had no index to ride: every
-- poll cycle sequential-scanned the whole table to find due rows, and that scan
-- grows with every feed ever added (feeds are shared and never auto-removed) —
-- precisely the cost the freshness design is meant to avoid on the read path.
--
-- A plain btree on next_fetch_at lets Postgres range-scan straight to the due
-- rows (and, with the poller's `order by next_fetch_at asc`, return the most
-- overdue first) and stop after the batch limit, so poll cost tracks the number
-- of *due* feeds, not the total feed count. next_fetch_at is NOT NULL (default
-- now()), so no partial predicate is needed.
--
-- Cost/reliability: negligible — one small btree (8 bytes/row), maintained on
-- the poller's own next_fetch_at writes; no new infra or external calls.

create index if not exists feeds_next_fetch_idx
  on public.feeds (next_fetch_at);
