-- Ride the cached AI summary along on list rows — for allowlisted callers only.
--
-- Until now `feed_items` NULLed `ai_summary` for everyone (0035), so the summary
-- reached the client only through a separate, allowlist-gated `summary` Edge
-- call. That call is a round-trip the reader makes on open, so a pinned
-- article's summary showed a ~1 s "Summarizing…" placeholder on the first open
-- of a fresh session (the on-device cache was cold) even though the summary was
-- already generated server-side. And because it was never on the item row, it
-- wasn't bundled into the pinned article's offline payload.
--
-- Fix: deliver `ai_summary` ON the list row so it rides into the persisted list
-- cache with the item — instant on open, available offline, no extra call — but
-- ONLY for a caller the summary is meant for. So gate the column on
-- `email_is_allowlisted()` (0028): included when the caller's email is on the
-- allowlist OR the list is disarmed (the same "empty = open" semantics the
-- client summary path already uses), NULLed otherwise. A non-allowlisted
-- co-subscriber still gets NULL in the normal list API, exactly as before —
-- the access boundary is unchanged for them.
--
-- `ai_summary_generated_at` and the full-text columns stay NULLed: the client
-- displays only `ai_summary`, the timestamp is the server-side generation lease,
-- and `full_content_html` is the copyright-gated reading-mode body that stays
-- behind the `fulltext` Edge call.
--
-- Scope of the gate (unchanged from 0035's KNOWN GAP): this covers the normal
-- list API. The direct `select ai_summary from items` residual — a hand-crafted
-- PostgREST read by a co-subscriber who can already see the row — remains the
-- same accepted gap (0008 grants table-level SELECT; RLS is row-, not
-- column-scoped), and a one-sentence gist is strictly less sensitive than the
-- full body that already carries it. The real fix is still the column-grant
-- restructuring tracked for `full_content_html`. The GENERATION cost gate is
-- untouched — only an allowlisted pin/open can spend a Gemini call; this only
-- changes who receives an ALREADY-cached gist on the row.
--
-- Verbatim copy of the 0052 body (same 8-arg signature, so `create or replace`
-- keeps the existing grants); only the `ai_summary` scrub value and the doc
-- comment change.

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
  'is bounded to p_limit total rows. full_content_html / '
  'full_content_via_fallback are always nulled (reader loads the body via the '
  'allowlist-gated `fulltext` path); ai_summary rides the row for an allowlisted '
  'caller and is nulled for everyone else (0058), and ai_summary_generated_at '
  'stays nulled. No total count: the client pages off whether the last page came '
  'back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;
