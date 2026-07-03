-- Pause a feed from the /admin/feeds console.
--
-- Pausing a feed stops all server-side work for it: the cron poller skips it
-- (via feeds_due_for_poll, recreated below to also exclude paused feeds),
-- on-demand refresh no-ops, and reading-mode full-text downloads + AI summaries
-- are declined for its items (each honored in its own Edge Function). Already-
-- stored articles stay readable — pause only halts NEW fetching/enrichment.
--
-- The flag is a single boolean on the shared feed row, toggled by an admin-only
-- RPC (is_admin fail-closed, like every other admin RPC). It's surfaced to the
-- console by appending `paused` to admin_list_feeds; normal clients never read it
-- (feeds_public doesn't project it).

alter table public.feeds
  add column if not exists paused boolean not null default false;

-- Admin-only toggle.
create or replace function public.admin_set_feed_paused(
  p_feed_id uuid,
  p_paused  boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  update public.feeds set paused = coalesce(p_paused, false) where id = p_feed_id;
end;
$$;

comment on function public.admin_set_feed_paused(uuid, boolean) is
  'Admin-only (is_admin) toggle of a feed''s paused flag for /admin/feeds. When '
  'paused, the poller/refresh skip the feed and full-text/summary decline its '
  'items (each enforced in its own Edge Function); stored articles stay readable. '
  'Fails closed for non-admins (42501).';

revoke execute on function public.admin_set_feed_paused(uuid, boolean) from public;
grant  execute on function public.admin_set_feed_paused(uuid, boolean) to authenticated;

-- Recreate admin_list_feeds with `paused` appended. Adding an OUT column changes
-- the return type (create-or-replace can't), so drop + recreate + re-grant.
-- Body is identical to 0041's plus the `paused` column.
drop function if exists public.admin_list_feeds();

create function public.admin_list_feeds()
returns table (
  id                uuid,
  title             text,
  site_url          text,
  favicon_url       text,
  last_fetched_at   timestamptz,
  next_fetch_at     timestamptz,
  error_count       int,
  last_error        text,
  paused            boolean,
  subscriber_count  int,
  sample_item_id    uuid,
  sample_item_title text,
  sample_has_full_content   boolean,
  sample_download_status    text,
  sample_download_http      int,
  sample_download_error     text,
  sample_download_robots_rule text,
  sample_download_at        timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  return query
    -- NB: `feeds.url` (the fetch URL, possibly subscriber-tokenized — 0002/0004,
    -- guardrail #7) is deliberately NOT returned: this RPC is read by the browser
    -- admin page, so only display-safe metadata (site_url/title/favicon) leaves
    -- the server. The sample's `items.url` is likewise omitted (unused by the UI).
    select
      f.id,
      f.title,
      f.site_url,
      f.favicon_url,
      f.last_fetched_at,
      f.next_fetch_at,
      coalesce(f.error_count, 0)::int,
      f.last_error,
      f.paused,
      coalesce(subs.subscriber_count, 0) as subscriber_count,
      s.id,
      s.title,
      (s.full_content_html is not null) as sample_has_full_content,
      s.status,
      s.http_status,
      s.error,
      s.robots_rule,
      s.attempted_at
    from public.feeds f
    -- Subscriber counts, aggregated in ONE pass over subscriptions (a correlated
    -- per-feed count() would seq-scan subscriptions once per feed — there's no
    -- feed_id-bounded index; the PK leads with user_id — so cost would grow as
    -- feeds × subscriptions). This scans subscriptions once regardless of feed
    -- count. A feed nobody subscribes to has no row here → coalesced to 0.
    left join (
      select feed_id, count(*)::int as subscriber_count
      from public.subscriptions
      group by feed_id
    ) subs on subs.feed_id = f.id
    -- The sample article: the item in this feed with the most recent recorded
    -- reading-mode download attempt. A recorded attempt implies an allowlisted
    -- fetch, so no pin/allowlist filter is needed. A feed with no attempt yields
    -- a null sample → the client's "not tried" status.
    left join lateral (
      select
        i.id, i.title, i.full_content_html,
        fs.status, fs.http_status, fs.error, fs.robots_rule, fs.attempted_at
      from public.item_fulltext_status fs
      join public.items i on i.id = fs.item_id
      where i.feed_id = f.id
      order by fs.attempted_at desc, fs.item_id desc
      limit 1
    ) s on true
    order by f.title asc nulls last, f.id asc;
end;
$$;

comment on function public.admin_list_feeds() is
  'Admin-only (is_admin) system-wide feed-status read for /admin/feeds: one row '
  'per feed with fetch-health fields, the paused flag, subscriber_count, plus a '
  'single sample item (most recent reading-mode download attempt) and its cached-'
  'body presence + attempt details. Fails closed for non-admins (42501).';

revoke execute on function public.admin_list_feeds() from public;
grant  execute on function public.admin_list_feeds() to authenticated;

-- The cron's batch selection (0044) also excludes paused feeds. Same signature,
-- so `create or replace` keeps the existing grants; body is identical to 0044's
-- plus `and not f.paused`.
create or replace function public.feeds_due_for_poll(p_limit integer)
returns table (
  id               uuid,
  url              text,
  secret_url       text,
  etag             text,
  last_modified    text,
  fetch_interval_s integer,
  error_count      integer,
  favicon_url      text
)
language sql
security definer
set search_path = ''
as $$
  select f.id, f.url, f.secret_url, f.etag, f.last_modified,
         f.fetch_interval_s, f.error_count, f.favicon_url
  from public.feeds f
  where f.next_fetch_at <= now()
    and not f.paused
    and exists (
          select 1 from public.subscriptions s where s.feed_id = f.id
        )
  order by f.next_fetch_at asc
  limit p_limit;
$$;

comment on function public.feeds_due_for_poll(integer) is
  'Poll-batch selection for the cron: the p_limit most-overdue feeds '
  '(next_fetch_at <= now()) that are NOT paused and still have >= 1 subscriber, '
  'newest-overdue first. Returns the poller''s columns incl. the server-only '
  'fetch URLs, so it is service-role-only. Skips paused feeds (0046) and '
  'zero-subscriber feeds (incl. those kept alive by a pin/favorite/done).';

revoke execute on function public.feeds_due_for_poll(integer) from public;
grant  execute on function public.feeds_due_for_poll(integer) to service_role;
