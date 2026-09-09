-- Readmo items.sort_at — effective sort key for the feed/search hot path.
--
-- Feeds that omit or garble dates leave `published_at` null. The client maps an
-- item's date as `published_at ?? created_at`, so the server-side ordering must
-- match, otherwise freshly-fetched undated items sort last (by UUID) and get
-- buried instead of surfacing at the top.
--
-- Delivered as a forward migration (not an edit to 0001) because 0001 has
-- already shipped/applied; editing a `create table if not exists` would not add
-- the column to existing databases, and the reads now order by `sort_at`.
alter table public.items
  add column if not exists sort_at timestamptz
    generated always as (coalesce(published_at, created_at)) stored;

-- The hot feed query drives from items by (feed_id, sort_at desc); replace the
-- old published_at index, which the reads no longer use.
create index if not exists items_feed_sort_idx
  on public.items (feed_id, sort_at desc);
drop index if exists public.items_feed_published_idx;
