-- Drop the per-call total count from the feed_items RPC.
--
-- 0006 added a `count(*) over()` window to every returned row so the client
-- could show "X of Y" pagination. We never built that UI — the feed uses a
-- lazy "More" button (SPEC.md *Feed views*) and decides whether another page
-- exists from whether the last page came back full, not from a grand total.
-- Meanwhile the window count forces Postgres to scan the *entire* filtered
-- result set on every call (not just the returned page), which gets expensive
-- as items/subscriptions grow (SCALING.md *`feed_items` RPC: `count(*) over()`*).
--
-- Drop `total_count` from the return so each call only materializes its page.
-- Changing a RETURNS TABLE signature isn't a create-or-replace — the OUT
-- columns are part of the type — so DROP then CREATE, then re-apply the 0006
-- grants (a drop takes them with it). Everything else (the scoped/combined
-- join, full_content_html nulling from 0011, ordering, paging) is unchanged.

drop function if exists public.feed_items(text, text, uuid, int, int);

create function public.feed_items(
  p_scope   text,
  p_folder  text default null,
  p_feed_id uuid default null,
  p_limit   int  default 30,
  p_offset  int  default 0
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
  -- Strip the full-article body from list rows (see 0011); the reader reads it
  -- via getItem instead. jsonb_populate_record keeps all other columns from `i`.
  select
    jsonb_populate_record(i, jsonb_build_object('full_content_html', null::text))
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
  'oldest-first, then body newest-first by sort_at with Done/Hidden excluded). '
  'Page 1 is bounded to p_limit total rows. Keeps the client from sending every '
  'subscribed feed_id / exclusion id in one IN(...) URL. full_content_html is '
  'nulled here — list rows only need snippets; the reader loads the full '
  'reading-mode body via the single-item path. No total count: the client pages '
  'off whether the last page came back full, so each call only scans its page.';

-- A drop removes the 0006 grants with the function; re-apply them.
revoke execute on function public.feed_items(text, text, uuid, int, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int) to authenticated;
