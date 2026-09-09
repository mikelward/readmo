-- Keep the heavy full-article body out of list payloads.
--
-- 0010 added items.full_content_html (the cached reading-mode body). The hot
-- list read goes through the feed_items RPC (0006), which returns the whole
-- `item public.items` composite — so every home/folder/feed page would now ship
-- the full article for each row and persist it in the client's localStorage
-- query cache, even though list rows only render a title + snippet. (Splitting
-- the client's ITEM_COLS selector fixed the direct `.from('items').select()`
-- reads but NOT this RPC, which is the main list path.)
--
-- Fix: re-create feed_items identically, but null `full_content_html` in the
-- returned row via jsonb_populate_record (which keeps every other column from
-- the base row and overrides only the named field). The reader still gets the
-- real body through the single-item getItem path (ITEM_DETAIL_COLS). Return type
-- stays `public.items`, so no client change is needed. create-or-replace
-- preserves the existing execute grants from 0006.

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
  -- Strip the full-article body from list rows (see header); the reader reads it
  -- via getItem instead. jsonb_populate_record keeps all other columns from `i`.
  select
    jsonb_populate_record(i, jsonb_build_object('full_content_html', null::text)),
    count(*) over()
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
  'client from sending every subscribed feed_id / exclusion id in one IN(...) URL. '
  'full_content_html is nulled here — list rows only need snippets; the reader '
  'loads the full reading-mode body via the single-item path.';
