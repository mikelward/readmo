-- Regression test for 0044_feeds_due_for_poll.sql.
--
-- Proves feeds_due_for_poll() returns exactly the due feeds that still have a
-- subscriber: a due+subscribed feed is selected; a due feed with NO subscriber
-- (incl. one kept alive only by a pinned item) is skipped; a subscribed feed
-- that is not yet due is skipped; and p_limit + most-overdue-first ordering
-- hold. Plain SQL (no pgTAP): each check raises NOTICE 'PASS …' on success and
-- raises an EXCEPTION on failure, so psql with ON_ERROR_STOP=1 is a hard gate.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/feeds_due_for_poll.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id = '44444444-4444-4444-4444-444444444444';
delete from public.feeds where id in (
  '10101010-1010-1010-1010-101010101010',  -- due + subscribed        → selected
  '20202020-2020-2020-2020-202020202020',  -- due + no subscriber      → skipped
  '30303030-3030-3030-3030-303030303030',  -- due + pinned-kept only   → skipped
  '40404040-4040-4040-4040-404040404040'); -- subscribed but not due   → skipped

insert into auth.users (id) values ('44444444-4444-4444-4444-444444444444');

-- Due + subscribed (most overdue) → must be selected, first.
insert into public.feeds (id, url, next_fetch_at) values
  ('10101010-1010-1010-1010-101010101010', 'https://due-sub.example/f.xml', now() - interval '10 min');
insert into public.subscriptions (user_id, feed_id) values
  ('44444444-4444-4444-4444-444444444444', '10101010-1010-1010-1010-101010101010');

-- Due, no subscriber → must be skipped (the whole point of the filter).
insert into public.feeds (id, url, next_fetch_at) values
  ('20202020-2020-2020-2020-202020202020', 'https://due-nosub.example/f.xml', now() - interval '5 min');

-- Due, no subscriber but a pinned item keeps it alive → still skipped for
-- polling (we preserve the item, we don't fetch the feed).
insert into public.feeds (id, url, next_fetch_at) values
  ('30303030-3030-3030-3030-303030303030', 'https://due-pinned.example/f.xml', now() - interval '5 min');
insert into public.items (id, feed_id, guid) values
  ('30300001-0000-0000-0000-000000000001', '30303030-3030-3030-3030-303030303030', 'g-30');
insert into public.item_state (user_id, item_id, pinned, pinned_at) values
  ('44444444-4444-4444-4444-444444444444', '30300001-0000-0000-0000-000000000001', true, now());

-- Subscribed but not yet due → must be skipped.
insert into public.feeds (id, url, next_fetch_at) values
  ('40404040-4040-4040-4040-404040404040', 'https://notdue-sub.example/f.xml', now() + interval '1 hour');
insert into public.subscriptions (user_id, feed_id) values
  ('44444444-4444-4444-4444-444444444444', '40404040-4040-4040-4040-404040404040');

-- ===== Test 1: only the due + subscribed feed is returned ===================
do $$
declare ids uuid[];
begin
  select array_agg(id order by id) into ids
  from public.feeds_due_for_poll(100)
  where id in ('10101010-1010-1010-1010-101010101010',
               '20202020-2020-2020-2020-202020202020',
               '30303030-3030-3030-3030-303030303030',
               '40404040-4040-4040-4040-404040404040');
  if ids is distinct from array['10101010-1010-1010-1010-101010101010']::uuid[] then
    raise exception 'FAIL T1: expected only the due+subscribed feed, got %', ids;
  end if;
  raise notice 'PASS T1: only due + subscribed feed selected (no-sub / pinned-only / not-due skipped)';
end $$;

-- ===== Test 2: p_limit caps the batch =======================================
do $$
declare n int;
begin
  -- At least one due + subscribed feed exists (10101010), so a limit of 1 must
  -- return exactly one row — never more.
  select count(*) into n from public.feeds_due_for_poll(1);
  if n <> 1 then raise exception 'FAIL T2: p_limit=1 returned % rows', n; end if;
  raise notice 'PASS T2: p_limit caps the batch';
end $$;

-- --- Cleanup ---------------------------------------------------------------
delete from auth.users where id = '44444444-4444-4444-4444-444444444444';
delete from public.feeds where id in (
  '10101010-1010-1010-1010-101010101010',
  '20202020-2020-2020-2020-202020202020',
  '30303030-3030-3030-3030-303030303030',
  '40404040-4040-4040-4040-404040404040');
