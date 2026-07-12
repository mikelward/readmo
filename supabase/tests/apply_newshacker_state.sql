-- Regression test for 0063_apply_newshacker_state.sql — the reverse pull of
-- newshacker's Done AND Pinned lists. Plain SQL (no pgTAP): each check raises
-- NOTICE 'PASS …' on success and an EXCEPTION on failure, so under psql with
-- ON_ERROR_STOP=1 it's a hard gate. Same harness as access_rpcs.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/apply_newshacker_state.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id in (
  '11111111-1111-1111-1111-111111111111');
delete from public.feeds where id in (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111');  -- Alice

-- A Hacker News feed with items 100/200/300, discussion link in comments_url.
insert into public.feeds (id, url, site_url, title) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'https://news.ycombinator.com/rss', 'https://news.ycombinator.com/', 'Hacker News');
insert into public.items (id, feed_id, guid, url, comments_url, title) values
  ('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'g100', 'https://ex.com/a',
   'https://news.ycombinator.com/item?id=100', 'Story 100'),
  ('22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'g200', 'https://ex.com/b',
   'https://news.ycombinator.com/item?id=200', 'Story 200'),
  ('33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'g300', 'https://ex.com/c',
   'https://news.ycombinator.com/item?id=300', 'Story 300');

-- A NON-HN blog feed whose item links to HN thread 400.
insert into public.feeds (id, url, site_url, title) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'https://blog.example.com/feed', 'https://blog.example.com', 'A Blog');
insert into public.items (id, feed_id, guid, url, comments_url, title) values
  ('44444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'g400', 'https://blog.example.com/p',
   'https://news.ycombinator.com/item?id=400', 'Blogged, discussed on HN');

insert into public.subscriptions (user_id, feed_id) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- ===== Test 1: pins and dones apply to the matching items ===================
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- item 100 pinned, item 200 done.
  n := public.apply_newshacker_state(
    '[{"id":200,"at":1700000000000}]'::jsonb,   -- dones
    '[{"id":100,"at":1700000000000}]'::jsonb);  -- pins
  if n <> 2 then raise exception 'FAIL T1a: expected 2 writes, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned and not done;
  if n <> 1 then raise exception 'FAIL T1b: pin not applied'; end if;
  select count(*) into n from public.item_state
    where item_id='22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done and not pinned;
  if n <> 1 then raise exception 'FAIL T1c: done not applied'; end if;
  raise notice 'PASS T1: pins and dones both apply';
end $$;

-- ===== Test 2: a newer pin flips a done item and clears done (exclusivity) ==
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- item 200 is currently done (T1); a NEWER pin must win and clear done.
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":200,"at":1700000005000}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T2a: expected 1 write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned and not done;
  if n <> 1 then raise exception 'FAIL T2b: newer pin did not flip done→pinned'; end if;
  raise notice 'PASS T2: newer pin wins and clears done (exclusivity closure)';
end $$;

-- ===== Test 3: an unpin tombstone clears a later-clocked pin =================
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":100,"at":1700000006000,"deleted":true}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T3a: expected 1 write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned;
  if n <> 0 then raise exception 'FAIL T3b: unpin tombstone did not clear pin'; end if;
  raise notice 'PASS T3: unpin tombstone clears a prior pin';
end $$;

-- ===== Test 4: a non-HN feed's item that links to HN is NOT pinned ==========
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":400,"at":1700000007000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T4a: non-HN feed item was pinned (% writes)', n; end if;
  select count(*) into n from public.item_state
    where item_id='44444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if n <> 0 then raise exception 'FAIL T4b: non-HN feed item got item_state'; end if;
  raise notice 'PASS T4: non-HN feed item linking to HN is not pinned';
end $$;

-- ===== Test 5: last-write-wins — a stale pulled pin loses to a newer unpin ===
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- Fresh LOCAL unpin on item 300 at a newer clock.
  perform public.set_item_state(
    '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    p_pinned => false, p_pinned_at => to_timestamp(1700000009000 / 1000.0));
  -- Stale pulled pin (older clock) must not re-pin it.
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":300,"at":1700000008000}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T5a: expected 1 write attempt, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned;
  if n <> 0 then raise exception 'FAIL T5b: stale pulled pin clobbered a newer local unpin'; end if;
  raise notice 'PASS T5: stale pulled pin loses per-field LWW';
end $$;

-- ===== Test 6: empty / non-array inputs are a no-op =========================
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_state('[]'::jsonb, '[]'::jsonb);
  if n <> 0 then raise exception 'FAIL T6a: empty lists wrote % rows', n; end if;
  n := public.apply_newshacker_state('null'::jsonb, '{"nope":1}'::jsonb);
  if n <> 0 then raise exception 'FAIL T6b: non-array inputs wrote % rows', n; end if;
  -- Defaults: calling with no pins arg treats pins as empty.
  n := public.apply_newshacker_state('[]'::jsonb);
  if n <> 0 then raise exception 'FAIL T6c: default pins arg wrote % rows', n; end if;
  raise notice 'PASS T6: empty / non-array / defaulted inputs are a no-op';
end $$;

-- --- Cleanup ---------------------------------------------------------------
delete from auth.users where id in (
  '11111111-1111-1111-1111-111111111111');
delete from public.feeds where id in (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

\echo 'apply_newshacker_state.sql: ALL PASS'
