-- Add the feed freshness window + per-feed floor to the feed_items RPC.
--
-- List requests (home / folder / single feed) serve an item when it is pinned,
-- OR younger than 3 days (the freshness window — "recent items only"), OR among
-- its feed's newest 10 non-dismissed items (the per-feed floor). The window
-- declutters busy feeds; the floor keeps an infrequently-updated feed from going
-- blank when nothing it published is recent (SPEC.md *Feed freshness window*).
-- Pinned items are EXEMPT from both and stay regardless of age, so the
-- window/floor live only in the body branch of `combined`, never the pinned one.
-- Done/Hidden exclusion and the Pinned-first ordering are unchanged from 0016.
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
    select i, st.pinned as is_pinned, st.pinned_at,
           -- Done and Hidden are both TTL'd (30 days), matching the client's
           -- withRetention: once the timestamp ages out the flag stops
           -- suppressing the item. This matters when an expired-Done item is
           -- back inside the freshness window (e.g. a reissued GUID whose
           -- published_at the poller refreshed) — it must re-enter the feed,
           -- not stay excluded forever (SPEC.md *Retention*).
           (coalesce(st.done, false)
              and st.done_at > now() - interval '30 days') as is_done,
           (coalesce(st.hidden, false)
              and st.hidden_at > now() - interval '30 days') as is_hidden,
           -- Section ordinal for the optional group-by-feed view: the user's
           -- custom subscription order (drag-to-reorder), so sections match the
           -- order shown in Settings and the drawer.
           s.sort as feed_sort
    from public.items i
    join public.subscriptions s
      on s.feed_id = i.feed_id and s.user_id = auth.uid()
    left join public.item_state st
      on st.item_id = i.id and st.user_id = auth.uid()
    where
      case p_scope
        when 'home'   then not s.muted
        when 'folder' then not s.muted and s.folder is not distinct from p_folder
        when 'feed'   then i.feed_id = p_feed_id
        else false
      end
  ),
  ranked as (
    -- Rank each non-dismissed item within its feed, newest first, so the body
    -- floor can keep a feed's most recent items even when they're old. Done/
    -- Hidden are excluded from the pool here (they never count toward the floor
    -- and never appear in the body); pinned items stay in the pool so they're
    -- ranked consistently with the client, then are emitted by their own branch.
    select scoped.*,
           row_number() over (
             partition by (i).feed_id
             order by (i).sort_at desc nulls last, (i).id desc
           ) as feed_rank
    from scoped
    where not is_done and not is_hidden
  ),
  combined as (
    -- pin_rank 0 = Pinned (oldest-pin first), 1 = body. group_ord is the feed's
    -- custom section ordinal when grouping, else null (so it's inert and the
    -- ORDER BY falls through to the global pinned-then-body layout). Pinned is
    -- NOT window/floor-filtered — a pin keeps an item in the list regardless of age.
    select i, 0 as pin_rank, pinned_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from ranked where is_pinned is true
    union all
    select i, 1 as pin_rank, (i).sort_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from ranked
    where is_pinned is not true
      -- Body = freshness window ∪ per-feed floor: items younger than 3 days, OR
      -- among the feed's newest 10 (SPEC.md *Feed freshness window*). Pinned
      -- (the branch above) is exempt. Mirrors MockDataSource.orderedFor /
      -- HOME_WINDOW_MS + FEED_FLOOR.
      and ((i).sort_at > now() - interval '3 days' or feed_rank <= 10)
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
  'p_sort flips the body to oldest-first; '
  'p_group_by_feed sections the body by feed in the user''s custom subscription '
  'order, with each feed''s pinned items at the top of that section (flat keeps a '
  'single global pinned section) — all applied server-side so they hold across '
  'pages. Page 1 is bounded to p_limit total rows. full_content_html is nulled '
  'here; the reader loads the full body via the single-item path. No total '
  'count: the client pages off whether the last page came back full.';
