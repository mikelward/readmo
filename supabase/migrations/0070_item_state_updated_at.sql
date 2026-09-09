-- Give item_state a server-assigned change clock, so a client can ask "what
-- changed since I last looked?" instead of re-reading its whole history.
--
-- The client hydrates item_state on every focus / visibility / online tick, and
-- that read is a FULL one — paged at PostgREST's 1000-row ceiling, each page
-- awaited before the next is requested. Cost is therefore proportional to how
-- much triage the account has ever done, not to how much changed. On an account
-- using mark-done-on-scroll (a row written per row scrolled past) that reaches
-- tens of sequential round trips per tab return: seconds of latency before a pin
-- made on another device appears, and eventually a page read that blows the 5s
-- `authenticated` statement_timeout from 0015 — at which point the resync fails
-- outright and cross-device triage stops arriving until a later read gets lucky.
--
-- `updated_at` is the cursor that fixes the shape: the client keeps the newest
-- value it has seen and asks only for rows past it, which is normally none.
--
-- SERVER-ASSIGNED, always. A client clock must never set it — that's the same
-- reasoning 0023 applies to the per-field `<f>_at` clocks, and doubly so here,
-- because a skewed client could otherwise stamp a row into the future and make
-- every other device's cursor step over rows it has never seen.
--
-- The BEFORE trigger catches every write path at once — `set_item_state` (all
-- client triage), `apply_newshacker_state` (which delegates to it), and any
-- future writer — rather than each one remembering to maintain the column.
-- Note this is NOT a revival of 0003's `item_state_bump`: that trigger also
-- owned exclusivity and *_at stamping, which 0023 deliberately moved into
-- set_item_state's per-field last-write-wins. This one does exactly one thing.

alter table public.item_state
  add column if not exists updated_at timestamptz not null default now();

-- Backfill: the best available "when did this row last change" for existing
-- rows is the newest of its five per-field clocks. greatest() ignores NULLs, so
-- a row with only some clocks set still gets the right answer; a row with none
-- (no information at all) falls back to now(), which merely means the first
-- incremental read may return it once. Harmless — applying a row is idempotent.
--
-- CAPPED AT SERVER TIME, and that cap is load-bearing. Those five clocks are
-- CLIENT-supplied action times (0023), and 0057 only clamps them to now() plus a
-- ten-minute tolerance — rows written before that clamp existed may sit
-- arbitrarily far in the future. An uncapped backfill would put `updated_at`
-- ahead of server time, the first full read would adopt that as its cursor, and
-- every subsequent write — stamped `now()` by the trigger, i.e. EARLIER — would
-- fall below the delta's lower bound and be invisible until the server clock
-- caught up. Sync would stall for minutes, or far longer on a pre-0057 row.
-- least() makes the column what it claims to be: a server-owned clock that can
-- never lead server time.
update public.item_state
set updated_at = least(
      coalesce(
        greatest(pinned_at, favorite_at, done_at, hidden_at, opened_at),
        now()),
      now())
where true;

create or replace function public.item_state_touch()
returns trigger
language plpgsql
as $$
begin
  -- now() (transaction start), not clock_timestamp(): every row written by one
  -- statement then shares a cursor value, so a multi-row write can't be split
  -- across a client's cursor boundary and half-missed.
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists item_state_touch_trg on public.item_state;
create trigger item_state_touch_trg
  before insert or update on public.item_state
  for each row
  execute function public.item_state_touch();

comment on function public.item_state_touch() is
  'Stamps item_state.updated_at server-side on every write, so clients can pull '
  'incrementally ("what changed since my cursor?") instead of re-reading the '
  'full table on each focus. Never accepts a client-supplied value.';

-- Serves the incremental read: `where user_id = auth.uid() and updated_at >= $1
-- order by updated_at, item_id`. user_id first (RLS scopes every read to one
-- account), then the cursor column, so the scan starts at the cursor and the
-- ordering comes free.
create index if not exists item_state_user_updated_idx
  on public.item_state (user_id, updated_at, item_id);
