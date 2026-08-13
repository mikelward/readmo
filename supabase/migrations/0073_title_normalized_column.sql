-- Move title normalization out of SQL: match against a column the poller
-- computes with the SAME JavaScript the client runs.
--
-- WHY THIS REPLACES 0072. 0072 transcribed src/lib/titleFilter.ts into SQL so
-- the badge counts and the per-feed floor could honor the reader's filters.
-- The transcription's weak seam was `title_fold`: JS says `\p{M}`, Postgres
-- regex has no property classes, so the combining-mark ranges were enumerated
-- by hand. Review found four defects in that one enumeration, and the fourth
-- was not a gap but a reversal of its stated safety property:
--
--   A mark the list does NOT strip survives into `title_tokens`, which splits
--   on it. One word becomes several fragments server-side while the client
--   folds the mark away and keeps the word whole. A filter entry equal to one
--   of those fragments then matches on the server and not on the client, and
--   feed_items WITHHOLDS a row the reader would otherwise see. `a<mark>b` is
--   {a,b} here and `ab` there — so this is not confined to non-Latin scripts
--   either; a mark can sit between two Latin letters, and publisher titles are
--   untrusted input.
--
-- No better list fixes that. The enumeration was wrong four times and, more to
-- the point, there was no way to know it was wrong: two attempts to state which
-- scripts it missed were both short, by two different methods. So this
-- migration stops folding in SQL entirely.
--
-- THE SHAPE. `items.title_normalized` holds the folded, tokenized title
-- rejoined with single spaces and wrapped in one leading and trailing space:
--
--     "Trump's tariffs"  ->  ' trump s tariffs '
--
-- It is computed in Deno by supabase/functions/_shared/titleFilterCore.ts, a
-- byte-identical copy of src/lib/titleFilterCore.ts (a test enforces that), so
-- there is exactly one definition of what folding and tokenizing mean. What is
-- left for SQL is `strpos` over ASCII-delimited text, which needs no Unicode
-- knowledge at all and cannot split a word at a character it fails to
-- recognize. The over-filtering direction closes by construction.
--
-- THE STORED FILTER ENTRIES ARE ASSUMED CANONICAL, and that assumption is load
-- bearing: this file splits each entry on ' ' and uses it as a needle without
-- folding it, because folding in SQL is exactly what this migration removes.
-- `useTitleFilters` normalizes on write (pinned by a test in
-- useReadingPrefs.test.tsx, since the invariant now has SQL depending on it) and
-- the mapper normalizes again on read, so both the stored value and the client's
-- copy are canonical.
--
-- If a row were hand-edited to something non-canonical anyway — 0071 puts no
-- constraint on the column — the needle would simply fail to match: verified,
-- `title_is_filtered(' pena s tariffs ', array['Peña''s tariffs'])` is false
-- where the canonical entry is true. That is the UNDER-filtering direction: the
-- client still hides the article correctly, while the badge over-counts it and
-- it spends a floor slot. Repairing it in the database is not possible here
-- (canonicality is only decidable by running the JS normalizer), and repairing
-- it from a poller pass would mean a second backlog with its own epoch and
-- compare-and-swap — the machinery this design exists to avoid, for a state the
-- write path does not produce.
--
-- WHAT SURVIVES. `normalize()` and the property tables come from each runtime's
-- own Unicode data, so a Deno upgrade or an old browser engine can still fold
-- differently with no source change. `title_normalized_version` exists for
-- exactly that: bump the constant and the poller's backfill pass re-derives
-- every row. That residue is smaller than 0072's by a wide margin but it is not
-- zero, and only pinning the Unicode implementation on both sides would make it
-- zero. Recorded in TODO.md rather than chased.
--
-- NULL-TOLERANT. A row whose normalization has not been computed yet stores
-- NULL, and NULL matches nothing, so it is UNDER-filtered until the backfill
-- reaches it — the badge over-counts and it holds a floor slot. That is the
-- direction that costs the reader nothing.

alter table public.items
  add column if not exists title_normalized text,
  add column if not exists title_normalized_version smallint;

comment on column public.items.title_normalized is
  'Folded/tokenized title, space-joined and space-wrapped (" trump s tariffs "), '
  'computed by _shared/titleFilterCore.ts — the byte-identical twin of the '
  'client module. NULL until the poller backfill reaches the row; NULL matches '
  'no filter, which under-filters rather than hiding an article.';
comment on column public.items.title_normalized_version is
  'Which revision of the normalizer produced title_normalized. Bump '
  'TITLE_NORMALIZED_VERSION in _shared/titleFilterCore.ts when fold/tokenize '
  'change semantics; the backfill pass then re-derives every stale row.';

-- The backfill backlog: rows never normalized, plus rows left on an older
-- normalizer. A plain B-tree over (version, id) serves BOTH — NULLs sort
-- together and `version < CURRENT` is a range scan — so a version bump needs no
-- new DDL. `id` is the stable batch key that makes the scan resumable.
create index if not exists items_title_normalized_backlog_idx
  on public.items (title_normalized_version, id);

-- --- the matcher ----------------------------------------------------------
-- Same contract as 0072's, minus the folding. Both sides arrive already folded
-- and tokenized, so a plain substring search IS a whole-word match: ' trump '
-- cannot be found inside ' trumpet '. Tokens are [\p{L}\p{N}]+ by construction,
-- so no value can carry a pattern metacharacter and strpos needs no escaping.
--
-- A multi-word entry matches a CONTIGUOUS run (the joined form enforces that),
-- and the plural allowance applies to the LAST token only — English pluralizes
-- the head noun (`trade war` -> `trade wars`), and widening it to every token
-- would match `trades war` for no gain.
--
-- THE FIRST ARGUMENT IS NOW THE NORMALIZED TITLE, not a raw one. Passing a raw
-- title here silently under-matches; the only callers are the two RPCs below,
-- which pass items.title_normalized. The parameter is renamed to say so, and
-- that forces a DROP: `create or replace` cannot rename an input parameter
-- ("cannot change name of input parameter"), which is how 0073 failed to apply
-- the first time. Dropping is safe here — 0072 left this function on the
-- default EXECUTE-to-PUBLIC, so there is no explicit grant to lose (unlike
-- feed_items and current_title_filters, which are revoked and re-granted).
drop function if exists public.title_is_filtered(text, text[]);

create function public.title_is_filtered(p_title_normalized text, p_filters text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  with entries as (
    select string_to_array(e, ' ') as toks
    from unnest(coalesce(p_filters, '{}'::text[])) as e
    where e <> ''
  ),
  needles as (
    select
      ' '
      || case
           when cardinality(toks) > 1
             then array_to_string(toks[1:cardinality(toks) - 1], ' ') || ' '
           else ''
         end
      || v
      || ' ' as s
    from entries
    cross join lateral unnest(
      public.title_token_variants(toks[cardinality(toks)])
    ) as v
    where cardinality(toks) >= 1
  )
  select coalesce(
    exists (select 1 from needles where strpos(p_title_normalized, needles.s) > 0),
    false
  );
$$;

comment on function public.title_is_filtered(text, text[]) is
  'Whether an ALREADY-NORMALIZED title (items.title_normalized) matches any of '
  'the reader''s already-normalized filter entries. Pure ASCII-delimited '
  'substring work: the Unicode half is done in JS by titleFilterCore.ts. A NULL '
  'title_normalized matches nothing.';

-- 0072's SQL folding/tokenizing is gone. Dropping it rather than leaving it to
-- rot is the point of the change: while it exists someone can call it, and
-- every caller inherits the hand-enumerated mark ranges and the word-splitting
-- they cause.
drop function if exists public.title_fold(text);
drop function if exists public.title_tokens(text);


-- --- apply a batch of normalizations in ONE round trip ---------------------
-- The backfill computes title_normalized in Deno (only JS can fold), but the
-- WRITES don't have to go back one row at a time. A per-row PostgREST update
-- meant up to 500 serial round trips inside the poll's wall clock, after its
-- feed loop and the spoiler pass have already spent most of it — ordinary
-- database latency could then push the scheduled invocation past its limit or
-- overlap the next run (Codex P2 on #628). Same shape as upsert_feed_items: the
-- caller sends a jsonb array, the loop stays server-side.
--
-- The compare-and-swap moves in here with it, and must stay: this is a
-- read-compute-write across a gap, so a refresh can change the title between
-- the pass reading it and this writing. Without the guard the OLD title's
-- normalization would land at the CURRENT version, which no later batch
-- revisits — the server would filter that article forever on text it no longer
-- has. Losing the race just leaves the row in the backlog. `is not distinct
-- from` because items.title is nullable and `= NULL` is never true, so an
-- untitled row could otherwise never satisfy its own guard.
--
-- Returns the number of rows actually updated, which is what makes a lost race
-- observable — a per-row PostgREST update reports no error for a zero-row
-- write, so the caller previously could not tell one from a success.
create or replace function public.apply_title_normalizations(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       jsonb;
  updated int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    update public.items i set
      title_normalized         = r->>'title_normalized',
      title_normalized_version = (r->>'title_normalized_version')::smallint
    where i.id = (r->>'id')::uuid
      and i.title is not distinct from (r->>'title');
    if found then
      updated := updated + 1;
    end if;
  end loop;
  return updated;
end $$;

comment on function public.apply_title_normalizations(jsonb) is
  'Poller-only batch write of items.title_normalized, guarded by a '
  'compare-and-swap on the title each value was computed from. One round trip '
  'per batch. Returns the number of rows updated; the difference from the batch '
  'size is rows whose title moved under the pass, which stay in the backlog.';

revoke execute on function public.apply_title_normalizations(jsonb) from public;
grant  execute on function public.apply_title_normalizations(jsonb) to service_role;

-- --- upsert_feed_items: store the normalization alongside the title ---------
-- Recreated from 0055 (body otherwise verbatim) because that definition
-- enumerates its columns explicitly and would silently ignore the two new keys.
-- Passing them from the row mapper is not enough on its own.
--
-- The dangerous case is not a missing normalization, it is a STALE one. A
-- publisher editing an existing article's title would update `title` while
-- title_normalized and its version stayed put — and because the backfill's
-- backlog is "null version, or older than current", a row left at the CURRENT
-- version is never revisited. The server would filter that article forever on
-- text it no longer has, which is the article-hiding direction. Writing the
-- pair together on every path that writes `title` is what makes that
-- unrepresentable.
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
        content_html, summary, enclosures, content_hash,
        title_normalized, title_normalized_version
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
        itm->>'content_hash',
        itm->>'title_normalized',
        (itm->>'title_normalized_version')::smallint
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
        content_hash = excluded.content_hash,
        -- Written from the SAME payload item as `title`, so the pair cannot go
        -- stale. A caller that predates the column sends neither, which stores
        -- NULL/NULL and puts the row in the backfill backlog — the safe
        -- direction. What must NEVER happen is `title` moving while these keep
        -- a current version, because the backlog predicate would then skip the
        -- row forever and the server would filter it on text it no longer has.
        title_normalized = excluded.title_normalized,
        title_normalized_version = excluded.title_normalized_version;
    exception when unique_violation then
      -- (feed_id, url) partial-unique collision: publisher re-issued the same
      -- article under a new guid. Update in place (and adopt the new guid). A
      -- re-issue is a new article, so always clear the stale derived fields.
      -- Match on the CANONICAL url (v_url) so the WHERE lines up with what the
      -- trigger stored.
      begin
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
          title_normalized                = itm->>'title_normalized',
          title_normalized_version        = (itm->>'title_normalized_version')::smallint,
          ai_summary                      = null,
          ai_summary_generated_at         = null,
          spoiler_free_title              = null,
          spoiler_free_title_generated_at = null
        where feed_id = p_feed_id
          and url     = v_url;
      exception when unique_violation then
        -- Guid adoption collided: a DIFFERENT row in this feed still holds the
        -- incoming guid (guid/url swap, partial re-issue). Retry without the
        -- guid change so the content still lands on the url survivor and the
        -- batch survives — this violation used to escape the outer handler and
        -- roll back the whole per-feed batch on every poll (a stuck feed).
        update public.items set
          comments_url                    = itm->>'comments_url',
          title                           = itm->>'title',
          author                          = itm->>'author',
          published_at                    = (itm->>'published_at')::timestamptz,
          content_html                    = itm->>'content_html',
          summary                         = itm->>'summary',
          enclosures                      = coalesce(itm->'enclosures', '[]'::jsonb),
          content_hash                    = itm->>'content_hash',
          title_normalized                = itm->>'title_normalized',
          title_normalized_version        = (itm->>'title_normalized_version')::smallint,
          ai_summary                      = null,
          ai_summary_generated_at         = null,
          spoiler_free_title              = null,
          spoiler_free_title_generated_at = null
        where feed_id = p_feed_id
          and url     = v_url;
      end;
    end;
  end loop;
end $$;


-- --- feed_items ------------------------------------------------------------
-- Body unchanged from 0072 except the filter predicates, which now read the
-- precomputed items.title_normalized instead of folding items.title in SQL.
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
  limit  greatest(coalesce(p_limit, 30), 0)
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
  'is bounded to p_limit total rows. full_content_html / '
  'full_content_via_fallback are always nulled (reader loads the body via the '
  'allowlist-gated `fulltext` path); ai_summary rides the row for an allowlisted '
  'caller and is nulled for everyone else (0058), and ai_summary_generated_at '
  'stays nulled. No total count: the client pages off whether the last page came '
  'back full.';

revoke execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) from public;
grant  execute on function public.feed_items(text, text, uuid, int, int, text, boolean, int) to authenticated;


-- --- feed_unread_counts ----------------------------------------------------
-- Same three candidate sets, same two filter predicates, same pinned exemption.
-- This is the half the client could never do for itself: the count is computed
-- here and only the number crosses the wire.
create or replace function public.feed_unread_counts(p_feed_ids uuid[])
returns table (feed_id uuid, n bigint)
language sql
security definer
set search_path = ''
as $$
  with filt as (
    select f as list, cardinality(f) > 0 as has_any
    from public.current_title_filters() as f
  ),
  scoped as (
    -- The caller's own subscriptions among the requested feeds (RLS boundary).
    select s.feed_id
    from public.subscriptions s
    where s.user_id = auth.uid()
      and s.feed_id = any(p_feed_ids)
  ),
  cand as (
    -- The feed's listable item ids — the same three index-bounded sets the
    -- feed_items body is built from (freshness window ∪ per-feed floor ∪ pinned),
    -- carrying the same title filtering so the badge and the list agree.
    -- (a) freshness window — index range scan for the last 3 days.
    select i.id, sc.feed_id
    from scoped sc
    cross join filt
    join public.items i on i.feed_id = sc.feed_id
    where i.sort_at > now() - interval '3 days'
      and case when filt.has_any
                then not public.title_is_filtered(i.title_normalized, filt.list)
                else true end
    union
    -- (b) per-feed floor — newest 10 BY DATE, irrespective of state (LATERAL
    -- stops after 10). Dismissed items still occupy a slot; they're excluded
    -- from the count filter below, so a dismissed recent item is no longer
    -- backfilled by an older one (which is what stuck the badge at 10). A
    -- FILTERED item occupies no slot at all (0072) — same rule as feed_items.
    select t.id, sc.feed_id
    from scoped sc
    cross join filt
    cross join lateral (
      -- Same bounded window as feed_items, and it has to STAY the same: the
      -- badge counts what the list serves, so a different window here would
      -- reintroduce the disagreement this migration exists to remove.
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
    -- (c) pinned, any age. Exempt from filtering, as in feed_items.
    select st.item_id as id, i.feed_id
    from public.item_state st
    join public.items i on i.id = st.item_id
    join scoped sc on sc.feed_id = i.feed_id
    where st.user_id = auth.uid() and st.pinned
  )
  select
    sc.feed_id,
    -- Count the listable items that are unread/to-do: not Done and not active
    -- Hidden, and either pinned OR not active Opened — a pinned item always
    -- counts (a pin is a to-do, read or not); other items drop out once Opened.
    -- (Done/Hidden/Opened each TTL'd at 30 days, matching withRetention / 0018.)
    -- count(c.id) ignores the NULL produced for a feed with no candidates → 0.
    count(c.id) filter (
      where not (coalesce(s.done,   false) and s.done_at   > now() - interval '30 days')
        and not (coalesce(s.hidden, false) and s.hidden_at > now() - interval '30 days')
        and (coalesce(s.pinned, false)
             or not (coalesce(s.opened, false) and s.opened_at > now() - interval '30 days'))
    ) as n
  from scoped sc
  left join cand c on c.feed_id = sc.feed_id
  left join public.item_state s on s.item_id = c.id and s.user_id = auth.uid()
  group by sc.feed_id;
$$;

comment on function public.feed_unread_counts(uuid[]) is
  'Per-feed unread/to-do badge count over the same candidate sets feed_items '
  'serves (freshness window ∪ per-feed floor ∪ pinned), so the badge can never '
  'promise rows the list won''t show. Excludes Done and active Hidden, and '
  'excludes Opened unless the item is pinned. The reader''s title filters (0073) '
  'are applied to the window and the floor and a filtered item consumes no floor '
  'slot; pinned items are exempt. Returns 0 for a subscribed feed with no '
  'candidates.';

revoke execute on function public.feed_unread_counts(uuid[]) from public;
grant  execute on function public.feed_unread_counts(uuid[]) to authenticated;
