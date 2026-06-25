-- Add body sort order + group-by-feed to the feed_items RPC.
--
-- 0014 returns one combined, paged sequence: Pinned (oldest-first), then the
-- body newest-first by sort_at. The reader can now choose, per device, to sort
-- the body oldest-first and/or to section it by feed (SPEC.md *Feed views →
-- Sort & grouping*). Both must hold across page boundaries, so they belong in
-- the server-side ordering rather than a client re-sort of the loaded pages.
--
-- Two new params:
--   p_sort           'newest' (default) | 'oldest' — flips the BODY order only;
--                    Pinned stays oldest-pin-first within its section regardless.
--   p_group_by_feed  false (default) | true — when true the body is sectioned by
--                    feed in the user's custom subscription order (the
--                    `subscriptions.sort` field, drag-to-reorder), then by the
--                    chosen chronological order within each section. Each feed's
--                    Pinned items sit at the TOP OF THAT FEED'S SECTION (not a
--                    global top section); when flat (default) Pinned stay in the
--                    single global top section, exactly as before.
--
-- Changing a RETURNS TABLE signature isn't a create-or-replace (the OUT columns
-- are part of the type), and adding params changes the function identity — so
-- DROP the old (5-arg) signature then CREATE the new (7-arg) one, and re-apply
-- the grants (a drop takes them with it). Everything else (the scoped/combined
-- join, full_content_html nulling from 0011, paging) is unchanged.

drop function if exists public.feed_items(text, text, uuid, int, int);

create function public.feed_items(
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
           coalesce(st.done, false) as is_done,
           -- Hidden is TTL'd (7 days): once hidden_at ages out, the item
           -- re-enters the feed, matching the client's withRetention so a user
           -- isn't stuck with no way to unhide it (SPEC.md *Retention*).
           (coalesce(st.hidden, false)
              and st.hidden_at > now() - interval '7 days') as is_hidden,
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
  combined as (
    -- pin_rank 0 = Pinned (oldest-pin first), 1 = body. group_ord is the feed's
    -- custom section ordinal when grouping, else null (so it's inert and the
    -- ORDER BY falls through to the global pinned-then-body layout).
    select i, 0 as pin_rank, pinned_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from scoped where is_pinned is true
    union all
    select i, 1 as pin_rank, (i).sort_at as ord_at,
           case when p_group_by_feed then feed_sort end as group_ord
    from scoped
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
  'oldest-first, then body by sort_at with Done/Hidden excluded). p_sort flips '
  'the body to oldest-first; p_group_by_feed sections the body by feed in the '
  'user''s custom subscription order, with each feed''s pinned items at the top '
  'of that section (flat keeps a single global pinned section) — all applied '
  'server-side so they hold across pages. Page 1 is bounded to p_limit total '
  'rows. full_content_html is nulled here; the reader loads the full body via '
  'the single-item path. No total count: the client pages off whether the last '
  'page came back full, so each call only scans its page.';

-- A drop removes the 0006/0014 grants with the function; re-apply them.
revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean) to authenticated;
