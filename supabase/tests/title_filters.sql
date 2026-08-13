-- Regression test for 0073_title_normalized_column.sql and
-- 0074_title_filter_exact_match.sql.
--
-- WHAT MOVED. 0072 transcribed src/lib/titleFilter.ts into SQL, and this file
-- used to run the client's whole matching corpus against that transcription to
-- keep the two in step. There is no transcription any more: 0073 matches
-- against items.title_normalized, which the poller computes with a
-- byte-identical copy of the client module. So the corpus lives where the
-- folding does — src/lib/titleFilterCore.test.ts asserts the client and the
-- server agree case for case, and titleFilterCore.identity.test.ts asserts the
-- two copies of the module are the same bytes. Both run in `npm test`.
--
-- What is left for SQL is what SQL still decides: whether the matcher finds a
-- whole-word needle in a normalized haystack, and whether the floor and the
-- badge honor it. That is what this file covers.
--
-- Plain SQL (no pgTAP), matching the convention of the other files here: each
-- check raises an EXCEPTION on failure, so running under psql with
-- ON_ERROR_STOP=1 makes it a hard gate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/title_filters.sql
--
-- NOTE this file is not run by CI (it needs a live database), so an assertion
-- here that has never been executed is worse than no assertion. 0072's version
-- had three: it inserted into the generated `sort_at` column, addressed the
-- result rows as `(item).title` when feed_items' columns come back flat, and
-- claimed a Japanese prefix match that is false on both sides. Every check
-- below has been run against a real Postgres 16.

\set ON_ERROR_STOP on

-- --- the matcher over already-normalized text -------------------------------
-- Every value below is in stored form: folded, tokenized, space-joined and
-- space-wrapped. Producing that form is the JS module's job and is tested there.
do $$
declare
  c record;
  got boolean;
begin
  for c in
    select * from (values
      -- whole words, not substrings — the wrapping is what guarantees it
      (' trump announces tariffs ', array['trump'],     true,  'exact word'),
      (' a trumpet solo ',          array['trump'],     false, 'not a substring'),
      (' class action filed ',      array['as'],        false, 'no substring inside a word'),
      -- possessives fall out of the tokenizing done upstream
      (' trump s tariffs ',         array['trump'],     true,  'possessive'),
      -- exact only: 0074 dropped the plural allowance, so an entry matches the
      -- words it contains and nothing else
      (' new tariffs announced ',   array['tariff'],    false, 'singular does not match a plural'),
      (' new tariffs announced ',   array['tariffs'],   true,  'the plural matches when typed'),
      (' several companies left ',  array['company'],   false, 'no -ies rule'),
      (' one company withdrew ',    array['companies'], false, 'and none in reverse'),
      (' a new dawn ',              array['news'],      false, 'never strips'),
      -- phrases match a contiguous run only
      (' the trade war escalates ', array['trade war'], true,  'contiguous run'),
      (' a war over trade rules ',  array['trade war'], false, 'same words, not a run'),
      (' the trade wars escalate ', array['trade war'], false, 'no plural on the head noun'),
      (' the trade wars escalate ', array['trade wars'],true,  'the phrase as typed'),
      (' trades war over rules ',   array['trade war'], false, 'nor on an interior token'),
      -- degenerate inputs
      (' trump announces tariffs ', '{}'::text[],       false, 'empty list'),
      ('  ',                        array['trump'],     false, 'tokenless title'),
      -- a NULL normalization (not yet backfilled) must match nothing rather
      -- than error: that is the under-filtering direction, which costs the
      -- reader nothing.
      (null,                        array['trump'],     false, 'NULL is not yet normalized')
    ) as t(norm, filters, want, note)
  loop
    got := public.title_is_filtered(c.norm, c.filters);
    if got is distinct from c.want then
      raise exception 'title_is_filtered(%, %) = %, want % — %',
        c.norm, c.filters, got, c.want, c.note;
    end if;
  end loop;
  raise notice 'PASS title_is_filtered: all cases';
end $$;

-- --- the fold is gone from SQL ---------------------------------------------
-- Asserted rather than assumed: while these exist someone can call them, and
-- every caller inherits the hand-enumerated mark ranges and the word-splitting
-- they caused.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('title_fold', 'title_tokens', 'title_token_variants')
  ) then
    raise exception 'SQL still carries fold/tokenize/plural helpers — 0073/0074 drop them';
  end if;
  raise notice 'PASS SQL no longer folds or tokenizes';
end $$;

-- --- the floor frees a filtered slot ---------------------------------------
-- The half that motivated putting any of this server-side: the client's overlay
-- runs AFTER the floor's cut, so a feed whose newest 10 all match arrived as ten
-- rows and rendered as none. Here the floor should skip the filtered ones and
-- serve the next unfiltered articles instead.
\set U '33333333-3333-3333-3333-333333333333'
\set F 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

delete from auth.users where id = :'U';
delete from public.feeds where id = :'F';

insert into auth.users (id) values (:'U');
insert into public.feeds (id, url, title)
  values (:'F', 'https://example.com/feed.xml', 'Example');
insert into public.subscriptions (user_id, feed_id) values (:'U', :'F');
insert into public.user_settings (user_id, title_filters)
  values (:'U', array['trump'])
  on conflict (user_id) do update set title_filters = excluded.title_filters;

-- 12 items: the newest 10 all match the filter, 2 older ones don't. Dated well
-- outside the 3-day freshness window so the FLOOR is the only thing serving
-- them — that's the path under test. title_normalized is written here the way
-- the poller writes it (the JS form for these ASCII titles is mechanical).
-- sort_at is generated (coalesce(published_at, created_at)), so seed
-- published_at and let it derive. 0072's version of this file inserted sort_at
-- directly, which is rejected outright — more evidence it had never been run.
insert into public.items (feed_id, guid, url, title, title_normalized, title_normalized_version, published_at)
select :'F',
       'g' || n,
       'https://example.com/' || n,
       case when n <= 10 then 'Trump story ' || n else 'Ordinary story ' || n end,
       case when n <= 10 then ' trump story ' || n || ' ' else ' ordinary story ' || n || ' ' end,
       1,
       now() - (n || ' days')::interval - interval '5 days'
from generate_series(1, 12) as n;

do $$
declare
  n_rows int;
  n_trump int;
begin
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*), count(*) filter (where title like 'Trump%')
    into n_rows, n_trump
    from public.feed_items('feed', null, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 30);

  if n_trump <> 0 then
    raise exception 'feed_items served % filtered rows', n_trump;
  end if;
  -- The point of the exercise: the two unfiltered articles are served even
  -- though ten newer ones matched. Pre-0072 this returned zero rows.
  if n_rows <> 2 then
    raise exception 'floor did not free the filtered slots: got % rows, want 2', n_rows;
  end if;
  raise notice 'PASS feed_items: filtered rows consume no floor slot';
end $$;

do $$
declare
  badge bigint;
begin
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select n into badge
    from public.feed_unread_counts(array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid]);
  -- The half the client cannot do for itself: only the number crosses the wire.
  if badge <> 2 then
    raise exception 'badge counted filtered articles: got %, want 2', badge;
  end if;
  raise notice 'PASS feed_unread_counts: badge excludes filtered articles';
end $$;

-- --- an un-backfilled row is served, not hidden -----------------------------
-- The rollout property: between the migration and the poller's backfill pass a
-- row has no normalization. It must be UNDER-filtered (shown, and counted) —
-- never withheld — because that is the direction that costs the reader nothing.
do $$
declare
  n_rows int;
begin
  update public.items set title_normalized = null, title_normalized_version = null
   where feed_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and guid = 'g1';
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*) into n_rows
    from public.feed_items('feed', null, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 30)
   where guid = 'g1';
  if n_rows <> 1 then
    raise exception 'an un-normalized row must be served, not hidden: got % rows', n_rows;
  end if;
  raise notice 'PASS feed_items: a NULL normalization under-filters';
  update public.items
     set title_normalized = ' trump story 1 ', title_normalized_version = 1
   where feed_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and guid = 'g1';
end $$;

-- --- the batch normalization write and its compare-and-swap -----------------
-- The poller folds titles in JS and sends the batch back through this RPC in a
-- single round trip. The CAS is the part that must not regress: a title that
-- moved between the pass reading it and this writing must leave the row ALONE,
-- so it stays in the backlog. Writing the old title's normalization instead
-- would land a stale value at the current version, which no later batch
-- revisits — the server would filter that article forever on text it no longer
-- has.
do $$
declare
  n_updated int;
  v_id uuid;
begin
  select id into v_id from public.items
   where feed_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and guid = 'g11';

  -- A matching title: the write lands, and the count reflects it.
  select public.apply_title_normalizations(jsonb_build_array(jsonb_build_object(
    'id', v_id, 'title', 'Ordinary story 11',
    'title_normalized', ' ordinary story 11 ', 'title_normalized_version', 1)))
    into n_updated;
  if n_updated <> 1 then
    raise exception 'batch write should have updated 1 row, got %', n_updated;
  end if;

  -- A title that no longer matches: nothing is written, nothing is reported.
  select public.apply_title_normalizations(jsonb_build_array(jsonb_build_object(
    'id', v_id, 'title', 'Something else entirely',
    'title_normalized', ' wrong value ', 'title_normalized_version', 1)))
    into n_updated;
  if n_updated <> 0 then
    raise exception 'CAS should have rejected the stale title, got % updated', n_updated;
  end if;
  if (select title_normalized from public.items where id = v_id) <> ' ordinary story 11 ' then
    raise exception 'CAS let a stale normalization through';
  end if;

  raise notice 'PASS apply_title_normalizations: batch write + compare-and-swap';
end $$;

-- An untitled row must be writable too: `= NULL` is never true, so an `eq`
-- guard would leave it in the backlog forever.
do $$
declare
  n_updated int;
  v_id uuid;
begin
  insert into public.items (feed_id, guid, url, title, published_at)
  values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'gnull', 'https://example.com/null', null, now())
  on conflict do nothing;
  select id into v_id from public.items
   where feed_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and guid = 'gnull';

  select public.apply_title_normalizations(jsonb_build_array(jsonb_build_object(
    'id', v_id, 'title', null,
    'title_normalized', ' untitled ', 'title_normalized_version', 1)))
    into n_updated;
  if n_updated <> 1 then
    raise exception 'null-titled row must satisfy its own CAS, got % updated', n_updated;
  end if;
  raise notice 'PASS apply_title_normalizations: null title is null-safe';
end $$;

-- --- a pin outranks a filter ----------------------------------------------
-- Same rule as the client overlay, which checks the pin branch before the
-- filter branch: a pin is a to-do the reader placed on this article, and it
-- outranks a standing rule about words exactly as it outranks Done/Hidden.
do $$
declare
  n_trump int;
begin
  insert into public.item_state (user_id, item_id, pinned, pinned_at)
  select '33333333-3333-3333-3333-333333333333',
         i.id, true, now()
  from public.items i
  where i.feed_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and i.guid = 'g1'
  on conflict (user_id, item_id) do update set pinned = true, pinned_at = now();

  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*) filter (where title like 'Trump%')
    into n_trump
    from public.feed_items('feed', null, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 30);

  if n_trump <> 1 then
    raise exception 'a pinned article must survive its own filter: got % pinned rows, want 1', n_trump;
  end if;
  raise notice 'PASS feed_items: a pin outranks a filter';
end $$;

-- --- a reader with no filters is unaffected --------------------------------
do $$
declare
  n_rows int;
begin
  update public.user_settings set title_filters = '{}'::text[]
   where user_id = '33333333-3333-3333-3333-333333333333';
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*) into n_rows
    from public.feed_items('feed', null, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, 30);
  -- The floor's 10 plus the 2 older ones the pin/window don't add twice.
  if n_rows < 10 then
    raise exception 'an empty filter list must change nothing: got % rows', n_rows;
  end if;
  raise notice 'PASS feed_items: empty filter list is inert';
end $$;

delete from auth.users where id = :'U';
delete from public.feeds where id = :'F';
