-- reap_orphan_feeds: re-check subscribers under lock, closing the race that
-- silently cascade-deleted a just-committed subscription.
--
-- 0043 gave subscribe_to_feed a FOR KEY SHARE lock on the resolved feed row
-- and reasoned the reaper's DELETE would block on it and then "re-evaluate
-- (EvalPlanQual) against the now-committed subscription". That reasoning was
-- wrong: EvalPlanQual only re-checks a tuple the blocker UPDATEd or DELETEd.
-- A lock-only conflict leaves the tuple version unchanged, so when the
-- subscriber commits, the blocked DELETE simply proceeds — and in READ
-- COMMITTED its NOT EXISTS (subscriptions) subplan keeps the DELETE's
-- original statement snapshot, which predates the subscription INSERT.
-- Net effect (reproduced against PostgreSQL 16): reaper evaluates feed F as
-- orphaned, blocks on the subscriber's KEY SHARE, subscriber commits, reaper
-- unblocks and deletes F anyway — ON DELETE CASCADE removes the user's
-- brand-new subscription without any error. 0043 turned the original visible
-- FK failure into silent data loss.
--
-- Fix: split the reap into lock-then-recheck.
--   1. SELECT … FOR UPDATE the orphan candidates. FOR UPDATE conflicts with
--      the subscriber's FOR KEY SHARE, so this statement blocks until every
--      in-flight subscribe to a candidate commits — and once we hold the
--      locks, no NEW subscribe can resolve a candidate row (its KEY SHARE
--      blocks against our FOR UPDATE until we commit).
--   2. DELETE the locked candidates re-checking BOTH conditions. In READ
--      COMMITTED this second statement takes a fresh snapshot that sees any
--      subscription (or permanent item_state) committed while step 1 waited,
--      so the just-subscribed feed is skipped instead of reaped.
-- Deadlock-free against subscribes: a subscribe transaction locks exactly one
-- feed row, so it can never hold one candidate while waiting on another.
--
-- Otherwise identical to the 0042 definition (re-stated in full, as Postgres
-- replaces functions wholesale); see 0042 for why permanent
-- (pinned/favorite/done) item_state also exempts a feed.

create or replace function public.reap_orphan_feeds()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidates uuid[];
  reaped integer;
begin
  -- Step 1: lock the candidates. May over-select a feed whose subscription
  -- commits while we wait for its lock — step 2's fresh snapshot filters it.
  select coalesce(array_agg(id), '{}') into v_candidates
  from (
    select f.id
    from public.feeds f
    where not exists (
            select 1 from public.subscriptions s
            where s.feed_id = f.id
          )
      and not exists (
            select 1
            from public.item_state st
            join public.items i on i.id = st.item_id
            where i.feed_id = f.id
              and (st.pinned or st.favorite or st.done)
          )
    for update
  ) c;

  -- Step 2: delete under the locks, re-checking against a fresh snapshot.
  with gone as (
    delete from public.feeds f
    where f.id = any(v_candidates)
      and not exists (
            select 1 from public.subscriptions s
            where s.feed_id = f.id
          )
      and not exists (
            select 1
            from public.item_state st
            join public.items i on i.id = st.item_id
            where i.feed_id = f.id
              and (st.pinned or st.favorite or st.done)
          )
    returning 1
  )
  select count(*) into reaped from gone;
  return reaped;
end;
$$;

comment on function public.reap_orphan_feeds() is
  'Deletes every feed that has no subscribers AND no permanent '
  '(pinned/favorite/done) item_state on any of its items — via ON DELETE '
  'CASCADE this also drops its items and their sparse per-user rows. Returns the '
  'number of feeds reaped. Called by the poller (service role) once per run. '
  'Locks candidates FOR UPDATE, then re-checks both conditions under a fresh '
  'snapshot (0056) so a subscribe committing mid-reap is seen, not '
  'cascade-deleted. The permanent-state exemption mirrors the feeds_select RLS '
  'test (0002) so a user''s kept items are never garbage-collected out from '
  'under them.';

-- Re-assert the 0042 lockdown (create-or-replace preserves grants, but be
-- explicit so a fresh apply order can't leave it EXECUTE-to-PUBLIC).
revoke execute on function public.reap_orphan_feeds() from public;
grant  execute on function public.reap_orphan_feeds() to service_role;
