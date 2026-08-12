-- Regression test for 0072_server_side_title_filters.sql.
--
-- The matching contract lives in src/lib/titleFilter.ts and is TRANSCRIBED into
-- SQL by 0072 so the badge counts and the per-feed floor can honor it. Two
-- implementations of one contract can drift, and a drift is close to invisible
-- in the field — the list and the badge would simply disagree about one row.
-- So this file runs the SAME corpus of cases that src/lib/titleFilter.test.ts
-- runs, case for case. When you change one side, change both, and keep the two
-- corpora in step.
--
-- Plain SQL (no pgTAP), matching the convention of the other files here: each
-- check raises an EXCEPTION on failure, so running under psql with
-- ON_ERROR_STOP=1 makes it a hard gate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/title_filters.sql
--
-- The matcher functions are pure (immutable, no auth, no tables), so this half
-- needs no fixtures at all. The floor/badge behavior that CONSUMES them is
-- exercised at the bottom, and that part does seed rows.

\set ON_ERROR_STOP on

-- --- the matcher, case for case with titleFilter.test.ts -------------------
do $$
declare
  c record;
  got boolean;
begin
  for c in
    select * from (values
      -- whole words, case- and diacritic-insensitive
      ('Trump announces tariffs',        array['trump'],        true,  'exact word'),
      ('TRUMP announces tariffs',        array['trump'],        true,  'case folded'),
      ('Peña wins the race',             array['pena'],         true,  'diacritic folded'),
      -- the rule that motivates tokenizing at all
      ('A trumpet solo for the ages',    array['trump'],        false, 'not a substring'),
      ('The trumped-up charges',         array['trump'],        false, 'hyphen is a boundary'),
      ('Class action filed',             array['as'],           false, 'no substring inside a word'),
      -- possessives fall out of tokenizing, with no possessive rule
      ('Trump''s tariffs hit farmers',   array['trump'],        true,  'possessive'),
      -- add-only plurals
      ('New tariffs announced',          array['tariff'],       true,  '+s'),
      ('New taxes announced',            array['tax'],          true,  '+es'),
      ('Several companies withdrew',     array['company'],      true,  '-ies (the menu offers this stem)'),
      ('Both countries agreed',          array['country'],      true,  '-ies again'),
      ('It took three days',             array['day'],          true,  'vowel+y takes the plain +s'),
      ('One company withdrew',           array['companies'],    false, 'never strips back to the singular'),
      -- never strips: the whole reason the allowance is add-only
      ('A new dawn for cycling',         array['news'],         false, 'news does not become new'),
      ('It is up to us all',             array['USA'],          false, 'USA does not become us'),
      ('One tariff was lifted',          array['tariffs'],      false, 'plural filter, singular title'),
      -- known limitation, recorded rather than fixed (see TODO.md)
      ('It is up to us now',             array['US'],           true,  'acronym folds onto its homograph'),
      -- phrases match a contiguous run only
      ('The trade war escalates',        array['trade war'],    true,  'contiguous run'),
      ('A war over trade rules',         array['trade war'],    false, 'same words, not a run'),
      ('The trade wars escalate',        array['trade war'],    true,  'plural on the head noun'),
      ('Trades war over rules',          array['trade war'],    false, 'no plural on an interior token'),
      -- degenerate inputs
      ('Trump announces tariffs',        '{}'::text[],          false, 'empty list'),
      ('!!! ???',                        array['trump'],        false, 'title with no words'),
      ('Trump announces tariffs',        array['...'],          false, 'entry that normalizes to nothing'),
      -- an unnormalized stored entry still matches (the mapper normalizes, but
      -- a hand-edited row need not have)
      ('Trump announces tariffs',        array['  TRUMP  '],    true,  'unnormalized entry'),
      -- multiple entries: any one matching is enough
      ('Musk buys another company',      array['trump','musk'], true,  'second entry matches'),
      -- Kana voicing marks live in a Combining block, so NFD's decomposition of
      -- が is folded away and the word stays one token, as on the client.
      ('がくの話',                        array['がく'],          true,  'Japanese dakuten (NFD splits が)'),
      -- The ACCEPTED GAP, asserted rather than left to be discovered: a script
      -- whose marks live inside its own block is under-filtered here. The
      -- client still filters these titles correctly, so the reader's list is
      -- right and only a badge can over-count. Asserting `false` records that
      -- this is known and chosen — the alternative was hand-built per-script
      -- spans, and one of those deleted Malayalam LETTERS and hid an article
      -- the client showed (Codex P2 on #625). Under-filtering is the safe
      -- direction; over-filtering is not.
      ('مُحَمَّد يفوز',                      array['محمد'],         false, 'Arabic marks: known gap, safe direction'),
      ('שָׁלוֹם עולם',                      array['שלום'],         false, 'Hebrew points: known gap, safe direction'),
      -- The regression guard for the dangerous direction: a Malayalam LETTER
      -- must survive the fold, so the tokens either side of it are not joined
      -- into a word a filter would match.
      ('aൎb is unrelated',              array['ab'],           false, 'must not delete U+0D4E (category Lo)')
    ) as t(title, filters, want, note)
  loop
    got := public.title_is_filtered(c.title, c.filters);
    if got is distinct from c.want then
      raise exception 'title_is_filtered(%, %) = %, want % — %',
        c.title, c.filters, got, c.want, c.note;
    end if;
  end loop;
  raise notice 'PASS title_is_filtered: all cases';
end $$;

-- --- fold / tokenize, the pieces the matcher is built from -----------------
do $$
begin
  if public.title_fold('Peña') <> 'pena' then
    raise exception 'title_fold strips diacritics: got %', public.title_fold('Peña');
  end if;
  if public.title_fold('TRUMP') <> 'trump' then
    raise exception 'title_fold lowercases';
  end if;
  if public.title_tokens('Trump''s tariffs') <> array['trump','s','tariffs'] then
    raise exception 'title_tokens splits possessives: got %', public.title_tokens('Trump''s tariffs');
  end if;
  if public.title_tokens('!!! ???') <> '{}'::text[] then
    raise exception 'title_tokens of a wordless string is empty';
  end if;
  -- Add-only, stated as an invariant rather than a case list: every variant is
  -- longer than the token itself, which is WHY the allowance cannot overreach.
  if exists (
    select 1 from unnest(public.title_token_variants('company')) as v
    where length(v) <= length('company') and v <> 'company'
  ) then
    raise exception 'title_token_variants produced a variant no longer than its input';
  end if;
  raise notice 'PASS title_fold / title_tokens / title_token_variants';
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
-- them — that's the path under test.
insert into public.items (feed_id, guid, url, title, sort_at)
select :'F',
       'g' || n,
       'https://example.com/' || n,
       case when n <= 10 then 'Trump story ' || n else 'Ordinary story ' || n end,
       now() - (n || ' days')::interval - interval '5 days'
from generate_series(1, 12) as n;

do $$
declare
  n_rows int;
  n_trump int;
begin
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*), count(*) filter (where (item).title like 'Trump%')
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
  select count(*) filter (where (item).title like 'Trump%')
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
