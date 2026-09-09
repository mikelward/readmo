-- Apply the reader's title filters server-side, in the two RPCs that build the
-- feed: `feed_items` (the list) and `feed_unread_counts` (the badges).
--
-- The client already filters (src/lib/titleFilter.ts, an overlay over the read),
-- so this changes nothing a reader sees in the list itself. It fixes the two
-- things an overlay structurally CANNOT fix, because both are decided before
-- the rows reach the client:
--
--  1. BADGE COUNTS. `feed_unread_counts` is a server-side count. The client
--     never sees the rows behind it, so it cannot subtract the filtered ones —
--     a feed whose unread items are all filtered showed a count for articles
--     the reader had told us to hide.
--  2. THE PER-FEED FLOOR. The floor serves each feed's newest 10 BY DATE
--     (0031), and the client drops filtered rows AFTER that cut. So a feed
--     whose newest 10 all match a filter arrived as ten rows and rendered as
--     none — the feed looked empty while unfiltered older articles sat just
--     behind the floor. Filtering INSIDE the floor's lateral is what frees the
--     slot: the floor becomes the newest 10 the reader can actually see, drawn
--     from a bounded window of the newest 200 (see the lateral for why the
--     bound is not optional).
--
-- PINS STAY EXEMPT, exactly as on the client: candidate set (c) is unfiltered,
-- and a pinned item is a to-do the reader placed there deliberately. Filtering
-- is applied to the freshness window and the floor only.
--
-- BACKWARDS COMPATIBLE IN BOTH DIRECTIONS (guardrail #11). An old client
-- against this backend gets a pre-filtered list and filters it again — the
-- overlay is idempotent, so it's a no-op. A new client against a backend
-- without this migration gets the unfiltered list and its overlay does the
-- whole job, which is exactly today's shipped behavior. Neither half requires
-- the other, so this can deploy on its own clock.
--
-- THE MATCHING CONTRACT IS DUPLICATED, DELIBERATELY, AND THAT IS THE RISK HERE.
-- src/lib/titleFilter.ts is the normative definition; the functions below are a
-- transcription of it, and a divergence would show up as a row the badge counts
-- and the list disagree about. Two things hold them together: the transcription
-- is token-for-token rather than a paraphrase (fold → tokenize → contiguous run
-- with the plural allowance on the head noun only), and
-- supabase/tests/title_filters.sql runs the same corpus of cases that
-- src/lib/titleFilter.test.ts runs. Change one side and you must change both.

-- --- fold: NFD, strip combining marks, lowercase ---------------------------
-- Mirrors titleFilter.ts `fold`. NFD is what moves a Latin diacritic OUT of its
-- base character and into a combining range, so the order matters: normalize
-- first, then strip.
--
-- JS says `\p{M}` — every Unicode mark, in every script. Postgres regex has no
-- property classes, so SOMETHING has to stand in for it, and the choice of what
-- is the most consequential decision in this file. Three review rounds went
-- into the list below and the third one reversed the direction of the previous
-- two, so the reasoning is worth keeping:
--
--   * Too NARROW under-filters: a mark that survives folding is treated as a
--     separator by the tokenizer, one word becomes two tokens, and the server
--     fails to match a title the client matches. The badge over-counts. The
--     reader loses nothing.
--   * Too BROAD over-filters, and that is the dangerous direction: deleting a
--     character the client KEEPS can join two tokens into one the filter
--     matches, and the server then withholds an article the reader can still
--     see listed elsewhere. A row wrongly hidden.
--
-- The second and third rounds here added per-script spans by hand — Hebrew,
-- Arabic, the Indic scripts, Thai, Tibetan, Myanmar — and review found that
-- `\0D3B-\0D57` (Malayalam) contains U+0D4E and U+0D54–U+0D56, which are
-- category Lo. LETTERS. That span deletes them, so `aൎb` folds to `ab` on the
-- server and stays `aൎb` on the client, and an `ab` filter hides an article the
-- client considers visible. Exactly the dangerous direction, introduced while
-- trying to be thorough.
--
-- So the list is now ONLY the blocks Unicode defines as combining marks
-- outright — the ones whose names say so. Those can be trusted without a
-- character-by-character audit; a hand-built span across a living script cannot,
-- as three rounds demonstrated. The cost is real and accepted: a script whose
-- marks live inside its own block (Arabic, Hebrew, the Indic scripts) is
-- under-filtered server-side. That is the SAFE direction — the client still
-- filters those titles correctly, so the reader sees the right list and only a
-- badge can over-count.
--
-- The real fix is not a better list. It is removing the second implementation
-- altogether: a normalized-title column the poller computes with the same JS
-- the client runs. Tracked in TODO.md under *Server RPCs*.
create or replace function public.title_fold(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(
    regexp_replace(
      normalize(coalesce(p_text, ''), NFD),
      U&'[\0300-\036F'          -- Combining Diacritical Marks (what NFD produces for Latin)
        '\0483-\0489'           -- Combining Cyrillic
        '\1AB0-\1AFF'           -- Combining Diacritical Marks Extended
        '\1DC0-\1DFF'           -- Combining Diacritical Marks Supplement
        '\20D0-\20F0'           -- Combining Diacritical Marks for Symbols
        '\302A-\302F'           -- CJK combining tone marks
        '\3099-\309A'           -- Combining kana dakuten / handakuten (NFD of が, ぱ)
        '\FE00-\FE0F'           -- Variation selectors
        '\FE20-\FE2F]',         -- Combining Half Marks
      '',
      'g'
    )
  );
$$;

-- --- tokenize: fold, then split on every non-alphanumeric ------------------
-- Mirrors titleFilter.ts `tokenize`. JS matches [\p{L}\p{N}]+; [[:alnum:]] is
-- the UTF-8 equivalent here. Splitting on every non-alphanumeric is what makes
-- possessives work without a possessive rule: `Trump's` → {trump, s}.
create or replace function public.title_tokens(p_text text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    array_remove(
      regexp_split_to_array(public.title_fold(p_text), '[^[:alnum:]]+'),
      ''
    ),
    '{}'::text[]
  );
$$;

-- --- the head noun's accepted forms ---------------------------------------
-- Mirrors titleFilter.ts `tokenMatches`. ADD-ONLY: every variant is LONGER than
-- what was typed, so it cannot overreach — a variant that isn't a real word
-- (`tariffes`) simply never matches anything. Stripping is what would swallow a
-- feed (`news` → `new`), and it is deliberately absent here as it is there.
-- The `-ies` form is included because the row menu OFFERS that stem: a
-- "companies" headline offers `company`, and without this the reader's pick
-- would not filter the row it came from. Restricted to consonant + `y`, the
-- rule English actually follows.
create or replace function public.title_token_variants(p_token text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[p_token, p_token || 's', p_token || 'es']
    || case
         when p_token ~ '[^aeiou]y$'
           then array[left(p_token, -1) || 'ies']
         else '{}'::text[]
       end;
$$;

-- --- the matcher ----------------------------------------------------------
-- Mirrors titleFilter.ts `titleMatchesFilter`, over every entry in the list.
--
-- Both sides are tokenized and rejoined with single spaces, then padded with
-- one leading and trailing space, so a plain substring search IS a whole-word
-- match — ' trump ' cannot be found inside ' trumpet '. That is the same
-- guarantee the JS gets from comparing token arrays, reached differently
-- because SQL has no cheap nested loop here. Tokens are [[:alnum:]]+ by
-- construction, so no value can carry a pattern metacharacter and strpos needs
-- no escaping.
--
-- A multi-word entry matches a CONTIGUOUS run (the joined form enforces that),
-- and the plural allowance applies to the LAST token only — English pluralizes
-- the head noun (`trade war` → `trade wars`), and widening it to every token
-- would match `trades war` for no gain.
create or replace function public.title_is_filtered(p_title text, p_filters text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  with hay as (
    select ' ' || array_to_string(public.title_tokens(p_title), ' ') || ' ' as s
  ),
  entries as (
    select public.title_tokens(e) as toks
    from unnest(coalesce(p_filters, '{}'::text[])) as e
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
  select exists (
    select 1 from needles, hay where strpos(hay.s, needles.s) > 0
  );
$$;

-- --- the caller's own list -------------------------------------------------
-- SECURITY DEFINER so the feed RPCs (themselves definer) can read it without
-- widening anything: it returns only the CALLER's own row, keyed on auth.uid(),
-- and only this column. Empty array when the user has no settings row, no
-- filters, or the backend predates 0071 — all three mean "filter nothing".
create or replace function public.current_title_filters()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select us.title_filters from public.user_settings us where us.user_id = auth.uid()),
    '{}'::text[]
  );
$$;

revoke execute on function public.current_title_filters() from public;
grant  execute on function public.current_title_filters() to authenticated;


-- --- feed_items ------------------------------------------------------------
-- Verbatim copy of the 0058 body (same 8-arg signature, so `create or replace`
-- keeps the existing grants); the only changes are the `filt` CTE and the two
-- filter predicates in candidate sets (a) and (b).
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
    -- is the pre-0072 plan. (A plain OR would read the same but carries no such
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
                then not public.title_is_filtered(i.title, filt.list)
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
        select i2.id, i2.title, i2.sort_at
        from public.items i2
        where i2.feed_id = sc.feed_id
        order by i2.sort_at desc, i2.id desc
        limit case when filt.has_any then 200 else 10 end
      ) w
      where case when filt.has_any
                 then not public.title_is_filtered(w.title, filt.list)
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
                then not public.title_is_filtered(i.title, filt.list)
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
        select i2.id, i2.title, i2.sort_at
        from public.items i2
        where i2.feed_id = sc.feed_id
        order by i2.sort_at desc, i2.id desc
        limit case when filt.has_any then 200 else 10 end
      ) w
      where case when filt.has_any
                 then not public.title_is_filtered(w.title, filt.list)
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
  'excludes Opened unless the item is pinned. The reader''s title filters (0072) '
  'are applied to the window and the floor and a filtered item consumes no floor '
  'slot; pinned items are exempt. Returns 0 for a subscribed feed with no '
  'candidates.';

revoke execute on function public.feed_unread_counts(uuid[]) from public;
grant  execute on function public.feed_unread_counts(uuid[]) to authenticated;
