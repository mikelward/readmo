-- Readmo items dedup, part 2 — canonicalize item URLs so cosmetic re-issues
-- collapse under the existing (feed_id, url) unique index.
--
-- 0013 added `unique (feed_id, url) where url is not null` + upsert_feed_items
-- so a publisher re-issuing the same article under a NEW <guid> updates the
-- existing row instead of inserting a duplicate. That works only when the URL
-- is byte-identical. Publishers (notably the BBC) re-issue the same story with
-- a rotating campaign query tag (`?at_medium=RSS&at_campaign=…`), so the raw
-- URLs differ and the SAME headline lands two or three times in one feed —
-- exactly the dupes seen in the BBC News feed.
--
-- The fix has two halves:
--   * Going forward, the parser (supabase/functions/_shared/parser.ts,
--     `canonicalizeItemUrl`) strips known tracking params before the URL is
--     stored, so every new write is already canonical and the 0013 unique index
--     de-dups re-issues on its own. Both writers (poll + refresh) build rows
--     from the parser, so both inherit it.
--   * This migration cleans up the rows ALREADY stored in their raw form:
--     canonicalize every items.url, collapse the resulting same-canonical dupes
--     (merging item_state like 0013), and rewrite survivors to the canonical
--     form so future canonical writes de-dup against them.
--
-- The FRAGMENT is deliberately NOT stripped — it's part of the URL's identity
-- and is routinely load-bearing (SPA routes, liveblog/update anchors incl. bare
-- numeric ones). The BBC version counter rides on the <guid>, not the <link>,
-- so dropping fragments would risk collapsing distinct articles for no benefit.
--
-- `canonicalize_item_url()` below is the SQL twin of the TS `canonicalizeItemUrl`
-- — keep the tracking-key list in sync. The TS version governs new writes; this
-- one exists only to collapse the historical backlog.

-- ---------------------------------------------------------------------------
-- Canonicalization function (SQL twin of parser.ts `canonicalizeItemUrl`).
-- Removes tracking/campaign query params, preserving the order + values of the
-- params it keeps AND the fragment. Unknown params are kept (they may be
-- load-bearing); the path is untouched.
-- ---------------------------------------------------------------------------

create or replace function public.canonicalize_item_url(p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Keep in sync with TRACKING_PARAM_KEYS in
  -- supabase/functions/_shared/parser.ts.
  tracking constant text[] := array[
    -- Google / generic UTM.
    'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
    'utm_id','utm_name','utm_reader','utm_brand',
    -- BBC at_* campaign tags.
    'at_medium','at_campaign','at_campaign_type','at_custom1','at_custom2',
    'at_custom3','at_custom4','at_bbc_team','at_link_origin','at_ptr_name',
    -- Social / ad click identifiers.
    'fbclid','gclid','dclid','gbraid','wbraid','msclkid','yclid','twclid',
    'mc_cid','mc_eid','igshid',
    -- Other common newsroom campaign params.
    'ito','ns_campaign','ns_mchannel','ns_source','ns_linkname','ns_fee',
    'cmp','ocid','ncid','spm'
  ];
  base    text;
  frag    text := '';
  query   text;
  hash_p  int;
  q_pos   int;
  pair    text;
  kept    text[] := '{}';
begin
  if p_url is null then
    return null;
  end if;
  -- Split off the fragment and ALWAYS preserve it — it's part of the URL's
  -- identity and is routinely load-bearing (hash-router routes `#/…`, or
  -- liveblog/update anchors like `#block-123` / a bare numeric `#124` that
  -- distinguish separate entries on one page). We only strip query tracking
  -- params below. Mirrors parser.ts.
  hash_p := position('#' in p_url);
  if hash_p = 0 then
    base := p_url;
  else
    base := substring(p_url from 1 for hash_p - 1);
    frag := substring(p_url from hash_p);
  end if;
  q_pos := position('?' in base);
  if q_pos = 0 then
    return base || frag;
  end if;
  query := substring(base from q_pos + 1);
  base  := substring(base from 1 for q_pos - 1);
  foreach pair in array regexp_split_to_array(query, '&') loop
    continue when pair = '';
    -- Compare the key (before '=') case-insensitively against the tracking set.
    if lower(split_part(pair, '=', 1)) <> all (tracking) then
      kept := array_append(kept, pair);
    end if;
  end loop;
  if array_length(kept, 1) is null then
    return base || frag;
  end if;
  return base || '?' || array_to_string(kept, '&') || frag;
end $$;

comment on function public.canonicalize_item_url(text) is
  'Canonicalizes an article URL for de-dup: strips known tracking/campaign '
  'query params (BBC at_*, UTM, click ids) and preserves the path + fragment '
  '(fragments are load-bearing: SPA routes, liveblog anchors). SQL twin of '
  'canonicalizeItemUrl in parser.ts. Used by the items_canonicalize_url write '
  'trigger and to collapse the historical backlog in migration 0048.';

-- ---------------------------------------------------------------------------
-- Serialize the one-shot cleanup against concurrent item writers. This whole
-- file runs in one transaction, but the cron poller / refresh Edge Functions
-- can call the (still-old, non-canonicalizing) `upsert_feed_items` while
-- `make migrate` runs. Without this lock, a raw BBC-style row inserted between
-- the collapse and the url-rewrite below could (a) make the rewrite collide on
-- `items_feed_url_unique_idx`, failing the migration, or (b) survive as a raw
-- duplicate. SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE that
-- INSERT/UPDATE/DELETE take, so it blocks those writers for the (brief, bounded
-- by dupe count) duration while still allowing concurrent SELECTs (feed reads
-- are unaffected). On COMMIT the lock releases AND the replaced RPC (section 3)
-- becomes visible, so the very next poller call — even from an un-redeployed
-- Edge Function — canonicalizes. Writers that blocked simply proceed after.
-- ---------------------------------------------------------------------------

lock table public.items in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1) Collapse existing dupes that share a canonical URL. Keep the newest
--    (created_at desc, id desc), fold each user's per-field item_state across
--    ALL the collapsing rows (survivor + dupes) onto the survivor, then delete
--    the dupes (item_state cascades).
--
--    Unlike 0013, this runs AFTER 0023 replaced the version/bump machinery with
--    per-field LAST-WRITE-WINS: each flag carries a `<f>_at` last-change clock,
--    and set_item_state resolves a write by comparing `p_<f>_at` against the
--    stored `<f>_at` (a NULL stored clock means "never written", so any incoming
--    write wins). 0013's boolean-only bool_or merge relied on the since-dropped
--    0003 trigger to stamp `<f>_at = now()`; without it a boolean-only merge
--    would leave a true flag with a NULL clock, which (a) breaks the opened/done
--    TTL + library reads that key off `<f>_at`, and (b) lets a stale offline
--    replay win as if the field were never written. So carry BOTH the value and
--    its clock:
--      * value  = the flag from whichever collapsing row has the newest `<f>_at`
--                 (per-field LWW argmax; NULLS LAST so a real action beats an
--                 untouched row), and
--      * `<f>_at` = max(<f>_at) — the field's most recent change time.
--    Then apply pin > {done, hidden} exclusivity on the merged value (a story
--    pinned on one dupe and done on another lands pinned), keeping each field's
--    clock so a later, newer triage write still flips it under LWW.
-- ---------------------------------------------------------------------------

do $$
declare
  rec record;
begin
  for rec in
    select
      feed_id,
      (array_agg(id order by created_at desc, id desc))[1]  as keep_id,
      (array_agg(id order by created_at desc, id desc))[2:] as dupe_ids,
      array_agg(id) as all_ids
    from public.items
    where url is not null
    group by feed_id, public.canonicalize_item_url(url)
    having count(*) > 1
  loop
    -- Aggregate over all_ids (survivor + dupes) so `excluded` already carries
    -- the fully-merged state; the ON CONFLICT then just overwrites the
    -- survivor's existing row with it.
    insert into public.item_state as st (
      user_id, item_id,
      pinned,   pinned_at,
      favorite, favorite_at,
      done,     done_at,
      hidden,   hidden_at,
      opened,   opened_at
    )
    select
      s.user_id, rec.keep_id,
      -- pin wins over done/hidden after the per-field LWW pick.
      s.pinned,                     s.pinned_at,
      s.favorite,                   s.favorite_at,
      s.done   and not s.pinned,    s.done_at,
      s.hidden and not s.pinned,    s.hidden_at,
      s.opened,                     s.opened_at
    from (
      select
        user_id,
        (array_agg(pinned   order by pinned_at   desc nulls last))[1] as pinned,
        max(pinned_at)   as pinned_at,
        (array_agg(favorite order by favorite_at desc nulls last))[1] as favorite,
        max(favorite_at) as favorite_at,
        (array_agg(done     order by done_at     desc nulls last))[1] as done,
        max(done_at)     as done_at,
        (array_agg(hidden   order by hidden_at   desc nulls last))[1] as hidden,
        max(hidden_at)   as hidden_at,
        (array_agg(opened   order by opened_at   desc nulls last))[1] as opened,
        max(opened_at)   as opened_at
      from public.item_state
      where item_id = any(rec.all_ids)
      group by user_id
    ) s
    on conflict (user_id, item_id) do update set
      pinned      = excluded.pinned,   pinned_at   = excluded.pinned_at,
      favorite    = excluded.favorite, favorite_at = excluded.favorite_at,
      done        = excluded.done,     done_at     = excluded.done_at,
      hidden      = excluded.hidden,   hidden_at   = excluded.hidden_at,
      opened      = excluded.opened,   opened_at   = excluded.opened_at;

    -- Preserve item-level cached payloads before the dupes are dropped. The
    -- survivor is the newest row, but an OLDER dupe may hold a cache the
    -- survivor lacks (e.g. the user opened the old dupe, so full-text was
    -- fetched onto it) — deleting it would lose that reading body / summary /
    -- spoiler title until a refetch or regeneration. Fill each cache field the
    -- survivor is missing from the freshest dupe that has it (per-group scalar
    -- pick, ordered by the group's own timestamp), sourcing paired
    -- value/flag/clock columns from that same row.
    --
    -- DERIVED caches (ai_summary, spoiler_free_title) are only carried from a
    -- dupe whose SOURCE fields match the survivor's — mirroring the 0045 RPC,
    -- which nulls them when the content changes. The survivor is the newest
    -- re-issue, so if an older dupe's title/body differs, its summary/spoiler is
    -- stale for the survivor's content; skipping the copy leaves the field null
    -- so it re-derives, rather than showing an old summary for the new article.
    -- (ai_summary matches on content_html+title; the spoiler classifier also
    -- reads `summary`, so it matches on summary too — same predicate the RPC
    -- uses.) full_content_html + comments_url are NOT content-derived (the RPC
    -- never invalidates them on re-issue), so they carry unconditionally.
    update public.items k set
      full_content_html         = coalesce(k.full_content_html,       ft.full_content_html),
      -- via_fallback is NOT NULL (default false), so it can't be coalesced; take
      -- it from the same dupe as the html only when the survivor had none.
      full_content_via_fallback = case
        when k.full_content_html is null and ft.full_content_html is not null
          then ft.full_content_via_fallback
        else k.full_content_via_fallback end,
      full_content_fetched_at   = coalesce(k.full_content_fetched_at, ft.full_content_fetched_at),
      ai_summary                = coalesce(k.ai_summary,              sm.ai_summary),
      ai_summary_generated_at   = coalesce(k.ai_summary_generated_at, sm.ai_summary_generated_at),
      spoiler_free_title              = coalesce(k.spoiler_free_title,              sp.spoiler_free_title),
      spoiler_free_title_generated_at = coalesce(k.spoiler_free_title_generated_at, sp.spoiler_free_title_generated_at),
      comments_url              = coalesce(k.comments_url,            cu.comments_url)
    from (select id, content_html, title, summary
            from public.items where id = rec.keep_id) key
    left join lateral (
      select full_content_html, full_content_via_fallback, full_content_fetched_at
      from public.items
      where id = any(rec.dupe_ids) and full_content_html is not null
      order by full_content_fetched_at desc nulls last, id desc limit 1
    ) ft on true
    left join lateral (
      select ai_summary, ai_summary_generated_at
      from public.items
      where id = any(rec.dupe_ids) and ai_summary is not null
        and content_html is not distinct from key.content_html
        and title        is not distinct from key.title
      order by ai_summary_generated_at desc nulls last, id desc limit 1
    ) sm on true
    left join lateral (
      select spoiler_free_title, spoiler_free_title_generated_at
      from public.items
      where id = any(rec.dupe_ids) and spoiler_free_title is not null
        and content_html is not distinct from key.content_html
        and title        is not distinct from key.title
        and summary      is not distinct from key.summary
      order by spoiler_free_title_generated_at desc nulls last, id desc limit 1
    ) sp on true
    left join lateral (
      select comments_url
      from public.items
      where id = any(rec.dupe_ids) and comments_url is not null
      order by id desc limit 1
    ) cu on true
    where k.id = key.id;

    -- item_fulltext_status (admin diagnostic, item_id PK, cascades on delete):
    -- keep the most recent attempt visible for the survivor if it has none.
    insert into public.item_fulltext_status (
      item_id, status, http_status, error, robots_rule, attempted_at
    )
    select rec.keep_id, status, http_status, error, robots_rule, attempted_at
    from public.item_fulltext_status
    where item_id = any(rec.dupe_ids)
    order by attempted_at desc
    limit 1
    on conflict (item_id) do nothing;

    delete from public.items where id = any(rec.dupe_ids);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Rewrite every surviving url to its canonical form. After step 1 each
--    (feed_id, canonical url) group has exactly one row, so setting
--    url := canonical(url) can't collide on the 0013 unique index. Future
--    canonical writes from the poller now de-dup against these rows.
-- ---------------------------------------------------------------------------

update public.items
  set url = public.canonicalize_item_url(url)
  where url is not null
    and url is distinct from public.canonicalize_item_url(url);

-- The 0013 `items_feed_url_unique_idx` already enforces uniqueness on the raw
-- url column; because every url is now canonical, it enforces canonical
-- uniqueness going forward. No new index needed.

-- ---------------------------------------------------------------------------
-- 3) Canonicalize at the WRITE boundary too. The parser change makes the
--    poll/refresh functions store canonical URLs, but those Edge Functions
--    deploy on a different clock than this migration (`make deploy` runs
--    `make migrate` FIRST, then redeploys the functions — SETUP.md §6). In that
--    window an OLD poll/refresh can still write a RAW BBC-style URL, re-splitting
--    a story back into two rows after the one-shot backfill has run. Two
--    complementary mechanisms close the window; both are needed:
--
--    (a) A row-level BEFORE trigger canonicalizes items.url on EVERY write,
--        regardless of which function body performs it — including an old RPC
--        invocation already mid-execution when this migration commits (function
--        resolution is per-call, so a `create or replace` alone can't reach it).
--        This guarantees no raw row is ever stored, so no DUPLICATE can appear.
--
--    (b) upsert_feed_items also canonicalizes the incoming url into `v_url`. The
--        trigger stops a dupe, but the RPC's (feed_id, url) collision fallback
--        must still FIND the canonical survivor to fold the re-issue's new
--        guid/title/body into it — an exception handler matching `where url =
--        itm->>'url'` (the raw value) matches zero rows against the canonical
--        survivor and silently drops the re-issue. Canonicalizing the lookup
--        makes an old Edge Function passing a raw URL update the survivor
--        instead of dropping it. This is the 0045 body VERBATIM (comments_url
--        from 0033; ai_summary / spoiler_free_title change-invalidation from
--        0035 / 0045 on both paths) with only the `v_url` delta — keep in sync
--        with 0045 if that body changes.
--
--    `BEFORE INSERT OR UPDATE OF url` fires on every insert and only on updates
--    that target url (content-only cache writes from fulltext/summary don't pay
--    for it). canonicalize_item_url is idempotent, so re-canonicalizing an
--    already-canonical url (the redeployed poll's normal path, the RPC's own
--    v_url, or the step-2 rewrite above) is a no-op.
-- ---------------------------------------------------------------------------

create or replace function public.canonicalize_item_url_trg()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.url := public.canonicalize_item_url(new.url);
  return new;
end $$;

comment on function public.canonicalize_item_url_trg() is
  'BEFORE INSERT/UPDATE-OF-url trigger fn: canonicalizes items.url on every '
  'write so the (feed_id, url) de-dup key holds no matter which caller (or which '
  'not-yet-redeployed Edge Function body) performs the write. See migration 0048.';

drop trigger if exists items_canonicalize_url on public.items;
create trigger items_canonicalize_url
  before insert or update of url on public.items
  for each row execute function public.canonicalize_item_url_trg();

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
  itm   jsonb;
  v_url text;
begin
  for itm in select * from jsonb_array_elements(p_items)
  loop
    -- Canonicalize the incoming URL so the (feed_id, url) collision fallback
    -- below matches the canonical survivor even when an old caller sends a raw
    -- URL. (The trigger canonicalizes the stored value regardless; this makes
    -- the WHERE line up so the re-issue updates instead of being dropped.)
    v_url := public.canonicalize_item_url(itm->>'url');
    begin
      insert into public.items (
        feed_id, guid, url, comments_url, title, author, published_at,
        content_html, summary, enclosures, content_hash
      )
      values (
        p_feed_id,
        itm->>'guid',
        v_url,
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
        -- set `content_hash = it.guid`, so the hash is stable across a same-guid
        -- edit and useless for change detection. All SET RHS see the pre-update
        -- row, so this is the OLD body/title vs. the incoming ones.
        ai_summary = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
          then null else public.items.ai_summary end,
        ai_summary_generated_at = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
          then null else public.items.ai_summary_generated_at end,
        -- Change-detection for the spoiler-free title: a changed headline or body
        -- re-queues it (generated_at → null) for the next poll's pass. This ALSO
        -- watches `summary` (unlike the ai_summary block above): the spoiler
        -- classifier's input is `content_html` ?? `summary` (spoilerContentText),
        -- so for a JSON-Feed-style item with no content_html a changed summary
        -- changes the model input and must re-classify. (ai_summary reads
        -- full_content_html ?? content_html, never `summary`, so it correctly
        -- ignores it.) A summary-only change while content_html is present
        -- re-classifies unnecessarily, but that's bounded by the per-poll budget +
        -- shared cache and is negligible.
        spoiler_free_title = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
            or public.items.summary is distinct from excluded.summary
          then null else public.items.spoiler_free_title end,
        spoiler_free_title_generated_at = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
            or public.items.summary is distinct from excluded.summary
          then null else public.items.spoiler_free_title_generated_at end,
        content_hash = excluded.content_hash;
    exception when unique_violation then
      -- (feed_id, url) partial-unique collision: publisher re-issued the same
      -- article under a new guid. Update in place (and adopt the new guid). A
      -- re-issue is a new article, so always clear the stale derived fields.
      -- Match on the CANONICAL url (v_url) so the WHERE lines up with what the
      -- trigger stored.
      update public.items set
        guid                            = itm->>'guid',
        comments_url                    = itm->>'comments_url',
        title                           = itm->>'title',
        author                          = itm->>'author',
        published_at                    = (itm->>'published_at')::timestamptz,
        content_html                    = itm->>'content_html',
        summary                         = itm->>'summary',
        enclosures                      = coalesce(itm->'enclosures', '[]'::jsonb),
        content_hash                    = itm->>'content_hash',
        ai_summary                      = null,
        ai_summary_generated_at         = null,
        spoiler_free_title              = null,
        spoiler_free_title_generated_at = null
      where feed_id = p_feed_id
        and url     = v_url;
    end;
  end loop;
end $$;

comment on function public.upsert_feed_items(uuid, jsonb) is
  'Poller-only items upsert across BOTH (feed_id, guid) and (feed_id, url) '
  'unique constraints. Canonicalizes the incoming url (canonicalize_item_url, '
  '0048) so the (feed_id, url) collision fallback matches the canonical survivor '
  'even for a raw URL from a not-yet-redeployed caller. Carries comments_url '
  '(0033); nulls the cached ai_summary (0035) and spoiler_free_title (0045) — '
  'plus timestamps — when content changes (always on a url re-issue). The '
  'items_canonicalize_url trigger enforces canonical storage independently. '
  'Service-role only. Keep the body in sync with 0045.';

-- Re-assert the lockdown from 0013 (create-or-replace preserves grants, but be
-- explicit so a fresh apply order can't leave it EXECUTE-to-PUBLIC).
revoke execute on function public.upsert_feed_items(uuid, jsonb) from public;
grant  execute on function public.upsert_feed_items(uuid, jsonb) to service_role;
