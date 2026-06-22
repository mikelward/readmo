-- Access-control regression test for 0004_access_rpcs.sql.
--
-- Proves the access-by-UUID escalation (0002_rls.sql TODO(P1)) is closed and
-- that the SECURITY DEFINER write RPCs grant legitimate access. Plain SQL (no
-- pgTAP): each check raises NOTICE 'PASS …' on success and raises an EXCEPTION
-- on failure, so running under psql with ON_ERROR_STOP=1 makes it a hard gate.
--
-- Run against a database that already has the Supabase `auth` schema + the
-- anon/authenticated roles (e.g. local `supabase start` / `supabase db reset`,
-- then this file). The seed runs as the migration/superuser role, standing in
-- for the service-role poller that populates shared feeds/items.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/access_rpcs.sql
--
-- Validated locally against PostgreSQL 16 with minimal auth/role shims.

\set ATT  '11111111-1111-1111-1111-111111111111'

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222');
delete from public.feeds where id in (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'dddddddd-dddd-dddd-dddd-dddddddddddd');

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- attacker
  ('22222222-2222-2222-2222-222222222222');  -- victim
-- Private/tokenized feed the attacker must NOT reach without its URL.
insert into public.feeds (id, url, site_url, title) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'https://secret.example/token123/feed.xml', 'https://secret.example', 'Private Feed');
insert into public.items (id, feed_id, guid, title) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'guid-1', 'Secret Article');
-- Public feed + item the attacker WILL reach by pasting its URL.
insert into public.feeds (id, url, site_url, title) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd',
   'https://public.example/feed.xml', 'https://public.example', 'Public Feed');
insert into public.items (id, feed_id, guid, title) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'guid-2', 'Public Article');

-- ===== Test 1: direct INSERT escalation by UUID is BLOCKED (grant revoked) ==
do $$
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  begin
    insert into public.subscriptions(user_id, feed_id)
      values (auth.uid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'FAIL T1a: direct subscription INSERT succeeded';
  exception when insufficient_privilege then
    raise notice 'PASS T1a: direct subscription INSERT denied';
  end;
  begin
    insert into public.item_state(user_id, item_id, pinned)
      values (auth.uid(), 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);
    raise exception 'FAIL T1b: direct item_state INSERT succeeded';
  exception when insufficient_privilege then
    raise notice 'PASS T1b: direct item_state INSERT denied';
  end;
end $$;

-- ===== Test 2: attacker cannot SEE the private feed/item via RLS ============
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  select count(*) into n from public.items where id='cccccccc-cccc-cccc-cccc-cccccccccccc';
  if n <> 0 then raise exception 'FAIL T2: attacker sees % secret items', n; end if;
  select count(*) into n from public.feeds where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if n <> 0 then raise exception 'FAIL T2: attacker sees % secret feeds', n; end if;
  raise notice 'PASS T2: private feed/item invisible to attacker';
end $$;

-- ===== Test 3: set_item_state visibility gate rejects the bootstrap ========
do $$
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  begin
    perform public.set_item_state('cccccccc-cccc-cccc-cccc-cccccccccccc', p_pinned => true);
    raise exception 'FAIL T3: set_item_state pinned a non-visible item';
  exception when insufficient_privilege then
    raise notice 'PASS T3: set_item_state rejected non-visible item';
  end;
end $$;

-- ===== Test 4: subscribe_to_feed by URL works; the item becomes visible =====
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform public.subscribe_to_feed('https://public.example/feed.xml');
  select count(*) into n from public.subscriptions where user_id=auth.uid();
  if n <> 1 then raise exception 'FAIL T4a: expected 1 subscription, got %', n; end if;
  select count(*) into n from public.items where id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  if n <> 1 then raise exception 'FAIL T4b: public item not visible after subscribe'; end if;
  raise notice 'PASS T4: subscribe-by-URL grants access to the public feed/item';
end $$;

-- ===== Test 5: pin while subscribed; retain access after unsubscribe ========
do $$
declare v bigint; n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  select version into v from public.set_item_state('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', p_pinned => true);
  if v <> 1 then raise exception 'FAIL T5a: expected version 1, got %', v; end if;
  delete from public.subscriptions where user_id=auth.uid();        -- unsubscribe
  select count(*) into n from public.items where id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  if n <> 1 then raise exception 'FAIL T5b: kept item orphaned after unsubscribe'; end if;
  select version into v from public.set_item_state('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', p_done => true);
  if v <> 2 then raise exception 'FAIL T5c: expected version 2, got %', v; end if;
  select count(*) into n from public.item_state where item_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and pinned;
  if n <> 0 then raise exception 'FAIL T5d: pin not cleared by Done'; end if;
  raise notice 'PASS T5: permanent state retained post-unsubscribe; trigger intact';
end $$;

-- ===== Test 6: repointing subscriptions.feed_id via direct UPDATE is denied =
-- (Revoking INSERT alone is not enough — a legit row's access-granting key must
-- not be mutable to a private UUID. See 0004 update lock-down.)
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform public.subscribe_to_feed('https://public.example/feed.xml');   -- legit row
  begin
    update public.subscriptions set feed_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      where user_id=auth.uid();
    raise exception 'FAIL T6: subscriptions.feed_id UPDATE succeeded';
  exception when insufficient_privilege then
    raise notice 'PASS T6: subscriptions.feed_id UPDATE denied';
  end;
  select count(*) into n from public.items where id='cccccccc-cccc-cccc-cccc-cccccccccccc';
  if n <> 0 then raise exception 'FAIL T6b: private item visible via UPDATE (n=%)', n; end if;
  raise notice 'PASS T6b: private item still invisible';
end $$;

-- ===== Test 7: legit display/ordering updates on subscriptions still work ===
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  update public.subscriptions set muted=true, folder='News', sort=3 where user_id=auth.uid();
  select count(*) into n from public.subscriptions
    where user_id=auth.uid() and muted and folder='News' and sort=3;
  if n <> 1 then raise exception 'FAIL T7: legit subscription update blocked'; end if;
  raise notice 'PASS T7: mute/folder/sort updates still allowed';
end $$;

-- ===== Test 8: direct UPDATE on item_state is fully revoked (no key repoint) =
do $$
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- attacker holds a permanent row on the public item (from T5).
  begin
    update public.item_state set item_id='cccccccc-cccc-cccc-cccc-cccccccccccc'
      where user_id=auth.uid();
    raise exception 'FAIL T8: item_state direct UPDATE succeeded';
  exception when insufficient_privilege then
    raise notice 'PASS T8: item_state direct UPDATE denied';
  end;
end $$;

-- ===== Test 9: set_item_state still performs flag writes (RPC is the path) ===
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform public.set_item_state('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', p_favorite => true);
  select count(*) into n from public.item_state
    where item_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and favorite;
  if n <> 1 then raise exception 'FAIL T9: RPC flag update broken'; end if;
  raise notice 'PASS T9: set_item_state still performs flag writes';
end $$;
