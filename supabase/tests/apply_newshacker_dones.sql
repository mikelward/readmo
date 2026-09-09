-- Regression test for 0062_apply_newshacker_dones.sql — the reverse newshacker
-- Done pull. Plain SQL (no pgTAP): each check raises NOTICE 'PASS …' on success
-- and an EXCEPTION on failure, so under psql with ON_ERROR_STOP=1 it's a hard
-- gate. Same harness/assumptions as access_rpcs.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/apply_newshacker_dones.sql

\set ALICE '11111111-1111-1111-1111-111111111111'
\set BOB   '22222222-2222-2222-2222-222222222222'

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222');
delete from public.feeds where id in (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- Alice (subscribed)
  ('22222222-2222-2222-2222-222222222222');  -- Bob (not subscribed)

-- A Hacker News feed with three items, each carrying its HN discussion link in
-- comments_url exactly as the parser stores it.
insert into public.feeds (id, url, site_url, title) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'https://news.ycombinator.com/rss', 'https://news.ycombinator.com/', 'Hacker News');
insert into public.items (id, feed_id, guid, url, comments_url, title) values
  ('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'guid-100', 'https://ex.com/a',
   'https://news.ycombinator.com/item?id=100', 'Story 100'),
  ('22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'guid-200', 'https://ex.com/b',
   'https://news.ycombinator.com/item?id=200', 'Story 200'),
  ('33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'guid-300', 'https://ex.com/c',
   'https://news.ycombinator.com/item?id=300', 'Story 300');

-- A NON-Hacker-News feed (a blog) whose item points its comments link at an HN
-- thread (id 400) — the exact case the HN-feed gate must exclude.
insert into public.feeds (id, url, site_url, title) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'https://blog.example.com/feed', 'https://blog.example.com', 'A Blog');
insert into public.items (id, feed_id, guid, url, comments_url, title) values
  ('44444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'guid-400', 'https://blog.example.com/p',
   'https://news.ycombinator.com/item?id=400', 'A blog post discussed on HN');

-- Alice subscribes to both feeds.
insert into public.subscriptions (user_id, feed_id) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- ===== Test 1: a pulled Done marks the matching subscribed item Done =========
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_dones(
    '[{"id":100,"at":1700000000000},{"id":200,"at":1700000000000}]'::jsonb);
  if n <> 2 then raise exception 'FAIL T1a: expected 2 writes, got %', n; end if;
  select count(*) into n from public.item_state
    where user_id=auth.uid() and done
      and item_id in ('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                      '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  if n <> 2 then raise exception 'FAIL T1b: expected 2 Done rows, got %', n; end if;
  raise notice 'PASS T1: pulled Done marks matching subscribed items Done';
end $$;

-- ===== Test 2: an id with no matching item, and Bob's non-subscription =======
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- id 999 has no item; should apply nothing and not error.
  n := public.apply_newshacker_dones('[{"id":999,"at":1700000000000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T2a: unmatched id wrote % rows', n; end if;

  -- Bob is not subscribed, so even a real id maps to nothing for him.
  perform set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  n := public.apply_newshacker_dones('[{"id":300,"at":1700000000000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T2b: non-subscriber wrote % rows', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if n <> 0 then raise exception 'FAIL T2c: non-subscriber created item_state'; end if;
  raise notice 'PASS T2: unmatched id and non-subscriber apply nothing';
end $$;

-- ===== Test 3: a tombstone (deleted) un-does a later-clocked Done ============
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- item 100 was marked Done at at=1700000000000 in T1; a NEWER tombstone clears it.
  n := public.apply_newshacker_dones(
    '[{"id":100,"at":1700000001000,"deleted":true}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T3a: expected 1 write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done;
  if n <> 0 then raise exception 'FAIL T3b: tombstone did not clear Done'; end if;
  raise notice 'PASS T3: newer tombstone clears a prior Done';
end $$;

-- ===== Test 4: last-write-wins — a stale pulled Done loses to a newer local ==
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- A fresh LOCAL un-done (mark unread) on item 200 at a newer clock.
  perform public.set_item_state(
    '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    p_done => false, p_done_at => to_timestamp(1700000005000 / 1000.0));
  -- A STALE pulled Done (older clock) must not resurrect it.
  n := public.apply_newshacker_dones(
    '[{"id":200,"at":1700000002000}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T4a: expected 1 write attempt, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done;
  if n <> 0 then raise exception 'FAIL T4b: stale pulled Done clobbered a newer local un-done'; end if;
  raise notice 'PASS T4: stale pulled Done loses per-field LWW';
end $$;

-- ===== Test 5: malformed entries are skipped, valid ones still apply =========
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_dones(
    '[{"id":-1,"at":1},{"id":300,"at":1700000009000},{"nope":true},"garbage"]'::jsonb);
  if n <> 1 then raise exception 'FAIL T5a: expected 1 valid write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done;
  if n <> 1 then raise exception 'FAIL T5b: valid entry among garbage not applied'; end if;
  raise notice 'PASS T5: malformed entries skipped, valid entry applied';
end $$;

-- ===== Test 6: a non-HN feed's item that links to HN is NOT swept ===========
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- id 400 lives only on the blog feed (via comments_url); the HN-feed gate
  -- must exclude it even though Alice is subscribed and the URL matches.
  n := public.apply_newshacker_dones('[{"id":400,"at":1700000010000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T6a: non-HN feed item was matched (% writes)', n; end if;
  select count(*) into n from public.item_state
    where item_id='44444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if n <> 0 then raise exception 'FAIL T6b: non-HN feed item marked Done'; end if;
  raise notice 'PASS T6: non-HN feed item linking to HN is not swept Done';
end $$;

-- --- Cleanup ---------------------------------------------------------------
delete from auth.users where id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222');
delete from public.feeds where id in (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

\echo 'apply_newshacker_dones.sql: ALL PASS'
