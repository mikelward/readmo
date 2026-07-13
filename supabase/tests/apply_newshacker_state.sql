-- Regression test for apply_newshacker_state (0063, rewritten set-based and
-- change-only in 0065) — the reverse pull of newshacker's Done AND Pinned
-- lists. Plain SQL (no pgTAP): each check raises
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
  -- Stale pulled pin (older clock) must not re-pin it. The entry still writes
  -- ONCE — the pin itself loses LWW, but its exclusivity closure stamps the
  -- row's never-recorded done/hidden clocks — and the REPEAT pull is silent
  -- (0063 re-counted the rejected attempt forever, telling the client to
  -- re-hydrate for nothing on every pull).
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":300,"at":1700000008000}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T5a: expected 1 closure write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned;
  if n <> 0 then raise exception 'FAIL T5b: stale pulled pin clobbered a newer local unpin'; end if;
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":300,"at":1700000008000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T5c: stale pin re-pull wrote % rows', n; end if;
  raise notice 'PASS T5: stale pulled pin loses per-field LWW, then goes quiet';
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

-- ===== Test 7: re-pulling already-applied state is a zero-write no-op =======
-- The steady-state pull (every tab focus): newshacker's lists still contain
-- everything applied earlier, and none of it may issue a write or count toward
-- `applied` — a non-zero return makes the client re-hydrate its whole state.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- Item 200 is pinned since T2; its done was cleared by T2's closure. Re-pull
  -- both facts (the pin, and an un-done tombstone) at their original clocks.
  n := public.apply_newshacker_state(
    '[{"id":200,"at":1700000005000,"deleted":true}]'::jsonb,
    '[{"id":200,"at":1700000005000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T7a: re-pull issued % writes', n; end if;
  select count(*) into n from public.item_state
    where item_id='22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned and not done;
  if n <> 1 then raise exception 'FAIL T7b: re-pull disturbed item 200'; end if;
  raise notice 'PASS T7: an already-in-sync pull issues zero writes';
end $$;

-- ===== Test 8: malformed entries are skipped, valid siblings still apply ====
-- 0063 skipped malformed entries via per-entry exception blocks; 0065 must do
-- the same via its filter predicates — and never abort the whole batch.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_state(
    ('[' ||
     '"junk",' ||                                -- not an object
     '{"id":"300","at":1700000010000},' ||       -- id as a string, not a number
     '{"id":300.5,"at":1700000010000},' ||       -- fractional id
     '{"id":-300,"at":1700000010000},' ||        -- non-positive id
     '{"id":300,"at":1e20},' ||                  -- at past the timestamp ceiling
     '{"id":300,"at":"soon"},' ||                -- at not a number
     '{"id":300},' ||                            -- at missing
     '{"id":300,"at":1700000010000}' ||          -- valid: done item 300
     ']')::jsonb,
    '[]'::jsonb);
  if n <> 1 then raise exception 'FAIL T8a: expected 1 write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done;
  if n <> 1 then raise exception 'FAIL T8b: valid entry did not apply'; end if;
  raise notice 'PASS T8: malformed entries are skipped without aborting the batch';
end $$;

-- ===== Test 9: a newer same-value entry advances the field clock ============
-- Item 100 is unpinned locally-and-remotely (T3, clock t6). A LATER newshacker
-- unpin tombstone (t7) changes no value, but must still write ONCE so the
-- stored clock advances — otherwise a stale offline pin timestamped between
-- t6 and t7 would pass LWW and resurrect the pin the user already undid.
-- Re-pulling the same tombstone afterwards must be a zero-write no-op.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":100,"at":1700000007000,"deleted":true}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T9a: expected 1 clock-advancing write, got %', n; end if;
  -- A stale offline pin between the two unpin clocks must now lose LWW.
  perform public.set_item_state(
    '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    p_pinned => true, p_pinned_at => to_timestamp(1700000006500 / 1000.0));
  select count(*) into n from public.item_state
    where item_id='11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned;
  if n <> 0 then raise exception 'FAIL T9b: stale offline pin beat the advanced clock'; end if;
  -- The same tombstone again: clock equal, value equal -> filtered.
  n := public.apply_newshacker_state(
    '[]'::jsonb,
    '[{"id":100,"at":1700000007000,"deleted":true}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T9c: re-pull of the tombstone wrote % rows', n; end if;
  raise notice 'PASS T9: newer same-value entry advances the LWW clock, once';
end $$;

-- ===== Test 10: same-clock Done+Pin conflict settles on the pin =============
-- newshacker's lists are independent, so the same id can appear non-deleted in
-- BOTH with a tied millisecond clock. The pin must win deterministically and
-- the pull must settle (repeat pulls issue zero writes) — without the
-- conflict rule, each write's exclusivity closure re-arms the other entry's
-- tied-clock branch and the item flips Done<->Pinned on alternating pulls.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- Item 300 is Done since T8 (done_at t10). Both lists now claim it at t11.
  n := public.apply_newshacker_state(
    '[{"id":300,"at":1700000011000}]'::jsonb,
    '[{"id":300,"at":1700000011000}]'::jsonb);
  if n <> 1 then raise exception 'FAIL T10a: expected 1 write (pin only), got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned and not done;
  if n <> 1 then raise exception 'FAIL T10b: tied Done+Pin did not settle on the pin'; end if;
  -- The very next pull re-sends both entries: nothing may write or flip.
  n := public.apply_newshacker_state(
    '[{"id":300,"at":1700000011000}]'::jsonb,
    '[{"id":300,"at":1700000011000}]'::jsonb);
  if n <> 0 then raise exception 'FAIL T10c: tied re-pull oscillated (% writes)', n; end if;
  select count(*) into n from public.item_state
    where item_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and pinned and not done;
  if n <> 1 then raise exception 'FAIL T10d: state flipped on the re-pull'; end if;
  raise notice 'PASS T10: tied Done+Pin resolves to the pin and settles';
end $$;

-- ===== Test 11: far-future clocks are dropped, sane skew is accepted ========
-- set_item_state clamps a far-future clock to now() on write, so a pulled
-- entry whose raw `at` stays in the future would outrank its own clamped
-- stored clock again on EVERY pull (now() keeps advancing) — writing and
-- returning applied>0 forever. The pull therefore drops entries beyond the
-- same 10-minute tolerance instead of clamping. Skew inside the tolerance
-- still applies normally.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- An hour in the future: dropped, no write, no state change (twice — the
  -- second pull must be just as quiet).
  n := public.apply_newshacker_state(
    jsonb_build_array(jsonb_build_object(
      'id', 100, 'at', (extract(epoch from now()) * 1000 + 3600000)::bigint)),
    '[]'::jsonb);
  if n <> 0 then raise exception 'FAIL T11a: far-future entry applied (%)', n; end if;
  n := public.apply_newshacker_state(
    jsonb_build_array(jsonb_build_object(
      'id', 100, 'at', (extract(epoch from now()) * 1000 + 3600000)::bigint)),
    '[]'::jsonb);
  if n <> 0 then raise exception 'FAIL T11b: far-future entry re-applied (%)', n; end if;
  select count(*) into n from public.item_state
    where item_id='11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done;
  if n <> 0 then raise exception 'FAIL T11c: far-future entry changed state'; end if;
  -- Five minutes ahead (ordinary device skew, inside the tolerance): applies.
  n := public.apply_newshacker_state(
    jsonb_build_array(jsonb_build_object(
      'id', 100, 'at', (extract(epoch from now()) * 1000 + 300000)::bigint)),
    '[]'::jsonb);
  if n <> 1 then raise exception 'FAIL T11d: in-tolerance skew did not apply (%)', n; end if;
  select count(*) into n from public.item_state
    where item_id='11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and done;
  if n <> 1 then raise exception 'FAIL T11e: in-tolerance done not applied'; end if;
  raise notice 'PASS T11: far-future clocks dropped, in-tolerance skew applies';
end $$;

-- ===== Test 12: a stale entry still lands its winning exclusivity clear =====
-- A non-deleted entry writes its own field plus the exclusivity clears, each
-- LWW-gated separately by set_item_state. An entry stale for its OWN field
-- (a newer un-done outranks it) can still carry a winning cross-field clear:
-- the Done at t11.5 below lost to the local un-done at t12, but its closure
-- must still unpin the OLDER pin from t5 — the pin was consumed when the item
-- became Done. The gate must admit such entries, and re-pulling must be quiet.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  -- Item 200 is pinned@t5 (T2). Local un-done at t12 (newer than the pull).
  perform public.set_item_state(
    '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    p_done => false, p_done_at => to_timestamp(1700000012000 / 1000.0));
  -- Pulled Done between the pin and the un-done: done=true loses (t11.5<t12),
  -- but the closure's pinned=false wins (t11.5>t5) and must clear the pin.
  n := public.apply_newshacker_state(
    '[{"id":200,"at":1700000011500}]'::jsonb,
    '[]'::jsonb);
  if n <> 1 then raise exception 'FAIL T12a: expected 1 write, got %', n; end if;
  select count(*) into n from public.item_state
    where item_id='22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and not pinned and not done;
  if n <> 1 then raise exception 'FAIL T12b: stale Done''s closure did not unpin'; end if;
  -- Same entry again: every field it writes is now at >= its clock -> quiet.
  n := public.apply_newshacker_state(
    '[{"id":200,"at":1700000011500}]'::jsonb,
    '[]'::jsonb);
  if n <> 0 then raise exception 'FAIL T12c: re-pull re-applied (% writes)', n; end if;
  raise notice 'PASS T12: stale entry lands its winning exclusivity clear, once';
end $$;

-- --- Cleanup ---------------------------------------------------------------
delete from auth.users where id in (
  '11111111-1111-1111-1111-111111111111');
delete from public.feeds where id in (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

\echo 'apply_newshacker_state.sql: ALL PASS'
