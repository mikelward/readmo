-- The entitlement spine: who is on which tier, and what that tier allows.
--
-- This is the FOUNDATION only. It creates the table, its RLS boundary, the
-- read helpers, and a signup default. It gates nothing and changes no
-- behavior — every value it hands out is what the app already does today.
-- Gating individual surfaces, and Stripe, come later; MONETIZATION.md holds
-- the plan and TODO.md the checklist.
--
-- WHY A NEW TABLE RATHER THAN EXTENDING `allowlist`
-- The two answer different questions and must not be collapsed. The allowlist
-- is a LEGAL gate on what Readmo may fetch and store (full text through Jina,
-- Google News feeds); an entitlement is a COMMERCIAL gate on who has paid.
-- A paid caller who is not allowlisted gains nothing on the legal surfaces,
-- and an allowlisted caller who has not paid keeps everything they have today.
-- Where both apply, `summary` is entitlement AND allowlist.
--
-- ABSENT TABLE vs ABSENT ROW — these are different and the difference matters
--   * Table absent (an older backend in front of a newer client): the client
--     must behave exactly as it does today. That case is handled client-side by
--     feature-detecting this migration's RPC; nothing here can observe it.
--   * Row absent (this table exists, the caller has none): the FREE tier.
--     Reading it as "current behavior" would hand every future signup the
--     legacy allowance permanently, and the backfill below would hide it —
--     for the users who existed at deploy time, it would look like it worked.
--   The signup trigger makes the row-absent branch a safety net rather than
--   the normal path for every new account.
--
-- WHY THE FREE TIER'S CAP IS TODAY'S CAP (100)
-- Deliberate. `subscribe_to_feed` hard-codes `v_cap constant int := 100`
-- (0059), so a free tier of anything lower would silently shrink what a new
-- account may do the moment this migration applies — before there is a paid
-- tier to sell them, and with no announcement. The spine must be a no-op on
-- deploy (guardrail #11). Lowering the free cap to create the paid
-- differential is a separate, deliberate change, and a product decision.
--
-- Cost/reliability (guardrail #5): negligible. One indexed primary-key read
-- per gated call once gating exists, against a table with one row per account.
-- No new external dependency, no new failure mode beyond "the DB is down",
-- which every path here already has.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.entitlements (
  user_id                uuid        not null primary key
                           references auth.users(id) on delete cascade,
  -- 'free' | 'paid'. Text rather than an enum so adding a tier is a data
  -- change, not a migration that has to be coordinated with a deploy.
  tier                   text        not null default 'free',
  -- Mirrors the payment provider's own subscription status where there is one
  -- ('active', 'past_due', 'canceled', ...). 'none' for an account that has
  -- never subscribed, which is every account today.
  status                 text        not null default 'none',
  -- When the paid period ends. NULL for a free account. A row read
  -- successfully whose period has just lapsed gets the grace window (see
  -- _shared/entitlement.ts); that is NOT the same as a failed read.
  current_period_end     timestamptz,
  -- Per-account feed cap, replacing 0059's hard-coded constant once
  -- subscribe_to_feed is taught to read it. Defaults to today's value.
  feed_cap               int         not null default 100,
  -- Provider ids, service-role only — never sent to a client, and never
  -- accepted FROM one (a client-supplied customer id would let anyone open
  -- anyone else's billing page). Enforced by the revoke-then-column-grant
  -- below, not by convention: RLS alone would not keep these out of a direct
  -- read, and a column grant alone would not either.
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint entitlements_tier_known check (tier in ('free', 'paid')),
  constraint entitlements_feed_cap_sane check (feed_cap > 0 and feed_cap <= 10000)
);

-- Looking a row up by provider id is how a webhook finds the account it is
-- about. Partial, because almost every row has no provider id at all.
create unique index if not exists entitlements_stripe_customer_id_key
  on public.entitlements (stripe_customer_id)
  where stripe_customer_id is not null;
create unique index if not exists entitlements_stripe_subscription_id_key
  on public.entitlements (stripe_subscription_id)
  where stripe_subscription_id is not null;

alter table public.entitlements enable row level security;

-- The RLS boundary (guardrail #7). A caller may read their OWN row; nothing
-- else. Only the service role writes, so a compromised client cannot promote
-- itself to a paid tier or widen its own cap.
drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own on public.entitlements
  for select using (user_id = auth.uid());

-- RLS restricts ROWS, not COLUMNS — so a table-wide select grant would let any
-- signed-in caller read its own row through PostgREST *including* the provider
-- ids, going around `get_entitlement()` entirely. The grant is therefore
-- column-level, naming exactly the display-safe set the RPC returns.
--
-- The REVOKE is what makes that grant mean anything. Supabase's public schema
-- grants table-level privileges to anon/authenticated by default, so a new
-- table arrives already readable in full and a column grant only ADDS to what
-- is there — it cannot narrow it. 0002_rls.sql makes the same move for `feeds`
-- to keep `secret_url` off the client, and for the same reason: without the
-- revoke, "provider ids never leave the server" would be a comment rather than
-- a property, and it would only start being false once Stripe populated them,
-- long after anyone was still looking at this file. Revoking the writes as well
-- is defensive — no policy permits them, so RLS already refuses — but it means
-- the privilege and the policy say the same thing rather than relying on the
-- reader to check both.
revoke all on public.entitlements from public, anon, authenticated;
grant select (user_id, tier, status, current_period_end, feed_cap)
  on public.entitlements to authenticated;
grant select, insert, update, delete on public.entitlements to service_role;

create or replace function public.entitlements_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists entitlements_set_updated_at on public.entitlements;
create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute function public.entitlements_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Provisioning
-- ---------------------------------------------------------------------------

-- Backfill: every account that exists at apply time gets a row carrying
-- today's behavior. Grandfathering is done by writing rows FOR people, never
-- by letting a gate flip shut on deploy.
insert into public.entitlements (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- And every account created after it. `security definer` because the trigger
-- runs in the signing-up user's context, which has no insert grant — by
-- design, see the RLS note above.
create or replace function public.handle_new_user_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.entitlements (user_id)
    values (new.id)
    on conflict (user_id) do nothing;
  exception when others then
    -- Provisioning must never roll back account creation: a missing row
    -- resolves to the free tier anyway (see the header), so the cost of this
    -- failing is a log line, not a broken signup. Same posture as 0012's
    -- notify trigger.
    raise warning 'handle_new_user_entitlement: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_entitlement on auth.users;
create trigger on_auth_user_created_entitlement
  after insert on auth.users
  for each row execute function public.handle_new_user_entitlement();

-- ---------------------------------------------------------------------------
-- Client-facing read
-- ---------------------------------------------------------------------------

-- What the client may know about its own tier — and nothing more: no provider
-- ids, no customer id. The client DISPLAYS tier and never decides it; every
-- enforcement decision is made server-side against the same row.
--
-- Returns the free-tier defaults when no row exists, so a caller whose signup
-- trigger failed still gets a coherent answer rather than an empty result the
-- client has to interpret.
--
-- IT RETURNS THE *EFFECTIVE* ENTITLEMENT, NOT THE STORED ROW. Returning the
-- columns verbatim would let a lapsed subscription keep displaying `paid` and
-- its raised cap after the gate functions had already stopped honoring them —
-- the client showing one answer while the server enforces another, which is
-- the shape of bug a user reports as "it says I'm subscribed but it won't let
-- me". So the same expiry-and-grace rule the gates apply is applied here.
--
-- KEEP THIS IN STEP WITH `resolveEntitlement` in
-- `supabase/functions/_shared/entitlement.ts` — same three-day grace window,
-- same treatment of a null period end (open-ended: a comp, or a plan not yet
-- given a period, so nothing has lapsed), same rule that a raised cap expires
-- with the tier that bought it. The duplication is deliberate: the gates run
-- in Deno and this runs in Postgres, and nothing can share one implementation
-- across both. Change one, change the other.
create or replace function public.get_entitlement()
returns table(tier text, status text, current_period_end timestamptz, feed_cap int)
language sql
security definer
set search_path = ''
stable
as $$
  with stored as (
    select
      coalesce(e.tier, 'free')   as tier,
      coalesce(e.status, 'none') as status,
      e.current_period_end,
      coalesce(e.feed_cap, 100)  as feed_cap
    from (select auth.uid() as uid) c
    left join public.entitlements e on e.user_id = c.uid
  ),
  resolved as (
    select
      s.*,
      -- Paid only while it has not lapsed past the grace window. Anything that
      -- is not a paid row keeps its stored tier and cap: on a free row the cap
      -- is an operator override, and only a subscription's cap expires.
      s.tier = 'paid'
        and (
          s.current_period_end is null
          or now() <= s.current_period_end + interval '3 days'
        ) as paid_now
    from stored s
  )
  select
    case when r.tier = 'paid' and not r.paid_now then 'free' else r.tier end,
    r.status,
    r.current_period_end,
    case when r.tier = 'paid' and not r.paid_now then 100 else r.feed_cap end
  from resolved r;
$$;

revoke execute on function public.get_entitlement() from public;
grant  execute on function public.get_entitlement() to authenticated;

comment on table public.entitlements is
  'Per-account tier and allowances. Read by the client for DISPLAY only '
  '(get_entitlement); written exclusively by the service role. A missing row '
  'means the free tier, NOT legacy behavior — see the migration header.';
