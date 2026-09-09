-- Feed-cap regression test for 0059_feed_cap.sql.
--
-- Proves subscribe_to_feed enforces the per-account feed cap (100), that a
-- re-subscribe to a feed already followed is exempt at the cap, and that a
-- capped reject does not leave an orphan `feeds` row. Plain SQL (no pgTAP),
-- same convention as access_rpcs.sql: each check raises NOTICE 'PASS …' on
-- success and an EXCEPTION on failure, so under psql with ON_ERROR_STOP=1 it's
-- a hard gate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/feed_cap.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
-- Feeds this test creates all live under the capuser.example host; drop them so
-- a re-run starts from zero subscriptions for the user.
delete from public.feeds where url like 'https://capuser.example/%';

insert into auth.users (id) values
  ('33333333-3333-3333-3333-333333333333');

-- ===== Test 1: subscribing up to the cap (100) all succeed, appending sort ==
-- Also guards that 0059's recreate preserved the 0017/0043 append ordering
-- (max(sort)+1) — a regression that would leave every new feed at sort 0.
do $$
declare i int; n_distinct int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  for i in 1..100 loop
    perform public.subscribe_to_feed('https://capuser.example/feed-' || i);
  end loop;
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  if (select count(*) from public.subscriptions
      where user_id = '33333333-3333-3333-3333-333333333333') <> 100 then
    raise exception 'FAIL T1: expected 100 subscriptions at the cap';
  end if;
  -- 100 rows must carry 100 DISTINCT sort ordinals (0..99), not all default 0.
  select count(distinct sort) into n_distinct from public.subscriptions
    where user_id = '33333333-3333-3333-3333-333333333333';
  if n_distinct <> 100 then
    raise exception 'FAIL T1b: append sort regressed — % distinct ordinals, expected 100', n_distinct;
  end if;
  raise notice 'PASS T1: subscribed 100 feeds up to the cap, sort appended';
end $$;

-- ===== Test 2: the 101st NEW feed is rejected (configuration_limit_exceeded)
-- and no orphan `feeds` row is left behind (the cap is checked before create).
do $$
declare feeds_before int; feeds_after int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select count(*) into feeds_before from public.feeds
    where url = 'https://capuser.example/one-too-many';
  begin
    perform public.subscribe_to_feed('https://capuser.example/one-too-many');
    raise exception 'FAIL T2: subscribe past the cap succeeded';
  exception when configuration_limit_exceeded then
    raise notice 'PASS T2: subscribe past the cap rejected';
  end;
  select count(*) into feeds_after from public.feeds
    where url = 'https://capuser.example/one-too-many';
  if feeds_after <> feeds_before then
    raise exception 'FAIL T2b: capped reject left an orphan feed row';
  end if;
  raise notice 'PASS T2b: capped reject created no orphan feed';
end $$;

-- ===== Test 3: re-subscribing to a feed already followed is exempt at the cap
-- (the RPC stays idempotent — re-adding an existing feed still returns it).
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  perform public.subscribe_to_feed('https://capuser.example/feed-1');  -- already followed
  select count(*) into n from public.subscriptions
    where user_id = '33333333-3333-3333-3333-333333333333';
  if n <> 100 then
    raise exception 'FAIL T3: re-subscribe at the cap changed the count (%), not idempotent', n;
  end if;
  raise notice 'PASS T3: idempotent re-subscribe exempt from the cap';
end $$;

-- --- Cleanup ----------------------------------------------------------------
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
delete from public.feeds where url like 'https://capuser.example/%';
