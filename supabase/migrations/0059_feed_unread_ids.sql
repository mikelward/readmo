-- Per-feed unread ITEM IDS for exact group-by-feed section-header badges.
--
-- The sibling of 0020's `feed_unread_counts`, returning the same listable-unread
-- SET — but as its member ids, not just the tally. A bare count can't tell the
-- client whether a given local triage write is already reflected in the number,
-- so the badge has to approximate the sync lag with a decrement ledger
-- (`src/lib/unreadAdjust.ts`), which leaves documented edge cases (a
-- pinned-then-read row later marked Done, an Undo after the dismissal synced, a
-- count evaluated between a write's commit and the client learning it drained).
-- With the ids in hand the client holds the unread set and re-derives the badge
-- from CURRENT local state every render — remove the ids local triage took out,
-- keep the pinned ones — so the badge is exact with no approximation at all.
--
-- Same candidate/filter logic as the CURRENT feed_unread_counts (0020, floor
-- recreated by 0031), so the two always agree (count = array length): the
-- listable set is the freshness window ∪ per-feed floor ∪ pinned, and an item is
-- unread/to-do when it is NOT Done or active Hidden and either pinned OR not
-- active Opened (each state TTL'd 30 days). A pinned item always counts (a pin
-- is a to-do, read or not); any other drops out once Opened. UNION dedups, so
-- each item appears once per feed. The floor is the newest 10 BY DATE
-- irrespective of state (0031) — NOT the newest 10 non-dismissed — so a feed
-- whose recent items are dismissed shrinks rather than backfilling an older
-- item, matching the list and the count exactly.
--
-- Bounded like feed_unread_counts: the candidate set per feed comes from
-- index-bounded scans (freshness range scan + a LATERAL that stops after 10 +
-- the pinned partial index), never a full-history rank. RLS: drives from
-- `subscriptions` gated on auth.uid(), so a caller only ever sees ids in feeds
-- they subscribe to. Response volume is the per-feed listable-unread set — a few
-- rows per feed for a normal reader (the client batches the feed-id list the
-- same way it does for the counts), well under any PostgREST row cap.
--
-- Cost/reliability: negligible — one bounded RPC per grouped page load, no new
-- infra or external calls.

create or replace function public.feed_unread_ids(p_feed_ids uuid[])
returns table (feed_id uuid, item_id uuid)
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
    -- The feed's listable item ids — the same three index-bounded sets the
    -- feed_unread_counts candidate set is built from (freshness window ∪ per-feed
    -- floor ∪ pinned).
    -- (a) freshness window — index range scan for the last 3 days.
    select i.id, sc.feed_id
    from scoped sc
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
    union
    -- (b) per-feed floor — newest 10 BY DATE, irrespective of state (LATERAL
    -- stops after 10). Dismissed items still occupy a slot; they're excluded by
    -- the unread predicate below, so a dismissed recent item is NOT backfilled
    -- by an older one. This mirrors the current feed_items / feed_unread_counts
    -- floor (0031, which superseded 0020's filter-then-limit floor) so the badge
    -- agrees exactly with the list and the count.
    select t.id, sc.feed_id
    from scoped sc
    cross join lateral (
      select i2.id
      from public.items i2
      where i2.feed_id = sc.feed_id
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
  -- Emit the listable ids that are unread/to-do: not Done and not active Hidden,
  -- and either pinned OR not active Opened — the exact predicate feed_unread_counts counts.
  select c.feed_id, c.id as item_id
  from cand c
  left join public.item_state s on s.item_id = c.id and s.user_id = auth.uid()
  where not (coalesce(s.done,   false) and s.done_at   > now() - interval '30 days')
    and not (coalesce(s.hidden, false) and s.hidden_at > now() - interval '30 days')
    and (coalesce(s.pinned, false)
         or not (coalesce(s.opened, false) and s.opened_at > now() - interval '30 days'));
$$;

comment on function public.feed_unread_ids(uuid[]) is
  'Per-feed unread ITEM IDS for the requested subscribed feeds: the member ids '
  'of the same listable-unread set feed_unread_counts (0020) tallies — items in '
  'the feed''s listable set (freshness window ∪ per-feed floor ∪ pinned) that are '
  'not Done, active Hidden, or active Opened (each TTL''d 30 days). Lets the '
  'group-by-feed section-header badge be exact: the client holds the set and '
  'reconciles local triage atomically instead of approximating the count-lag. '
  'Index-bounded like feed_items (0018); drives from subscriptions (RLS).';

revoke execute on function public.feed_unread_ids(uuid[]) from public;
grant  execute on function public.feed_unread_ids(uuid[]) to authenticated;
