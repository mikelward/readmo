-- Readmo AI article-summary cache.
--
-- When an allowlisted user pins an article, the `summary` Edge Function asks
-- Gemini for a one-sentence gist and caches it here so later pins — on any of
-- the user's devices, and for any other subscriber who pins the same shared
-- item — are served instantly without another model call. SPEC.md "AI article
-- summaries".
--
-- Like `full_content_html` (0010), these columns sit on the SHARED `items` row
-- and follow the same trust model: visibility is unchanged — the items_select
-- RLS policy (0002) still gates which rows a caller can read — and writes remain
-- server-only (0002 revoked client INSERT/UPDATE on items; the function writes
-- as the service role, granted UPDATE in 0009). The official client never reads
-- `ai_summary` (SupabaseDataSource's ITEM_COLUMNS list omits it, exactly like
-- `full_content_html`), AND the `feed_items` list RPC is recreated below to NULL
-- it (mirroring the full-text scrub in 0026), so the summary normally reaches
-- the client only through the allowlist-gated `summary` function.
--
-- KNOWN GAP (shared with `full_content_html`, and no worse): `0008_client_grants.sql`
-- grants table-level SELECT on items, and RLS is row-, not column-scoped, so a
-- hand-crafted PostgREST read (`select ai_summary from items where id=…`) by a
-- caller who can already SEE the row could read this column directly even if
-- they're off the summary allowlist. A column-level `REVOKE SELECT (ai_summary)`
-- is a no-op while that table-level grant stands — the real fix is the
-- column-grant restructuring already tracked for `full_content_html` (SPEC
-- "Reading-mode allowlist"). Accepted here on the same terms, and a fortiori: a
-- one-sentence gist is strictly LESS sensitive than the full extracted body that
-- already carries this gap, and is derived from content the entitled caller can
-- already read. The allowlist gate still bounds the only costly part — only
-- allowlisted callers can GENERATE a summary (a Gemini call); reading a cached
-- one is free.

alter table public.items
  -- The generated one-sentence summary (plain text, not HTML). NULL until a
  -- successful generation has been cached.
  add column if not exists ai_summary              text,
  -- When the summary was last generated, so a future job could re-summarize
  -- stale entries or distinguish "never tried" (null) from "tried".
  add column if not exists ai_summary_generated_at timestamptz;

-- Keep the cached summary out of list payloads.
--
-- feed_items returns the whole `public.items` composite (`returns table (item
-- public.items)`), and since 0026 it scrubs `full_content_html` /
-- `full_content_via_fallback` to null so the gated full text never rides along
-- in a home/folder/feed list read. Without recreating it, the new `ai_summary` /
-- `ai_summary_generated_at` columns would ship in every list response for any
-- visible item — handing an off-allowlist co-subscriber the cached summary
-- through the normal list API, bypassing both the allowlist-gated `summary`
-- function and the client display gate. So recreate the RPC to scrub the two
-- new columns too, exactly like the full-text fields. This is a verbatim copy of
-- the 0031 body (same 8-arg signature, so `create or replace` keeps the existing
-- grants); only the scrub block and the doc comment change.

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
    -- Per-section rank, in the SAME within-section order the rows are emitted
    -- (pinned-first, then body by p_sort). Used to window each feed to its
    -- newest p_per_feed_limit rows when grouping. Partition by the actual
    -- feed id — NOT group_ord (the subscription `sort` ordinal) — so two
    -- subscriptions that happen to share a sort value can't be ranked as one
    -- window, where the first feed could consume the whole cap and drop the
    -- other from the opening read entirely. group_ord stays for section
    -- ORDERING only. On the flat river the cap is bypassed below, so the rank is
    -- inert there.
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
  'p_per_feed_limit (grouping only) caps each section to its newest that-many '
  'rows for the group-by-feed opening view; the per-section "More" pages deeper '
  'via the ''feed'' scope with an offset. Page 1 is bounded to p_limit total '
  'rows. full_content_html, full_content_via_fallback, and ai_summary (+ its '
  'timestamp) are nulled here; the reader loads the full body (and its '
  'provenance) via the allowlist-gated `fulltext` path and the summary via the '
  'allowlist-gated `summary` path. No total count: the client pages off whether '
  'the last page came back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;

-- Invalidate the cached summary when an item's content changes.
--
-- The poller's `upsert_feed_items` (latest in 0033) updates content_html/title
-- in place when a feed re-publishes the same guid (or re-issues the same url
-- under a new guid). Without clearing `ai_summary`, a later `summary` cache hit
-- would serve a gist of the OLD content after the article was edited. Recreate
-- the RPC (verbatim from 0033, same signature so grants are preserved) to NULL
-- `ai_summary` + `ai_summary_generated_at` when the source actually changes:
--   - guid-conflict path: clear only when `content_html`/`title` differs, so an
--     identical re-poll keeps the cached summary (no needless regeneration). We
--     compare the real fields, NOT `content_hash`: the poller sets content_hash
--     to the guid (poll/refresh `content_hash: it.guid`), so it never changes on
--     a same-guid edit and can't be used for change detection;
--   - url-collision path (same url re-issued under a new guid): always clear —
--     a re-issue is a new article, so any prior summary is stale.
create or replace function public.upsert_feed_items(
  p_feed_id uuid,
  p_items   jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  itm jsonb;
begin
  for itm in select * from jsonb_array_elements(p_items)
  loop
    begin
      insert into public.items (
        feed_id, guid, url, comments_url, title, author, published_at,
        content_html, summary, enclosures, content_hash
      )
      values (
        p_feed_id,
        itm->>'guid',
        itm->>'url',
        itm->>'comments_url',
        itm->>'title',
        itm->>'author',
        (itm->>'published_at')::timestamptz,
        itm->>'content_html',
        itm->>'summary',
        coalesce(itm->'enclosures', '[]'::jsonb),
        itm->>'content_hash'
      )
      on conflict (feed_id, guid) do update set
        url          = excluded.url,
        comments_url = excluded.comments_url,
        title        = excluded.title,
        author       = excluded.author,
        published_at = excluded.published_at,
        content_html = excluded.content_html,
        summary      = excluded.summary,
        enclosures   = excluded.enclosures,
        -- Drop the AI summary when the article's text actually changed. We
        -- compare content_html/title, NOT content_hash: the live poller/refresh
        -- set `content_hash = it.guid` (poll/index.ts, refresh/index.ts), so the
        -- hash is stable across a same-guid edit and useless for change
        -- detection. All SET RHS see the pre-update row, so this is the OLD body/
        -- title vs. the incoming ones.
        ai_summary = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
          then null else public.items.ai_summary end,
        ai_summary_generated_at = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
          then null else public.items.ai_summary_generated_at end,
        content_hash = excluded.content_hash;
    exception when unique_violation then
      -- (feed_id, url) partial-unique collision: publisher re-issued the same
      -- article under a new guid. Update the existing row in place (and adopt
      -- the new guid as the canonical identity going forward). A re-issue is a
      -- new article, so always clear the stale summary.
      update public.items set
        guid                    = itm->>'guid',
        comments_url            = itm->>'comments_url',
        title                   = itm->>'title',
        author                  = itm->>'author',
        published_at            = (itm->>'published_at')::timestamptz,
        content_html            = itm->>'content_html',
        summary                 = itm->>'summary',
        enclosures              = coalesce(itm->'enclosures', '[]'::jsonb),
        content_hash            = itm->>'content_hash',
        ai_summary              = null,
        ai_summary_generated_at = null
      where feed_id = p_feed_id
        and url     = itm->>'url';
    end;
  end loop;
end $$;

comment on function public.upsert_feed_items(uuid, jsonb) is
  'Poller-only items upsert that handles BOTH (feed_id, guid) and (feed_id, '
  'url) unique constraints atomically. Falls back to UPDATE on a (feed_id, '
  'url) conflict so a publisher re-issuing the same URL under a new guid '
  'updates the existing row instead of inserting a duplicate. Carries '
  'comments_url (0033). Nulls the cached ai_summary (+ its timestamp) when the '
  'content changes — content_hash differs on the guid path, always on a url '
  're-issue — so an edited article is re-summarized instead of serving a stale '
  'gist (0035). Service-role only — clients have no need to call this.';

revoke execute on function public.upsert_feed_items(uuid, jsonb) from public;
grant  execute on function public.upsert_feed_items(uuid, jsonb) to service_role;
