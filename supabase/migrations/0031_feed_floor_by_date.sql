-- Per-feed floor = the feed's newest N items BY DATE, irrespective of state.
--
-- Both feed_items (the list, last recreated in 0026) and feed_unread_counts
-- (the group-by-feed badge, 0020) built their per-feed floor from the newest 10
-- *non-dismissed* items: the LATERAL filtered Done/Hidden out BEFORE the
-- `limit 10`. That made the floor slide — marking a recent item Done pulled the
-- next older non-dismissed item up into the floor, so a feed never showed fewer
-- than ~10 unread items (and the badge stuck at 10) no matter how many of its
-- recent items you triaged. You'd mark several Done, fetch more, and the count
-- read 10 again.
--
-- The floor is meant to keep a *quiet* feed from going blank — "always show its
-- latest handful" — not to top a busy feed back up to 10 unread as you read it.
-- So the floor is now the feed's newest N items by date, period: the LATERAL no
-- longer joins item_state, it just takes the newest 10 by (sort_at desc, id
-- desc). Done/Hidden items still occupy their recency slot; they're filtered
-- from the body (feed_items) and excluded from the count (feed_unread_counts)
-- afterward, exactly as before. Net effect: dismissing a recent item no longer
-- backfills an older one, so the list shrinks and the badge counts down as you
-- triage — and if a feed's newest 10 are all Done, it serves/counts nothing more
-- (pins and in-window items aside).
--
-- Still index-bounded: the LATERAL stops after 10 index rows (sort_at desc), so
-- cost is unchanged. `create or replace` with the identical signatures keeps the
-- existing grants; only branch (b) of each candidate set changes.
--
-- Cost/reliability: negligible — same two bounded RPCs, no new infra or calls.

create or replace function public.feed_items(
  p_scope          text,
  p_folder         text    default null,
  p_feed_id        uuid    default null,
  p_limit          int     default 30,
  p_offset         int     default 0,
  p_sort           text    default 'newest',
  p_group_by_feed  boolean default false,
  p_per_feed_limit int     default null
)
returns table (item public.items)
language sql
security definer
set search_path = ''
as $$
  with scoped as (
    -- The caller's in-scope subscriptions (feed id + section ordinal). Driving
    -- from subscriptions — not items — is what keeps every lookup below bounded.
    -- The 'feed' scope intentionally includes a muted feed's own page.
    select s.feed_id, s.sort as feed_sort
    from public.subscriptions s
    where s.user_id = auth.uid()
      and case p_scope
            when 'home'   then not s.muted
            when 'folder' then not s.muted and s.folder is not distinct from p_folder
            when 'feed'   then s.feed_id = p_feed_id
            else false
          end
  ),
  cand as (
    -- (a) Freshness window: items newer than 3 days (index range scan).
    select i.id
    from scoped sc
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
    union
    -- (b) Per-feed floor: the feed's newest 10 items BY DATE, irrespective of
    -- read/done state. The lateral walks items_feed_sort_idx newest-first and
    -- stops after 10 rows, so an archive of years costs ~10 index rows per feed.
    -- Done/Hidden items still consume a floor slot here; they're dropped from the
    -- body in `combined` below — so dismissing a recent item shrinks the feed
    -- rather than pulling an older item up to refill the floor.
    select t.id
    from scoped sc
    cross join lateral (
      select i2.id
      from public.items i2
      where i2.feed_id = sc.feed_id
      order by i2.sort_at desc, i2.id desc
      limit 10
    ) t
    union
    -- (c) Pinned items, any age — a pin must never be dropped by window/floor
    -- (item_state pinned partial index).
    select st.item_id as id
    from public.item_state st
    join public.items i on i.id = st.item_id
    join scoped sc on sc.feed_id = i.feed_id
    where st.user_id = auth.uid() and st.pinned
  ),
  rows as (
    -- Re-hydrate the bounded id set with each item's row + the caller's state.
    -- Done and Hidden are TTL'd (30 days) to match the client's withRetention.
    select i, st.pinned as is_pinned, st.pinned_at,
           (coalesce(st.done, false)
              and st.done_at > now() - interval '30 days') as is_done,
           (coalesce(st.hidden, false)
              and st.hidden_at > now() - interval '30 days') as is_hidden,
           sc.feed_sort
    from cand
    join public.items i on i.id = cand.id
    join scoped sc on sc.feed_id = i.feed_id
    left join public.item_state st
      on st.item_id = i.id and st.user_id = auth.uid()
  ),
  combined as (
    -- pin_rank 0 = Pinned (oldest-pin first), 1 = body. group_ord is the feed's
    -- custom section ordinal when grouping, else null (so it's inert and the
    -- ORDER BY falls through to the global pinned-then-body layout). Pinned is
    -- NOT window/floor-filtered. Every candidate is pinned XOR body, so no row is
    -- emitted twice.
    select i, 0 as pin_rank, pinned_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from rows where is_pinned is true
    union all
    select i, 1 as pin_rank, (i).sort_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from rows
    where is_pinned is not true and not is_done and not is_hidden
  ),
  ranked as (
    -- Per-section rank, in the SAME within-section order the rows are emitted
    -- (pinned-first, then body by p_sort). Used to window each feed to its
    -- newest p_per_feed_limit rows when grouping. Partition by the actual
    -- feed id — NOT group_ord (the subscription `sort` ordinal) — so two
    -- subscriptions that happen to share a sort value can't be ranked as one
    -- window, where the first feed could consume the whole cap and drop the
    -- other from the opening read entirely. group_ord stays for section
    -- ORDERING only. On the flat river the cap is bypassed below, so the rank is
    -- inert there.
    select i, pin_rank, ord_at, group_ord,
           row_number() over (
             partition by (i).feed_id
             order by
               pin_rank asc,
               case when pin_rank = 0 then ord_at end asc  nulls last,
               case when pin_rank = 1 and p_sort = 'oldest' then ord_at end asc  nulls last,
               case when pin_rank = 1 and p_sort <> 'oldest' then ord_at end desc nulls last,
               (i).id desc
           ) as feed_rn
    from combined
  )
  -- Strip the gated full-text fields from list rows: the full-article body (see
  -- 0011) AND its fallback-provenance flag (0025), so neither reaches a list
  -- read. The reader gets both only via the allowlist-gated `fulltext` function.
  select
    jsonb_populate_record(
      i,
      jsonb_build_object(
        'full_content_html', null::text,
        'full_content_via_fallback', null::boolean
      )
    )
  from ranked
  where p_per_feed_limit is null
     or not coalesce(p_group_by_feed, false)
     or feed_rn <= p_per_feed_limit
  order by
    group_ord asc nulls last,                                                     -- grouped: feed section in custom order (inert when flat: all null)
    case when p_group_by_feed then (i).feed_id end asc nulls last,                -- grouped: keep a feed's rows contiguous even if two feeds share a sort ordinal (inert when flat)
    pin_rank asc,                                                                 -- pinned before body (within the section when grouped, globally when flat)
    case when pin_rank = 0 then ord_at end asc  nulls last,                       -- pinned: oldest pin first
    case when pin_rank = 1 and p_sort = 'oldest' then ord_at end asc  nulls last, -- body oldest-first
    case when pin_rank = 1 and p_sort <> 'oldest' then ord_at end desc nulls last,-- body newest-first (default)
    (i).id desc
  limit  greatest(coalesce(p_limit, 30), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.feed_items(text, text, uuid, int, int, text, boolean, int) is
  'Server-side subscription-scoped feed: one combined, paged sequence (Pinned '
  'oldest-first, then body by sort_at with Done/Hidden excluded). The body '
  'serves items younger than 3 days OR among their feed''s newest 10 by date '
  '(freshness window ∪ per-feed floor); Pinned items are exempt and stay '
  'regardless of age. The floor ranks by date irrespective of state, so a '
  'dismissed recent item is dropped without backfilling an older one. The body '
  'is built from index-bounded candidate sets, so cost scales with recent/kept '
  'rows per feed, not a feed''s full archive. p_sort flips the body to '
  'oldest-first; p_group_by_feed sections the body by feed in the user''s custom '
  'subscription order, with each feed''s pinned items at the top of that section. '
  'p_per_feed_limit (grouping only) caps each section to its newest that-many '
  'rows for the group-by-feed opening view; the per-section "More" pages deeper '
  'via the ''feed'' scope with an offset. Page 1 is bounded to p_limit total '
  'rows. full_content_html and full_content_via_fallback are nulled here; the '
  'reader loads the full body (and learns its provenance) via the allowlist-'
  'gated single-item fulltext path. No total count: the client pages off whether '
  'the last page came back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;


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
    -- The feed's listable item ids — the same three index-bounded sets the
    -- feed_items body is built from (freshness window ∪ per-feed floor ∪ pinned).
    -- (a) freshness window — index range scan for the last 3 days.
    select i.id, sc.feed_id
    from scoped sc
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
    union
    -- (b) per-feed floor — newest 10 BY DATE, irrespective of state (LATERAL
    -- stops after 10). Dismissed items still occupy a slot; they're excluded
    -- from the count filter below, so a dismissed recent item is no longer
    -- backfilled by an older one (which is what stuck the badge at 10).
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
  'active Hidden, or active Opened (each TTL''d 30 days). The floor is the feed''s '
  'newest 10 by date, irrespective of state, so dismissing a recent item counts '
  'the badge down instead of backfilling an older item to keep it at 10. '
  'Index-bounded like feed_items (0018); drives from subscriptions (RLS). Used by '
  'the group-by-feed section-header badge so a collapsed feed still shows what is '
  'unread.';

revoke execute on function public.feed_unread_counts(uuid[]) from public;
grant  execute on function public.feed_unread_counts(uuid[]) to authenticated;
