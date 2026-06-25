-- Add the feed freshness window + per-feed floor to the feed_items RPC.
--
-- List requests (home / folder / single feed) serve an item when it is pinned,
-- OR younger than 3 days (the freshness window — "recent items only"), OR among
-- its feed's newest 10 non-dismissed items (the per-feed floor). The window
-- declutters busy feeds; the floor keeps an infrequently-updated feed from going
-- blank when nothing it published is recent (SPEC.md *Feed freshness window*).
-- Pinned items are EXEMPT from both and stay regardless of age.
-- Done/Hidden exclusion and the Pinned-first ordering are unchanged from 0016.
--
-- Performance: the body is assembled from three INDEX-BOUNDED candidate sets
-- (each an `items_feed_sort_idx` (feed_id, sort_at desc) scan) rather than by
-- ranking a feed's full history with a window function — so a user subscribed to
-- a feed with years of archived items only touches ~(items in last 3 days) +
-- 10 + (pins) rows per feed per page, not the whole archive:
--   (a) freshness window — index range scan for sort_at > now() - 3 days;
--   (b) per-feed floor — a LATERAL that walks the index newest-first and stops
--       after 10 non-dismissed matches;
--   (c) pinned items — the item_state pinned partial index.
-- Done/Hidden are TTL'd (30 days) to match the client's withRetention; "newest
-- 10 non-dismissed" therefore treats an EXPIRED Done/Hidden flag as eligible
-- (e.g. a reissued GUID back inside the window re-enters), consistent with the
-- body filter below.
--
-- The signature is identical to 0016's 7-arg form — a plain CREATE OR REPLACE
-- (no DROP, grants preserved). Mirrors the client: src/lib/data/MockDataSource.ts
-- (orderedFor) and the HOME_WINDOW_MS / FEED_FLOOR constants in
-- src/lib/types.ts. Keep all three in sync if the window or floor changes.

create or replace function public.feed_items(
  p_scope          text,
  p_folder         text    default null,
  p_feed_id        uuid    default null,
  p_limit          int     default 30,
  p_offset         int     default 0,
  p_sort           text    default 'newest',
  p_group_by_feed  boolean default false
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
    -- Done and Hidden are TTL'd (30 days) to match the client's withRetention:
    -- once the timestamp ages out the flag stops suppressing the item, so an
    -- expired-Done item back inside the freshness window re-enters the feed
    -- instead of staying excluded forever (SPEC.md *Retention*).
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
    -- NOT window/floor-filtered — a pin keeps an item regardless of age. Every
    -- candidate is pinned XOR body (the body branch excludes is_pinned), so no
    -- row is emitted twice.
    select i, 0 as pin_rank, pinned_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from rows where is_pinned is true
    union all
    select i, 1 as pin_rank, (i).sort_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from rows
    where is_pinned is not true and not is_done and not is_hidden
  )
  -- Strip the full-article body from list rows (see 0011); the reader reads it
  -- via getItem instead. jsonb_populate_record keeps all other columns from `i`.
  select
    jsonb_populate_record(i, jsonb_build_object('full_content_html', null::text))
  from combined
  order by
    group_ord asc nulls last,                                                     -- grouped: feed section in custom order (inert when flat: all null)
    pin_rank asc,                                                                 -- pinned before body (within the section when grouped, globally when flat)
    case when pin_rank = 0 then ord_at end asc  nulls last,                       -- pinned: oldest pin first
    case when pin_rank = 1 and p_sort = 'oldest' then ord_at end asc  nulls last, -- body oldest-first
    case when pin_rank = 1 and p_sort <> 'oldest' then ord_at end desc nulls last,-- body newest-first (default)
    (i).id desc
  limit  greatest(coalesce(p_limit, 30), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.feed_items(text, text, uuid, int, int, text, boolean) is
  'Server-side subscription-scoped feed: one combined, paged sequence (Pinned '
  'oldest-first, then body by sort_at with Done/Hidden excluded). The body '
  'serves items younger than 3 days OR among their feed''s newest 10 (freshness '
  'window ∪ per-feed floor); Pinned items are exempt and stay regardless of age. '
  'The body is built from index-bounded candidate sets (freshness range scan + a '
  'per-feed top-10 LATERAL + the pinned partial index), so cost scales with '
  'recent/kept rows per feed, not a feed''s full archive. p_sort flips the body '
  'to oldest-first; p_group_by_feed sections the body by feed in the user''s '
  'custom subscription order, with each feed''s pinned items at the top of that '
  'section (flat keeps a single global pinned section) — all applied server-side '
  'so they hold across pages. Page 1 is bounded to p_limit total rows. '
  'full_content_html is nulled here; the reader loads the full body via the '
  'single-item path. No total count: the client pages off whether the last page '
  'came back full.';
