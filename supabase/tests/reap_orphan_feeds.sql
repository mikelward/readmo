-- Regression test for 0042_reap_orphan_feeds.sql.
--
-- Proves reap_orphan_feeds() deletes a feed once it has no subscribers, but
-- preserves (a) feeds that still have a subscriber and (b) feeds kept alive by
-- a permanent (pinned/favorite/done) item_state row — guardrail #7 / SPEC.md
-- RLS branch (b). Plain SQL (no pgTAP): each check raises NOTICE 'PASS …' on
-- success and raises an EXCEPTION on failure, so running under psql with
-- ON_ERROR_STOP=1 makes it a hard gate.
--
-- Run against a database with the Supabase auth schema + migrations applied
-- (e.g. local `supabase db reset`, then this file). The seed runs as the
-- migration/superuser role, standing in for the service-role poller.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/reap_orphan_feeds.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
delete from public.feeds where id in (
  'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',  -- subscribed → keep
  'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',  -- no subs, pinned item → keep
  'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',  -- no subs, only opened → reap
  'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4'); -- no subs, no state → reap

insert into auth.users (id) values ('33333333-3333-3333-3333-333333333333');

-- (a) Subscribed feed — must survive.
insert into public.feeds (id, url, title) values
  ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'https://sub.example/feed.xml', 'Subscribed');
insert into public.subscriptions (user_id, feed_id) values
  ('33333333-3333-3333-3333-333333333333', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1');

-- (b) No subscribers, but a pinned item — must survive (branch (b) protects it).
insert into public.feeds (id, url, title) values
  ('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'https://pinned.example/feed.xml', 'Pinned');
insert into public.items (id, feed_id, guid, title) values
  ('b2b20001-0000-0000-0000-000000000001', 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'g-b', 'Kept Article');
insert into public.item_state (user_id, item_id, pinned, pinned_at) values
  ('33333333-3333-3333-3333-333333333333', 'b2b20001-0000-0000-0000-000000000001', true, now());

-- (c) No subscribers, an item_state row that is only `opened` (TTL'd, no
--     exemption) — must be reaped.
insert into public.feeds (id, url, title) values
  ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 'https://opened.example/feed.xml', 'Opened');
insert into public.items (id, feed_id, guid, title) values
  ('c3c30001-0000-0000-0000-000000000001', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 'g-c', 'Opened Article');
insert into public.item_state (user_id, item_id, opened, opened_at) values
  ('33333333-3333-3333-3333-333333333333', 'c3c30001-0000-0000-0000-000000000001', true, now());

-- (d) No subscribers, no item_state at all — must be reaped.
insert into public.feeds (id, url, title) values
  ('d4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4', 'https://gone.example/feed.xml', 'Orphan');
insert into public.items (id, feed_id, guid, title) values
  ('d4d40001-0000-0000-0000-000000000001', 'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4', 'g-d', 'Nobody''s Article');

-- ===== Test 1: reap returns the count of feeds it deleted (c + d = 2) =======
do $$
declare reaped int;
begin
  reaped := public.reap_orphan_feeds();
  if reaped <> 2 then
    raise exception 'FAIL T1: reap_orphan_feeds returned %, expected 2', reaped;
  end if;
  raise notice 'PASS T1: reap_orphan_feeds deleted % feed(s)', reaped;
end $$;

-- ===== Test 2: subscribed + pinned-kept feeds survive; orphans are gone =====
do $$
declare n int;
begin
  select count(*) into n from public.feeds
    where id = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
  if n <> 1 then raise exception 'FAIL T2a: subscribed feed was reaped'; end if;
  raise notice 'PASS T2a: subscribed feed survived';

  select count(*) into n from public.feeds
    where id = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';
  if n <> 1 then raise exception 'FAIL T2b: pinned-kept feed was reaped'; end if;
  raise notice 'PASS T2b: feed kept alive by a pin survived';

  select count(*) into n from public.feeds
    where id in ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
                 'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4');
  if n <> 0 then raise exception 'FAIL T2c: % orphan feed(s) survived', n; end if;
  raise notice 'PASS T2c: orphan feeds reaped';

  -- The reaped feeds' items cascaded away too.
  select count(*) into n from public.items
    where feed_id in ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
                      'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4');
  if n <> 0 then raise exception 'FAIL T2d: % orphan item(s) survived', n; end if;
  raise notice 'PASS T2d: orphan items cascaded';
end $$;

-- ===== Test 3: clearing the last pin makes the feed reapable ================
do $$
declare reaped int;
declare n int;
begin
  -- The kept feed loses its exemption once the pin is cleared.
  update public.item_state set pinned = false
    where item_id = 'b2b20001-0000-0000-0000-000000000001';
  reaped := public.reap_orphan_feeds();
  if reaped <> 1 then
    raise exception 'FAIL T3: expected 1 reap after clearing the pin, got %', reaped;
  end if;
  select count(*) into n from public.feeds
    where id = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';
  if n <> 0 then raise exception 'FAIL T3: unpinned feed still present'; end if;
  raise notice 'PASS T3: feed reaped once its last pin was cleared';
end $$;

-- --- Cleanup ---------------------------------------------------------------
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
delete from public.feeds where id = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
