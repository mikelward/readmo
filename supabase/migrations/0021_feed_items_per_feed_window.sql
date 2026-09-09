-- Add a per-feed window to the feed_items RPC for the group-by-feed view.
--
-- The group-by-feed view opens each feed section showing only its newest few
-- listable rows, with a per-section "More" that pages deeper into that one feed
-- (SPEC.md *Group by feed → per-section More*). To serve the opening view in a
-- single read, feed_items gains `p_per_feed_limit`: when grouping, each feed's
-- section is capped to its newest `p_per_feed_limit` rows (pinned-first, then
-- body in the chosen order — the same within-section ordering the view renders).
-- The per-section "More" then re-reads that one feed via the existing 'feed'
-- scope with an offset, so the other sections are never refetched.
--
-- p_per_feed_limit only applies when p_group_by_feed is true; on the flat river
-- and the single-feed page it's null/ignored and paging stays global (p_limit /
-- p_offset), so this is a no-op for every existing caller. Mirrors the client:
-- src/lib/data/MockDataSource.ts (orderedFor's per-feed cap) and PER_FEED_WINDOW
-- in src/lib/types.ts — keep them in sync.
--
-- Cost: the cap is a row_number() over the ALREADY index-bounded candidate set
-- (window ∪ floor ∪ pinned per feed, as 0018), not a scan of any feed's archive,
-- so it adds only an ordering pass over the bounded set — negligible. The grouped
-- windowed read returns all sections in one response; the caller bounds the
-- number of feeds (and PostgREST caps the response at 1000 rows) so the product
-- feeds × p_per_feed_limit stays well under that.
--
-- Adds an 8th parameter, so (like 0016) drop the 7-arg form first, then recreate
-- and re-grant.

drop function if exists public.feed_items(text, text, uuid, int, int, text, boolean);

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
    -- (b) Per-feed floor: the feed's newest 10 NON-DISMISSED items. The lateral
    -- walks items_feed_sort_idx newest-first and stops after 10 matches, so an
    -- archive of years costs ~10 index rows per feed, not a full-partition sort.
    -- Dismissed = Done or (Hidden within its 30-day TTL); an EXPIRED flag counts
    -- as eligible, matching is_done/is_hidden below and the client.
    select t.id
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
  -- Strip the full-article body from list rows (see 0011); the reader reads it
  -- via getItem instead.
  select
    jsonb_populate_record(i, jsonb_build_object('full_content_html', null::text))
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
  'serves items younger than 3 days OR among their feed''s newest 10 (freshness '
  'window ∪ per-feed floor); Pinned items are exempt and stay regardless of age. '
  'The body is built from index-bounded candidate sets, so cost scales with '
  'recent/kept rows per feed, not a feed''s full archive. p_sort flips the body '
  'to oldest-first; p_group_by_feed sections the body by feed in the user''s '
  'custom subscription order, with each feed''s pinned items at the top of that '
  'section. p_per_feed_limit (grouping only) caps each section to its newest '
  'that-many rows for the group-by-feed opening view; the per-section "More" '
  'pages deeper via the ''feed'' scope with an offset. Page 1 is bounded to '
  'p_limit total rows. full_content_html is nulled here; the reader loads the '
  'full body via the single-item path. No total count: the client pages off '
  'whether the last page came back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;
