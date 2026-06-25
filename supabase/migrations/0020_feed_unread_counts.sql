-- Per-feed unread count for the group-by-feed section headers.
--
-- Returns, for each requested subscribed feed, how many of its items are
-- currently UNREAD / TO-DO: in the feed's listable set (freshness window ∪
-- per-feed floor ∪ pinned), NOT Done or active Hidden, and either pinned OR not
-- active Opened. A pinned item always counts (a pin is a to-do, read or not);
-- any other item drops out once Opened. Mirrors the client seam
-- (MockDataSource.getFeedUnreadCounts) and the same window/floor/retention the
-- feed_items list uses (0018), so the badge agrees with the list.
--
-- Bounded like 0018: the candidate set per feed is assembled from index-bounded
-- scans (freshness range scan + a LATERAL that stops after 10 non-dismissed +
-- the pinned partial index), never a full-history rank — so the count is cheap
-- even for a feed with years of archive. RLS: drives from `subscriptions`
-- gated on auth.uid(), so a caller only ever counts feeds they're subscribed to.
--
-- Cost/reliability: negligible — one bounded RPC per grouped page load, no new
-- infra or external calls.

create or replace function public.feed_unread_counts(p_feed_ids uuid[])
returns table (feed_id uuid, n bigint)
language sql
security definer
set search_path = ''
as $$
  with scoped as (
    -- The caller's own subscriptions among the requested feeds (RLS boundary).
    select s.feed_id
    from public.subscriptions s
    where s.user_id = auth.uid()
      and s.feed_id = any(p_feed_ids)
  ),
  cand as (
    -- The feed's listable item ids — the same three index-bounded sets 0018's
    -- body is built from (freshness window ∪ per-feed floor ∪ pinned).
    -- (a) freshness window — index range scan for the last 3 days.
    select i.id, sc.feed_id
    from scoped sc
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
    union
    -- (b) per-feed floor — newest 10 NON-DISMISSED (LATERAL stops after 10).
    select t.id, sc.feed_id
    from scoped sc
    cross join lateral (
      select i2.id
      from public.items i2
      left join public.item_state d
        on d.item_id = i2.id and d.user_id = auth.uid()
      where i2.feed_id = sc.feed_id
        and not (coalesce(d.done,   false) and d.done_at   > now() - interval '30 days')
        and not (coalesce(d.hidden, false) and d.hidden_at > now() - interval '30 days')
      order by i2.sort_at desc, i2.id desc
      limit 10
    ) t
    union
    -- (c) pinned, any age.
    select st.item_id as id, i.feed_id
    from public.item_state st
    join public.items i on i.id = st.item_id
    join scoped sc on sc.feed_id = i.feed_id
    where st.user_id = auth.uid() and st.pinned
  )
  select
    sc.feed_id,
    -- Count the listable items that are unread/to-do: not Done and not active
    -- Hidden, and either pinned OR not active Opened — a pinned item always
    -- counts (a pin is a to-do, read or not); other items drop out once Opened.
    -- (Done/Hidden/Opened each TTL'd at 30 days, matching withRetention / 0018.)
    -- count(c.id) ignores the NULL produced for a feed with no candidates → 0.
    count(c.id) filter (
      where not (coalesce(s.done,   false) and s.done_at   > now() - interval '30 days')
        and not (coalesce(s.hidden, false) and s.hidden_at > now() - interval '30 days')
        and (coalesce(s.pinned, false)
             or not (coalesce(s.opened, false) and s.opened_at > now() - interval '30 days'))
    ) as n
  from scoped sc
  left join cand c on c.feed_id = sc.feed_id
  left join public.item_state s on s.item_id = c.id and s.user_id = auth.uid()
  group by sc.feed_id;
$$;

comment on function public.feed_unread_counts(uuid[]) is
  'Per-feed unread count for the requested subscribed feeds: items in the feed''s '
  'listable set (freshness window ∪ per-feed floor ∪ pinned) that are not Done, '
  'active Hidden, or active Opened (each TTL''d 30 days). Index-bounded like '
  'feed_items (0018); drives from subscriptions (RLS). Used by the group-by-feed '
  'section-header badge so a collapsed feed still shows what is unread.';

revoke execute on function public.feed_unread_counts(uuid[]) from public;
grant  execute on function public.feed_unread_counts(uuid[]) to authenticated;
