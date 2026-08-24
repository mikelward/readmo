-- Clamp feed_items' page size server-side.
--
-- `p_limit` is caller-supplied and was used as-is (`greatest(coalesce(p_limit,
-- 30), 0)` — a floor, never a ceiling). Every shipped client asks for a small
-- page, but nothing in the function stopped a buggy build, an old cached one,
-- or a hand-crafted PostgREST call from asking for a million rows and turning
-- one request into an arbitrarily large read of the caller's subscriptions.
-- Now that the page size is a user-facing setting rather than a constant
-- (SPEC.md *Feed views → How much loads at a time*), the value reaching the
-- RPC is data, and data gets a bound.
--
-- The ceiling is shape-dependent, because the two reads legitimately want very
-- different amounts:
--   flat    — 50, the largest size the *Articles per page* picker offers.
--   grouped — 1000, the PostgREST response row cap the grouped read already
--             asks for on purpose (it fetches every section in one deep page,
--             and pages by row cursor past the cap).
--
-- Backwards compatible in both directions (guardrail 11): it is only a
-- ceiling, and every value any shipped client sends already sits under it, so
-- no existing caller's result changes. A future client that wants a larger
-- page needs this migration deployed first — which is the point.
--
-- Verbatim copy of the 0073 body (same 8-arg signature, so `create or replace`
-- keeps the existing grants); only the `limit` clause and the doc comment
-- change.

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
  with filt as (
    -- Read once for the whole call rather than per row. `has_any` is what keeps
    -- this free for the overwhelming majority of readers, who filter nothing:
    -- the predicates below are written as CASE, which Postgres guarantees will
    -- short-circuit, so title_is_filtered is never called for them and the plan
    -- is the pre-filtering plan. (A plain OR would read the same but carries no such
    -- guarantee — the planner may evaluate either side first.)
    select f as list, cardinality(f) > 0 as has_any
    from public.current_title_filters() as f
  ),
  scoped as (
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
    cross join filt
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
      and case when filt.has_any
                then not public.title_is_filtered(i.title_normalized, filt.list)
                else true end
    union
    -- (b) Per-feed floor: the feed's newest 10 items BY DATE, irrespective of
    -- read/done state. The lateral walks items_feed_sort_idx newest-first and
    -- stops after 10 rows, so an archive of years costs ~10 index rows per feed.
    -- Done/Hidden items still consume a floor slot here; they're dropped from the
    -- body in `combined` below — so dismissing a recent item shrinks the feed
    -- rather than pulling an older item up to refill the floor.
    --
    -- A FILTERED item does NOT consume a slot: the predicate is inside the
    -- lateral, so the floor is the newest 10 the reader can actually see. That
    -- is the difference from Done/Hidden and it is deliberate — dismissing is a
    -- per-item act on a row you were shown, while filtering is a standing rule
    -- about rows you never want shown, so a filtered row shrinking the feed
    -- would empty a feed the reader still reads.
    select t.id
    from scoped sc
    cross join filt
    cross join lateral (
      -- Walk a BOUNDED window of the newest rows, then take the first 10 that
      -- survive filtering. The predicate is not indexable, so applying it
      -- directly under `limit 10` would make Postgres walk the archive until it
      -- found ten survivors — for a filter matching most of a feed's titles,
      -- that is the feed's whole history, twice (here and in the badge count),
      -- against a statement timeout. The window is what keeps the floor's
      -- index-bounded promise (0031) intact.
      --
      -- The trade at the boundary: if a feed's newest 200 ALL match, its floor
      -- serves nothing rather than digging further back. That reader has
      -- filtered essentially the entire feed, so serving them its 201st-newest
      -- article is not the behavior worth an unbounded scan for.
      --
      -- `filt.has_any` picks the window size so a reader with no filters gets
      -- the pre-0072 plan exactly — ten index rows, not two hundred.
      select w.id
      from (
        select i2.id, i2.title_normalized, i2.sort_at
        from public.items i2
        where i2.feed_id = sc.feed_id
        order by i2.sort_at desc, i2.id desc
        limit case when filt.has_any then 200 else 10 end
      ) w
      where case when filt.has_any
                 then not public.title_is_filtered(w.title_normalized, filt.list)
                 else true end
      order by w.sort_at desc, w.id desc
      limit 10
    ) t
    union
    -- (c) Pinned items, any age — a pin must never be dropped by window/floor
    -- (item_state pinned partial index). Deliberately NOT filtered: a pin is a
    -- to-do the reader placed on this article, and it outranks a standing rule
    -- about words, exactly as it outranks Done/Hidden. Same rule as the client
    -- overlay, which checks the pin branch before the filter branch.
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
  -- Strip the gated fields from list rows — each is loaded on its own terms:
  --   - full_content_html (0011) + full_content_via_fallback (0025) → always
  --     NULLed; the reader loads the copyright-gated body via `fulltext`;
  --   - ai_summary (0035) → included for an ALLOWLISTED caller (or a disarmed
  --     list), NULLed otherwise, so an allowlisted reader gets the cached gist
  --     ON the row (instant + offline) while an off-list co-subscriber still
  --     doesn't (0058). ai_summary_generated_at stays NULLed — it's the
  --     server-side generation lease, not something the client displays.
  select
    jsonb_populate_record(
      i,
      jsonb_build_object(
        'full_content_html', null::text,
        'full_content_via_fallback', null::boolean,
        'ai_summary', case when public.email_is_allowlisted() then (i).ai_summary else null::text end,
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
  -- Clamp the requested page to a server-side ceiling. p_limit is caller-
  -- supplied, so without this any client (or a hand-crafted PostgREST call)
  -- could ask for an unbounded page and turn one request into an arbitrarily
  -- large read. The ceiling depends on the shape being served:
  --   flat  — 50, the largest size the Articles per page picker offers
  --           (src/lib/types.ts ARTICLES_PER_PAGE_OPTIONS; feedItemsCap.test.ts
  --           fails CI if the two drift apart).
  --   grouped — 1000, the PostgREST response row cap the grouped read already
  --           targets (GROUPED_WINDOW_ROW_CAP), since that read deliberately
  --           asks for every section in one deep page.
  -- Purely a ceiling: every value a shipped client sends is already under it,
  -- so this changes no existing caller's result (guardrail 11).
  limit  least(
           greatest(coalesce(p_limit, 30), 0),
           case when coalesce(p_group_by_feed, false) then 1000 else 50 end
         )
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.feed_items(text, text, uuid, int, int, text, boolean, int) is
  'Server-side subscription-scoped feed: one combined, paged sequence (Pinned '
  'oldest-first, then body by sort_at with Done/Hidden excluded). The body '
  'serves items younger than 3 days OR among their feed''s newest 10 by date '
  '(freshness window ∪ per-feed floor); Pinned items are exempt and stay '
  'regardless of age. The floor ranks by date irrespective of state, so a '
  'dismissed recent item is dropped without backfilling an older one. The '
  'reader''s title filters (0072) are applied to the window and the floor, and a '
  'filtered item does NOT consume a floor slot, so a feed whose newest rows all '
  'match still serves the next ones; pinned items are exempt from filtering as '
  'they are from everything else. The body '
  'is built from index-bounded candidate sets, so cost scales with recent/kept '
  'rows per feed, not a feed''s full archive. p_sort flips the body to '
  'oldest-first; p_group_by_feed sections the body by feed in the user''s custom '
  'subscription order, with each feed''s pinned items at the top of that section. '
  'p_per_feed_limit (grouping only) caps each section''s BODY to its newest '
  'that-many rows for the group-by-feed opening view — pinned rows are exempt, '
  'so a section is its full pinned block plus that window (0052); the '
  'per-section "More" pages deeper via the ''feed'' scope with an offset. Page 1 '
  'is bounded to p_limit total rows, itself clamped server-side to 50 flat / '
  '1000 grouped so a caller cannot request an unbounded page (0076). '
  'full_content_html / '
  'full_content_via_fallback are always nulled (reader loads the body via the '
  'allowlist-gated `fulltext` path); ai_summary rides the row for an allowlisted '
  'caller and is nulled for everyone else (0058), and ai_summary_generated_at '
  'stays nulled. No total count: the client pages off whether the last page came '
  'back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;
