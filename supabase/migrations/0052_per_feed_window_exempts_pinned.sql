-- Exempt pinned rows from the group-by-feed per-feed window.
--
-- The grouped opening read caps each feed's section to its newest
-- p_per_feed_limit rows (0021). That cap counted PINNED rows too: because a
-- section is emitted pinned-first, every pin consumed a window slot, so a
-- section with 3 pins opened with only 7 articles, and one with 10+ pins opened
-- with no articles at all. The product intent (SPEC.md *Per-section More +
-- per-feed window*) is that a refresh shows each feed's pins AND its newest
-- articles: pins are a to-do list, not a substitute for the news.
--
-- So rank each feed's pinned block and body separately (partition by feed_id +
-- pin_rank) and apply p_per_feed_limit to the BODY rows only; pinned rows
-- always survive the window, exactly as they already survive the freshness
-- window/floor (candidate branch (c)). The client's has-more probe (the
-- overfetched p_per_feed_limit'th row) is now purely a body row, so a pin can
-- never masquerade as "more articles exist".
--
-- Cost: unchanged — same candidate set, same single ordering pass; only the
-- window predicate moves. A pin-heavy account returns (pins + window) rows per
-- feed instead of max(window), still bounded by the caller's p_limit row cap.
--
-- This is a verbatim copy of the 0035 body (same 8-arg signature, so
-- `create or replace` keeps the existing grants); only the `ranked` partition,
-- the window predicate, and the doc comment change.

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
    -- Per-section BODY rank, in the same within-block order the rows are
    -- emitted. Partitioning by (feed_id, pin_rank) — not feed_id alone (0021..
    -- 0035) — restarts the rank at 1 for each feed's body block, so the window
    -- below caps only body rows and a feed's pinned block can never consume
    -- (or overflow) its article window. Partition by the actual feed id — NOT
    -- group_ord (the subscription `sort` ordinal) — so two subscriptions that
    -- happen to share a sort value can't be ranked as one window, where the
    -- first feed could consume the whole cap and drop the other from the
    -- opening read entirely. group_ord stays for section ORDERING only. On the
    -- flat river the cap is bypassed below, so the rank is inert there.
    select i, pin_rank, ord_at, group_ord,
           row_number() over (
             partition by (i).feed_id, pin_rank
             order by
               case when pin_rank = 0 then ord_at end asc  nulls last,
               case when pin_rank = 1 and p_sort = 'oldest' then ord_at end asc  nulls last,
               case when pin_rank = 1 and p_sort <> 'oldest' then ord_at end desc nulls last,
               (i).id desc
           ) as feed_rn
    from combined
  )
  -- Strip the gated fields from list rows so none reaches a list read — each is
  -- loaded only through its allowlist-gated single-item function:
  --   - full_content_html (0011) + full_content_via_fallback (0025) → `fulltext`;
  --   - ai_summary + ai_summary_generated_at (0035)                 → `summary`.
  select
    jsonb_populate_record(
      i,
      jsonb_build_object(
        'full_content_html', null::text,
        'full_content_via_fallback', null::boolean,
        'ai_summary', null::text,
        'ai_summary_generated_at', null::timestamptz
      )
    )
  from ranked
  where p_per_feed_limit is null
     or not coalesce(p_group_by_feed, false)
     or pin_rank = 0                    -- pinned rows are exempt from the window
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
  'p_per_feed_limit (grouping only) caps each section''s BODY to its newest '
  'that-many rows for the group-by-feed opening view — pinned rows are exempt, '
  'so a section is its full pinned block plus that window (0052); the '
  'per-section "More" pages deeper via the ''feed'' scope with an offset. Page 1 '
  'is bounded to p_limit total rows. full_content_html, '
  'full_content_via_fallback, and ai_summary (+ its timestamp) are nulled here; '
  'the reader loads the full body (and its provenance) via the allowlist-gated '
  '`fulltext` path and the summary via the allowlist-gated `summary` path. No '
  'total count: the client pages off whether the last page came back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;
