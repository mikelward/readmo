-- Readmo feed-read RPCs — server-side subscription-scoped feed query.
--
-- The hot read ("feed items across a user's subscriptions, newest first,
-- paginated, minus Done/Hidden, with Pinned lifted to the top"; SPEC.md §Data)
-- was first built client-side: fetch the user's subscriptions, then send every
-- subscribed feed_id (and the Pinned/Done/Hidden exclusion id list) in one
-- PostgREST `in (…)` request. For a user with many hundreds of feeds/states
-- that request URL exceeds request-line limits and the whole feed fails.
--
-- Move the join into Postgres. These functions drive from `subscriptions` →
-- `items` and LEFT JOIN `item_state` (scoped to auth.uid()), so the client
-- sends only the scope + page, never an unbounded id list. Ordering matches the
-- client domain: newest-first by `sort_at` (= coalesce(published_at,
-- created_at), see 0005), with a UUID tiebreak for stable pagination.
--
-- SECURITY DEFINER (like the 0004 access RPCs): the joins filter by auth.uid(),
-- so each call only ever returns the caller's own subscribed feeds' items.
-- `set search_path = ''` + fully-qualified names is the standard definer
-- hardening. The scope is one of 'home' (all non-muted subs), 'folder' (a named
-- folder's non-muted subs), or 'feed' (a single subscribed feed, muted or not).

-- ===========================================================================
-- feed_items — one page of the body (Pinned/Done/Hidden excluded). Returns the
-- full item row plus a window `total_count` (identical on every row) so the
-- client can render pagination without a second count request.
-- ===========================================================================
create or replace function public.feed_items(
  p_scope   text,
  p_folder  text default null,
  p_feed_id uuid default null,
  p_limit   int  default 30,
  p_offset  int  default 0
)
returns table (item public.items, total_count bigint)
language sql
security definer
set search_path = ''
as $$
  select i, count(*) over()
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
    and not coalesce(st.pinned, false)
    and not coalesce(st.done,   false)
    and not coalesce(st.hidden, false)
  order by i.sort_at desc, i.id desc
  limit  greatest(coalesce(p_limit, 30), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.feed_items(text, text, uuid, int, int) is
  'Server-side subscription-scoped feed body (newest-first by sort_at, '
  'Done/Hidden/Pinned excluded), paginated, with a window total_count. Keeps the '
  'client from sending every subscribed feed_id in one IN(...) URL.';

-- ===========================================================================
-- pinned_feed_items — the Pinned items for the same scope, oldest-pinned first,
-- prepended once at the top of page 1 by the client.
-- ===========================================================================
create or replace function public.pinned_feed_items(
  p_scope   text,
  p_folder  text default null,
  p_feed_id uuid default null
)
returns setof public.items
language sql
security definer
set search_path = ''
as $$
  select i.*
  from public.items i
  join public.subscriptions s
    on s.feed_id = i.feed_id and s.user_id = auth.uid()
  join public.item_state st
    on st.item_id = i.id and st.user_id = auth.uid() and st.pinned
  where
    case p_scope
      when 'home'   then not s.muted
      when 'folder' then not s.muted and s.folder is not distinct from p_folder
      when 'feed'   then i.feed_id = p_feed_id
      else false
    end
  order by st.pinned_at asc nulls last, i.id;
$$;

comment on function public.pinned_feed_items(text, text, uuid) is
  'Pinned items for a feed scope (oldest-pinned first), for the client''s '
  'pinned-prepend on page 1.';

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.feed_items(text, text, uuid, int, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int) to authenticated;

revoke execute on function public.pinned_feed_items(text, text, uuid) from public;
grant  execute on function public.pinned_feed_items(text, text, uuid) to authenticated;
