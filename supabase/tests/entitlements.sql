-- Regression test for 0077_entitlements.sql — the per-account entitlement row.
--
-- The Vitest suite next to `_shared/entitlement.ts` covers the resolution rule
-- against a stubbed client; it cannot see a missing REVOKE, a permissive RLS
-- predicate, or a security-definer RPC that returns the wrong thing. Those are
-- the properties this file exists for, and three of this migration's review
-- findings were exactly there: a table-wide grant, then a column grant that did
-- not narrow it, then an RPC returning the stored row rather than the effective
-- one. Each was caught by reading. This is what would have caught them running.
--
-- Plain SQL (no pgTAP): each check raises NOTICE 'PASS …' on success and an
-- EXCEPTION on failure, so `psql -v ON_ERROR_STOP=1` makes it a hard gate.
-- Mirrors the style of access_rpcs.sql / shared_public_items.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/entitlements.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id in (
  '44444444-4444-4444-4444-444444444444',   -- the caller under test
  '55555555-5555-5555-5555-555555555555',   -- somebody else
  '66666666-6666-6666-6666-666666666666');  -- an account with no entitlement row

insert into auth.users (id) values
  ('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555'),
  ('66666666-6666-6666-6666-666666666666');

-- The third user's provisioned row is removed so T4b's insert has a free target
-- and can only fail on privilege, never on the primary key. Done as the owner,
-- before any `set role` below.
delete from public.entitlements
 where user_id = '66666666-6666-6666-6666-666666666666';

-- ===== Test 1: the signup trigger provisions a free row =====================
-- An absent row means a NEW SIGNUP, not legacy behavior, so the trigger is what
-- keeps that branch a safety net rather than the normal path.
do $$
declare r record;
begin
  select * into r from public.entitlements
    where user_id = '44444444-4444-4444-4444-444444444444';
  if r is null then
    raise exception 'FAIL T1a: signup trigger did not provision a row'; end if;
  if r.tier <> 'free' then
    raise exception 'FAIL T1b: provisioned tier is %, expected free', r.tier; end if;
  if r.feed_cap <> 100 then
    raise exception 'FAIL T1c: provisioned cap is %, expected 100', r.feed_cap; end if;
  raise notice 'PASS T1: signup provisions a free row at today''s cap';
end $$;

-- ===== Test 2: a caller reads its OWN row and nobody else's ================
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  select count(*) into n from public.entitlements
    where user_id = '44444444-4444-4444-4444-444444444444';
  if n <> 1 then raise exception 'FAIL T2a: own row not readable (% rows)', n; end if;
  select count(*) into n from public.entitlements
    where user_id = '55555555-5555-5555-5555-555555555555';
  if n <> 0 then raise exception 'FAIL T2b: another account''s row is visible'; end if;
  raise notice 'PASS T2: own-row isolation holds';
end $$;

-- ===== Test 3: the provider ids are NOT readable, even on the own row ======
-- RLS restricts rows, not columns, so the row policy above says nothing about
-- this. The revoke-then-column-grant is what makes it true; a table-wide grant
-- passes T2 and fails here, which is the bug this migration shipped twice.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  begin
    execute 'select stripe_customer_id from public.entitlements where user_id = $1'
      using '44444444-4444-4444-4444-444444444444'::uuid;
    raise exception 'FAIL T3a: stripe_customer_id readable by an ordinary caller';
  exception when insufficient_privilege then null;
  end;
  begin
    execute 'select stripe_subscription_id from public.entitlements where user_id = $1'
      using '44444444-4444-4444-4444-444444444444'::uuid;
    raise exception 'FAIL T3b: stripe_subscription_id readable by an ordinary caller';
  exception when insufficient_privilege then null;
  end;
  -- The display-safe columns must still come back, or the revoke went too far.
  select count(*) into n from public.entitlements
    where user_id = '44444444-4444-4444-4444-444444444444' and tier = 'free';
  if n <> 1 then raise exception 'FAIL T3c: display-safe columns no longer readable'; end if;
  raise notice 'PASS T3: provider ids withheld, display-safe columns kept';
end $$;

-- ===== Test 4: a caller cannot write its own entitlement ===================
-- Both halves matter: no grant, and no policy. Either alone would let a future
-- change restore the other and reopen self-promotion.
do $$
begin
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  begin
    execute 'update public.entitlements set tier = ''paid'', feed_cap = 9999 where user_id = $1'
      using '44444444-4444-4444-4444-444444444444'::uuid;
    raise exception 'FAIL T4a: a caller promoted itself to paid';
  exception when insufficient_privilege then null;
  end;
  -- The insert must target a user with NO row, and only a privilege error may
  -- count. Aimed at a provisioned user it would raise unique_violation, and
  -- accepting that as "denied" makes the check pass even with an INSERT grant
  -- and a permissive policy both restored — a false pass in the one test whose
  -- job is to notice exactly that.
  begin
    execute 'insert into public.entitlements (user_id, tier) values ($1, ''paid'')'
      using '66666666-6666-6666-6666-666666666666'::uuid;
    raise exception 'FAIL T4b: a caller inserted an entitlement row';
  exception when insufficient_privilege then null;
  end;
  begin
    execute 'delete from public.entitlements where user_id = $1'
      using '44444444-4444-4444-4444-444444444444'::uuid;
    raise exception 'FAIL T4c: a caller deleted its entitlement row';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS T4: writes denied — no grant and no policy';
end $$;

-- ===== Test 5: get_entitlement returns the EFFECTIVE entitlement ===========
-- The RPC and `resolveEntitlement` must not disagree: returning the stored row
-- would leave a lapsed account displaying `paid` and its raised cap while every
-- gate treats it as free. Same three-day window on both sides.
do $$
declare r record;
begin
  -- Inside the window: still paid, cap intact.
  update public.entitlements
     set tier = 'paid', status = 'active', feed_cap = 1000,
         current_period_end = now() - interval '1 day'
   where user_id = '44444444-4444-4444-4444-444444444444';
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  select * into r from public.get_entitlement();
  if r.tier <> 'paid' then
    raise exception 'FAIL T5a: lapsed 1 day resolved to %, expected paid (grace)', r.tier; end if;
  if r.feed_cap <> 1000 then
    raise exception 'FAIL T5b: cap dropped to % inside the grace window', r.feed_cap; end if;
  raise notice 'PASS T5: inside the grace window, paid and its cap both hold';
end $$;

do $$
declare r record;
begin
  -- Past the window: free, and the cap the subscription bought goes with it.
  update public.entitlements
     set current_period_end = now() - interval '4 days'
   where user_id = '44444444-4444-4444-4444-444444444444';
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  select * into r from public.get_entitlement();
  if r.tier <> 'free' then
    raise exception 'FAIL T6a: lapsed 4 days resolved to %, expected free', r.tier; end if;
  if r.feed_cap <> 100 then
    raise exception 'FAIL T6b: cap is % past the grace window, expected 100', r.feed_cap; end if;
  raise notice 'PASS T6: past the grace window, tier and its cap both revert';
end $$;

do $$
declare r record;
begin
  -- A paid row with no end date is open-ended — nothing has lapsed.
  update public.entitlements
     set current_period_end = null
   where user_id = '44444444-4444-4444-4444-444444444444';
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  select * into r from public.get_entitlement();
  if r.tier <> 'paid' or r.feed_cap <> 1000 then
    raise exception 'FAIL T7: open-ended paid row resolved to %/%', r.tier, r.feed_cap; end if;
  raise notice 'PASS T7: a paid row with no period end stays paid';
end $$;

do $$
declare r record;
begin
  -- A FREE row's raised cap is an operator override and never expires — which
  -- is why an override for a non-subscriber is expressed this way, not as paid.
  update public.entitlements
     set tier = 'free', status = 'none', feed_cap = 500,
         current_period_end = now() - interval '30 days'
   where user_id = '44444444-4444-4444-4444-444444444444';
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444', true);
  set local role authenticated;
  select * into r from public.get_entitlement();
  if r.tier <> 'free' then
    raise exception 'FAIL T8a: free row resolved to %', r.tier; end if;
  if r.feed_cap <> 500 then
    raise exception 'FAIL T8b: operator override cap is %, expected 500', r.feed_cap; end if;
  raise notice 'PASS T8: a free row''s raised cap is honored indefinitely';
end $$;

-- ===== Test 9: get_entitlement never returns the provider ids ==============
-- Structural guard: the function's result type must not carry them, so no
-- caller can reach them through this path however the body is later rewritten.
do $$
declare n int;
begin
  select count(*) into n
    from information_schema.parameters
   where specific_schema = 'public'
     and specific_name in (
       select specific_name from information_schema.routines
        where routine_schema = 'public' and routine_name = 'get_entitlement')
     and parameter_name in ('stripe_customer_id', 'stripe_subscription_id');
  if n <> 0 then
    raise exception 'FAIL T9: get_entitlement exposes a provider id column'; end if;
  raise notice 'PASS T9: get_entitlement''s result type carries no provider ids';
end $$;

-- --- Clean up ---------------------------------------------------------------
reset role;
delete from auth.users where id in (
  '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555',
  '66666666-6666-6666-6666-666666666666');
