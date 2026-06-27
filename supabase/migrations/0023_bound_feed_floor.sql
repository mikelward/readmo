-- Bound the per-feed floor by age, and order the Done TTL above it, so swept
-- items don't resurface — and the floor read stays bounded.
--
-- Two coupled problems with the 0018/0021 floor:
--
--   1. Resurfacing. The floor lists each feed's newest 10 NON-dismissed items at
--      ANY age, and Done is read-time-TTL'd. So once a swept item's done_at aged
--      past the TTL it counted as non-dismissed again and the floor re-listed it.
--      This bit RECENT-looking items too: when the poller re-publishes an item
--      (refreshes sort_at), it rides back to the top of the feed while its
--      done_at stays old — so a "recent" row reappears the moment its Done
--      expires, even though the user swept it.
--
--   2. Unbounded scan (Codex P2 on the prior revision). With no age cap, the
--      floor's "newest 10 non-dismissed" LATERAL must skip every Done row in a
--      heavily-swept feed before it finds 10 survivors — a full archive scan, not
--      a top-N lookup, risking statement timeouts.
--
-- Fix (both at once): cap the floor candidate to items younger than 30 days
-- (FLOOR_MAX_AGE_MS) — a bounded index range scan — AND keep the Done/Hidden
-- read-time TTL at 33 days (TTL_MS), i.e. LONGER than the floor cap. The ordering
-- TTL_MS (33d) > FLOOR_MAX_AGE_MS (30d) > freshness (3d) is the invariant: an
-- item ages out of every list (window ∪ floor) before its Done flag expires, so a
-- swept item is consistently excluded for its entire listable life and can never
-- pop back into the floor. The TTLs still exist (so /done, /opened auto-prune);
-- they're just ordered so they can't cause a resurface.
--
-- Index: `item_state_user_done_idx` (partial, the caller's Done rows) lets the
-- floor's anti-join enumerate a user's dismissed items cheaply instead of probing
-- row-by-row, keeping the bounded scan cheap even when most of the 30-day window
-- is swept. (Optimal index choice wants an EXPLAIN against real data; this is the
-- safe, clearly-useful one — revisit if a plan shows a better fit.)
--
-- Mirrors the client: src/lib/types.ts (TTL_MS / FLOOR_MAX_AGE_MS / HOME_WINDOW_MS),
-- itemState.ts withRetention, MockDataSource.orderedFor / getFeedUnreadCounts.
-- feed_items / feed_unread_counts keep their 0021/0020 signatures (plain CREATE OR
-- REPLACE, grants preserved). set_item_state (0019) is unchanged — it still stamps
-- done_at on a true write.
--
-- Backwards compatible (AGENTS guardrail #11): behavioral only, no signature/
-- column/param change. An old service-worker-cached client (Done TTL 30d, floor
-- uncapped locally) still works — the backend just returns a tighter, correct set;
-- the client filters via its local overlay as before. The newest client also works
-- against the OLD backend (it caps its own floor + overlays Done locally). So
-- client and server roll out on their own clocks.
--
-- MANUAL DEPLOY: backend migration — run `make migrate` (supabase db push).

-- Partial index over the caller's dismissed rows, to support the floor anti-join.
create index if not exists item_state_user_done_idx
  on public.item_state (user_id, item_id)
  where done;

comment on index public.item_state_user_done_idx is
  'Supports the per-feed floor in feed_items / feed_unread_counts: lets the '
  '"newest 10 non-dismissed within 30 days" scan enumerate the caller''s Done '
  'items cheaply (anti-join) instead of probing every recent row, so a '
  'heavily-swept feed''s floor stays bounded.';

-- ---------------------------------------------------------------------------
-- feed_items — cap the floor candidate (b) to FLOOR_MAX_AGE_MS (30 days); Done /
-- Hidden read-time TTL is TTL_MS (33 days), longer than the cap. (Copied from
-- 0021; only the floor candidate's age bound and the TTL intervals change.)
-- ---------------------------------------------------------------------------

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
    -- (b) Per-feed floor: the feed's newest 10 NON-DISMISSED items, CAPPED to the
    -- last 30 days (FLOOR_MAX_AGE_MS) so the LATERAL is a bounded index range scan
    -- and the floor can't reach back into the archive. Dismissed = Done or Hidden
    -- within their 33-day TTL (TTL_MS) — which, being longer than this 30-day cap,
    -- means any item still inside the floor still has its Done active, so a swept
    -- item never re-enters here.
    select t.id
    from scoped sc
    cross join lateral (
      select i2.id
      from public.items i2
      left join public.item_state d
        on d.item_id = i2.id and d.user_id = auth.uid()
      where i2.feed_id = sc.feed_id
        and i2.sort_at > now() - interval '30 days'
        and not (coalesce(d.done,   false) and d.done_at   > now() - interval '33 days')
        and not (coalesce(d.hidden, false) and d.hidden_at > now() - interval '33 days')
      order by i2.sort_at desc, i2.id desc
      limit 10
    ) t
    union
    -- (c) Pinned items, any age.
    select st.item_id as id
    from public.item_state st
    join public.items i on i.id = st.item_id
    join scoped sc on sc.feed_id = i.feed_id
    where st.user_id = auth.uid() and st.pinned
  ),
  rows as (
    -- Done and Hidden are TTL'd at 33 days (TTL_MS), matching withRetention.
    select i, st.pinned as is_pinned, st.pinned_at,
           (coalesce(st.done, false)
              and st.done_at > now() - interval '33 days') as is_done,
           (coalesce(st.hidden, false)
              and st.hidden_at > now() - interval '33 days') as is_hidden,
           sc.feed_sort
    from cand
    join public.items i on i.id = cand.id
    join scoped sc on sc.feed_id = i.feed_id
    left join public.item_state st
      on st.item_id = i.id and st.user_id = auth.uid()
  ),
  combined as (
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
  select
    jsonb_populate_record(i, jsonb_build_object('full_content_html', null::text))
  from ranked
  where p_per_feed_limit is null
     or not coalesce(p_group_by_feed, false)
     or feed_rn <= p_per_feed_limit
  order by
    group_ord asc nulls last,
    case when p_group_by_feed then (i).feed_id end asc nulls last,
    pin_rank asc,
    case when pin_rank = 0 then ord_at end asc  nulls last,
    case when pin_rank = 1 and p_sort = 'oldest' then ord_at end asc  nulls last,
    case when pin_rank = 1 and p_sort <> 'oldest' then ord_at end desc nulls last,
    (i).id desc
  limit  greatest(coalesce(p_limit, 30), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.feed_items(text, text, uuid, int, int, text, boolean, int) is
  'Server-side subscription-scoped feed: one combined, paged sequence (Pinned '
  'oldest-first, then body by sort_at with Done/Hidden excluded). The body serves '
  'items younger than 3 days OR among their feed''s newest 10 within the last 30 '
  'days (freshness window ∪ age-capped per-feed floor); Pinned items are exempt '
  'and stay regardless of age. Done/Hidden are read-time-TTL''d at 33 days — '
  'longer than the 30-day floor cap, so a swept item ages out of the floor before '
  'its Done expires and never resurfaces. The body is built from index-bounded '
  'candidate sets (the floor LATERAL is now bounded by the 30-day cap), so cost '
  'scales with recent rows per feed. p_sort flips the body to oldest-first; '
  'p_group_by_feed sections the body by feed in the user''s custom order; '
  'p_per_feed_limit (grouping only) caps each section''s opening window. Page 1 is '
  'bounded to p_limit rows. full_content_html is nulled; the reader loads it via '
  'the single-item path. No total count: the client pages off a full last page.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;

-- ---------------------------------------------------------------------------
-- feed_unread_counts — same age-capped floor + 33-day TTL. (Copied from 0020.)
-- ---------------------------------------------------------------------------

create or replace function public.feed_unread_counts(p_feed_ids uuid[])
returns table (feed_id uuid, n bigint)
language sql
security definer
set search_path = ''
as $$
  with scoped as (
    select s.feed_id
    from public.subscriptions s
    where s.user_id = auth.uid()
      and s.feed_id = any(p_feed_ids)
  ),
  cand as (
    -- (a) freshness window — index range scan for the last 3 days.
    select i.id, sc.feed_id
    from scoped sc
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
    union
    -- (b) per-feed floor — newest 10 non-dismissed within the last 30 days
    -- (age-capped; Done/Hidden TTL'd at 33 days, longer than the cap).
    select t.id, sc.feed_id
    from scoped sc
    cross join lateral (
      select i2.id
      from public.items i2
      left join public.item_state d
        on d.item_id = i2.id and d.user_id = auth.uid()
      where i2.feed_id = sc.feed_id
        and i2.sort_at > now() - interval '30 days'
        and not (coalesce(d.done,   false) and d.done_at   > now() - interval '33 days')
        and not (coalesce(d.hidden, false) and d.hidden_at > now() - interval '33 days')
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
    -- Unread/to-do = not Done and not active Hidden (33-day TTL), and either
    -- pinned OR not active Opened (33-day TTL). A pin always counts.
    count(c.id) filter (
      where not (coalesce(s.done,   false) and s.done_at   > now() - interval '33 days')
        and not (coalesce(s.hidden, false) and s.hidden_at > now() - interval '33 days')
        and (coalesce(s.pinned, false)
             or not (coalesce(s.opened, false) and s.opened_at > now() - interval '33 days'))
    ) as n
  from scoped sc
  left join cand c on c.feed_id = sc.feed_id
  left join public.item_state s on s.item_id = c.id and s.user_id = auth.uid()
  group by sc.feed_id;
$$;

comment on function public.feed_unread_counts(uuid[]) is
  'Per-feed unread count for the requested subscribed feeds: items in the feed''s '
  'listable set (freshness window ∪ age-capped per-feed floor ∪ pinned) that are '
  'not Done or active Hidden (33-day TTL), and either pinned OR not active Opened. '
  'Floor capped to the last 30 days (bounded scan); drives from subscriptions '
  '(RLS). Used by the group-by-feed section-header badge.';

revoke execute on function public.feed_unread_counts(uuid[]) from public;
grant  execute on function public.feed_unread_counts(uuid[]) to authenticated;
