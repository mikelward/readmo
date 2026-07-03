-- Add a subscriber count to the /admin/feeds console.
--
-- The operator wants to see how many users subscribe to each system feed. That's
-- a count of `subscriptions` rows per feed — which the admin RPC can read across
-- all users (it's SECURITY DEFINER; a normal client can only see its own
-- subscriptions under RLS). Append it to admin_list_feeds.
--
-- Adding an OUT column changes the function's return type, which `create or
-- replace` can't do — so drop and recreate (re-granting after, since DROP clears
-- grants). Body is otherwise identical to 0040's admin_list_feeds.

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
  'per feed with fetch-health fields (last_fetched_at, next_fetch_at, '
  'error_count, last_error), the feed''s subscriber_count (count of subscriptions '
  'across all users), plus a single sample item — the article in the feed with '
  'the most recent reading-mode download attempt — its cached-body presence and '
  'that attempt (status / HTTP code / error / robots rule / when) from '
  'item_fulltext_status. Null sample columns mean the feed has no recorded '
  'attempt. Fails closed for non-admins (42501).';

revoke execute on function public.admin_list_feeds() from public;
grant  execute on function public.admin_list_feeds() to authenticated;
