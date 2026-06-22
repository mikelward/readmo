-- Readmo feed-read RPC — server-side subscription-scoped feed query.
--
-- The hot read ("feed items across a user's subscriptions, newest first,
-- paginated, minus Done/Hidden, with Pinned lifted to the top"; SPEC.md §Data)
-- was first built client-side: fetch the user's subscriptions, then send every
-- subscribed feed_id (and the Pinned/Done/Hidden exclusion id list) in one
-- PostgREST `in (…)` request. For a user with many hundreds of feeds/states
-- that request URL exceeds request-line limits and the whole feed fails.
--
-- Move the join into Postgres. `feed_items` drives from `subscriptions` →
-- `items` and LEFT JOINs `item_state` (scoped to auth.uid()) and returns ONE
-- combined, already-paged sequence: Pinned first (oldest-pinned first), then the
-- body (newest-first by `sort_at` = coalesce(published_at, created_at), see
-- 0005), Done/Hidden excluded. Because the page is the slice of the *combined*
-- sequence, page 1 is bounded to p_limit total rows (matching MockDataSource's
-- paginate) — a user with thousands of pins no longer gets them all dumped on
-- the first page. A window `total_count` rides on every row so the client can
-- drive pagination without a second count request.
--
-- SECURITY DEFINER (like the 0004 access RPCs): the joins filter by auth.uid(),
-- so each call only ever returns the caller's own subscribed feeds' items.
-- `set search_path = ''` + fully-qualified names is the standard definer
-- hardening. Scope is 'home' (all non-muted subs), 'folder' (a named folder's
-- non-muted subs), or 'feed' (a single subscribed feed, muted or not).
--
-- Pinned items are never also Done/Hidden (the mutation rules — 0003 and the
-- client's applyMutation — clear Done/Hidden on pin), so the two sections never
-- overlap and an item appears at most once.
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
  with scoped as (
    select i, st.pinned as is_pinned, st.pinned_at,
           coalesce(st.done, false) as is_done,
           -- Hidden is TTL'd (7 days): once hidden_at ages out, the item
           -- re-enters the feed, matching the client's withRetention so a user
           -- isn't stuck with no way to unhide it (SPEC.md *Retention*).
           (coalesce(st.hidden, false)
              and st.hidden_at > now() - interval '7 days') as is_hidden
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
    -- Section 0: Pinned, oldest-pinned first.
    select i, 0 as section, pinned_at as ord_at from scoped where is_pinned is true
    union all
    -- Section 1: body, newest-first, Done/active-Hidden/Pinned excluded.
    select i, 1 as section, (i).sort_at as ord_at
    from scoped
    where is_pinned is not true and not is_done and not is_hidden
  )
  select i, count(*) over()
  from combined
  order by
    section asc,
    case when section = 0 then ord_at end asc nulls last,
    case when section = 1 then ord_at end desc nulls last,
    (i).id desc
  limit  greatest(coalesce(p_limit, 30), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.feed_items(text, text, uuid, int, int) is
  'Server-side subscription-scoped feed: one combined, paged sequence (Pinned '
  'oldest-first, then body newest-first by sort_at with Done/Hidden excluded) '
  'plus a window total_count. Page 1 is bounded to p_limit total rows. Keeps the '
  'client from sending every subscribed feed_id / exclusion id in one IN(...) URL.';

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.feed_items(text, text, uuid, int, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int) to authenticated;
