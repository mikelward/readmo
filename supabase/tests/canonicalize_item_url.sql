-- Regression test for 0048_canonicalize_item_url.sql.
--
-- Proves (1) canonicalize_item_url() strips fragments + known tracking params
-- while keeping load-bearing query params and the path, and (2) end-to-end,
-- a publisher re-issuing the same story under a new <guid> with a rotated
-- campaign tag / version fragment now de-dups to ONE items row — because the
-- parser stores the canonical url and the 0013 (feed_id, url) unique index +
-- upsert_feed_items RPC collapse the re-issue. This is the same-feed dupe the
-- BBC News feed was showing (SPEC.md "Feed fetching & parsing → De-dup").
--
-- Plain SQL (no pgTAP): each check raises NOTICE 'PASS …' on success and an
-- EXCEPTION on failure, so running under psql with ON_ERROR_STOP=1 makes it a
-- hard gate. Run against a database with the Supabase auth schema + migrations
-- applied (e.g. local `supabase db reset`, then this file):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/canonicalize_item_url.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from public.feeds where id = 'ca000000-0000-0000-0000-0000000000fe';

insert into public.feeds (id, url, title) values
  ('ca000000-0000-0000-0000-0000000000fe', 'https://bbc.example/feed.xml', 'BBC');

-- ===== Test 1: canonicalize_item_url() output cases ========================
do $$
declare
  got text;
begin
  -- The fragment is ALWAYS preserved (never stripped) — even a bare counter.
  got := public.canonicalize_item_url('https://bbc.example/news/dream#0');
  if got <> 'https://bbc.example/news/dream#0' then
    raise exception 'FAIL T1a: fragment was stripped, got %', got;
  end if;

  -- BBC at_* campaign tags stripped (whole query drops → no trailing ?).
  got := public.canonicalize_item_url(
    'https://bbc.example/news/dream?at_medium=RSS&at_campaign=KARANGA');
  if got <> 'https://bbc.example/news/dream' then
    raise exception 'FAIL T1b: tracking params not stripped, got %', got;
  end if;

  -- Load-bearing params kept; only the tracker dropped.
  got := public.canonicalize_item_url(
    'https://bbc.example/story?id=123&page=2&utm_source=x');
  if got <> 'https://bbc.example/story?id=123&page=2' then
    raise exception 'FAIL T1c: kept params altered, got %', got;
  end if;

  -- Tracker dropped, fragment kept (query is BEFORE the fragment in a URL).
  got := public.canonicalize_item_url(
    'https://bbc.example/news/dream?at_campaign=B#3');
  if got <> 'https://bbc.example/news/dream#3' then
    raise exception 'FAIL T1d: tracker-strip w/ fragment failed, got %', got;
  end if;

  -- Route/hashbang fragments preserved.
  got := public.canonicalize_item_url('https://spa.example/?utm_source=x#/article/123');
  if got <> 'https://spa.example/#/article/123' then
    raise exception 'FAIL T1d2: route fragment not preserved, got %', got;
  end if;
  if public.canonicalize_item_url('https://spa.example/#!/a/1')
     <> 'https://spa.example/#!/a/1' then
    raise exception 'FAIL T1d3: hashbang fragment not preserved';
  end if;

  -- In-page ANCHOR fragments preserved, incl. bare-numeric (liveblog entries).
  if public.canonicalize_item_url('https://live.example/story?utm_source=x#block-123')
     <> 'https://live.example/story#block-123' then
    raise exception 'FAIL T1d4: anchor fragment not preserved';
  end if;
  if public.canonicalize_item_url('https://live.example/story#123')
     = public.canonicalize_item_url('https://live.example/story#124') then
    raise exception 'FAIL T1d5: bare-numeric anchors were collapsed';
  end if;

  -- Idempotent (a kept fragment + kept param survive a second pass) + null.
  if public.canonicalize_item_url(
       public.canonicalize_item_url('https://bbc.example/a?id=1&utm_source=x#block-9'))
     <> 'https://bbc.example/a?id=1#block-9' then
    raise exception 'FAIL T1e: not idempotent';
  end if;
  if public.canonicalize_item_url(null) is not null then
    raise exception 'FAIL T1f: null not passed through';
  end if;

  raise notice 'PASS T1: canonicalize_item_url strips trackers, keeps fragments/anchors/routes/params';
end $$;

-- ===== Test 2: a canonical re-issue under a new guid de-dups to one row =====
-- The parser now emits the canonical url, so both the original store and the
-- re-issue arrive as the SAME url with DIFFERENT guids. upsert_feed_items must
-- collapse them via the (feed_id, url) unique index (0013), adopting the new
-- guid — not insert a second row.
do $$
declare
  n int;
  final_guid text;
begin
  -- Original store (canonical url, guid v0).
  perform public.upsert_feed_items(
    'ca000000-0000-0000-0000-0000000000fe',
    jsonb_build_array(jsonb_build_object(
      'guid', 'https://bbc.example/news/dream#0',
      'url',  'https://bbc.example/news/dream',
      'title','Dream'))
  );
  -- Re-issue: new guid (#1), same canonical url.
  perform public.upsert_feed_items(
    'ca000000-0000-0000-0000-0000000000fe',
    jsonb_build_array(jsonb_build_object(
      'guid', 'https://bbc.example/news/dream#1',
      'url',  'https://bbc.example/news/dream',
      'title','Dream (updated)'))
  );

  select count(*), max(guid) into n, final_guid
    from public.items
    where feed_id = 'ca000000-0000-0000-0000-0000000000fe'
      and url = 'https://bbc.example/news/dream';
  if n <> 1 then
    raise exception 'FAIL T2: expected 1 de-duped row, got %', n;
  end if;
  if final_guid <> 'https://bbc.example/news/dream#1' then
    raise exception 'FAIL T2: re-issue guid not adopted, got %', final_guid;
  end if;
  raise notice 'PASS T2: canonical re-issue under a new guid de-dups to one row';
end $$;

-- ===== Test 3: the write trigger canonicalizes RAW urls at the boundary =====
-- Guards the deploy window: the items_canonicalize_url BEFORE trigger stores
-- the canonical form for ANY writer — a direct INSERT here stands in for an old,
-- not-yet-redeployed poll/refresh (or in-flight RPC body) writing a raw URL.
do $$
declare
  stored text;
begin
  insert into public.items (feed_id, guid, url, title)
  values ('ca000000-0000-0000-0000-0000000000fe', 'trg#0',
          'https://bbc.example/news/story?at_medium=RSS&at_campaign=A', 'Story');
  select url into stored from public.items where guid = 'trg#0';
  if stored <> 'https://bbc.example/news/story' then
    raise exception 'FAIL T3: trigger stored a non-canonical url on insert: %', stored;
  end if;

  -- A raw UPDATE of url is canonicalized too.
  update public.items set url = 'https://bbc.example/news/story?at_campaign=B'
    where guid = 'trg#0';
  select url into stored from public.items where guid = 'trg#0';
  if stored <> 'https://bbc.example/news/story' then
    raise exception 'FAIL T3: trigger stored a non-canonical url on update: %', stored;
  end if;
  raise notice 'PASS T3: items_canonicalize_url trigger canonicalizes raw writes';
end $$;

-- ===== Test 4: a raw re-issue de-dups via the trigger + (feed_id,url) key =====
-- Two raw writes of the same story (differing campaign tag) collapse to one row
-- because the trigger canonicalizes both onto the same url.
do $$
declare
  n int;
begin
  insert into public.items (feed_id, guid, url, title)
  values ('ca000000-0000-0000-0000-0000000000fe', 'trg#a',
          'https://bbc.example/news/other?at_campaign=A', 'Other');
  begin
    insert into public.items (feed_id, guid, url, title)
    values ('ca000000-0000-0000-0000-0000000000fe', 'trg#b',
            'https://bbc.example/news/other?at_campaign=B', 'Other 2');
    raise exception 'FAIL T4: raw re-issue was NOT rejected by the unique index';
  exception when unique_violation then
    null; -- expected: canonical url collides with the first row
  end;
  select count(*) into n from public.items
    where feed_id = 'ca000000-0000-0000-0000-0000000000fe'
      and url = 'https://bbc.example/news/other';
  if n <> 1 then
    raise exception 'FAIL T4: expected 1 canonical row, got %', n;
  end if;
  raise notice 'PASS T4: raw re-issues collapse on the canonical (feed_id, url) key';
end $$;

-- ===== Test 5: RPC folds a RAW-url re-issue onto the canonical survivor ======
-- An OLD Edge Function (raw url, NEW guid) calling the migrated RPC must UPDATE
-- the canonical survivor — the exception fallback matches on canonicalize(url),
-- so the re-issue is adopted, not silently dropped.
do $$
declare
  survivor_guid text;
  n int;
begin
  insert into public.items (feed_id, guid, url, title)
  values ('ca000000-0000-0000-0000-0000000000fe', 'keep',
          'https://bbc.example/news/folded', 'Original');
  perform public.upsert_feed_items(
    'ca000000-0000-0000-0000-0000000000fe',
    jsonb_build_array(jsonb_build_object(
      'guid', 'reissue',
      'url',  'https://bbc.example/news/folded?at_campaign=Z',
      'title','Re-issued')));

  select count(*), max(guid) into n, survivor_guid
    from public.items
    where feed_id = 'ca000000-0000-0000-0000-0000000000fe'
      and url = 'https://bbc.example/news/folded';
  if n <> 1 then
    raise exception 'FAIL T5: raw re-issue not folded, got % rows', n;
  end if;
  if survivor_guid <> 'reissue' then
    raise exception 'FAIL T5: re-issue dropped instead of adopting guid (guid=%)', survivor_guid;
  end if;
  raise notice 'PASS T5: RPC folds a raw-url re-issue onto the canonical survivor';
end $$;

-- ===== Test 6 (0055): guid/url cross-collision must not abort the batch =====
-- Feed holds row A (guid=G) and row B (url=U); the publisher emits an item
-- claiming BOTH (guid=G, url=U). The INSERT conflicts on guid (row A), the DO
-- UPDATE trips over row B's url, and the fallback's guid adoption onto row B
-- collides with row A's guid. Before 0055 that second unique_violation escaped
-- the handler and rolled back the whole per-feed batch — every poll, forever
-- (a stuck feed). Now the content lands on the url survivor (sans guid
-- adoption) and the REST of the batch still commits.
do $$
declare
  n int;
  got_title text;
begin
  insert into public.items (feed_id, guid, url, title) values
    ('ca000000-0000-0000-0000-0000000000fe', 'cross-G',
     'https://bbc.example/news/held-elsewhere', 'row A'),
    ('ca000000-0000-0000-0000-0000000000fe', 'cross-G2',
     'https://bbc.example/news/target', 'row B');

  perform public.upsert_feed_items(
    'ca000000-0000-0000-0000-0000000000fe',
    jsonb_build_array(
      jsonb_build_object(
        'guid', 'cross-G',
        'url',  'https://bbc.example/news/target',
        'title','cross re-issue'),
      jsonb_build_object(
        'guid', 'cross-G3',
        'url',  'https://bbc.example/news/rest-of-batch',
        'title','batch survivor')));

  -- The url survivor took the fresh content without adopting the guid.
  select title into got_title from public.items
    where feed_id = 'ca000000-0000-0000-0000-0000000000fe'
      and url = 'https://bbc.example/news/target';
  if got_title <> 'cross re-issue' then
    raise exception 'FAIL T6: url survivor not updated, title=%', got_title;
  end if;
  -- Row A keeps its guid, and the batch's second item landed.
  select count(*) into n from public.items
    where feed_id = 'ca000000-0000-0000-0000-0000000000fe'
      and guid in ('cross-G', 'cross-G3');
  if n <> 2 then
    raise exception 'FAIL T6: expected row A + batch survivor, got % rows', n;
  end if;
  raise notice 'PASS T6: guid/url cross-collision updates the survivor and the batch commits';
end $$;

-- --- Cleanup ---------------------------------------------------------------
delete from public.feeds where id = 'ca000000-0000-0000-0000-0000000000fe';
