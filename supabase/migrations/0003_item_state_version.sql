-- Readmo item_state version bump + state-exclusivity enforcement.
--
-- SPEC.md "Sync": conflict resolution uses a SERVER-assigned monotonic
-- `version`, never a client wall-clock. This trigger:
--   1. Bumps `version` on every insert/update so the client can never set or
--      stall it (a skewed client clock must not be able to clobber newer
--      changes). The flush applies a field only if its last-seen version is
--      current; otherwise it reconciles against the winning value.
--   2. Enforces the state-exclusivity rules at the MUTATION layer (SPEC.md
--      "Shields … Enforcement at the mutation layer, not just the UI"):
--        - pinning removes Done and Hidden,
--        - hiding removes Pinned,
--        - marking Done removes Pinned.
--      Hidden ↔ Done may coexist (Done's filter supersedes Hide's).
--   3. Stamps the *_at timestamps when a flag flips true, and clears them when
--      it flips false, so the library views sort correctly without trusting
--      client-supplied timestamps.

create or replace function public.item_state_bump()
returns trigger
language plpgsql
as $$
declare
  -- Which flags were newly turned ON in THIS write. Exclusivity MUST key off
  -- the transition, not the absolute NEW value: on a partial UPDATE the
  -- unspecified columns keep their OLD values, so `update({done:true})` on an
  -- already-pinned row arrives with NEW.pinned still true — and absolute-value
  -- logic would then clear the Done the client just set, leaving the row
  -- pinned-and-not-done and breaking the pinned → Done lifecycle. Mirrors the
  -- client applyMutation (one field changed per write). On INSERT, OLD is NULL
  -- (its columns read as NULL), so "turned on" is simply the flag being true.
  pin_on  boolean := new.pinned and (tg_op = 'INSERT' or not old.pinned);
  hide_on boolean := new.hidden and (tg_op = 'INSERT' or not old.hidden);
  done_on boolean := new.done   and (tg_op = 'INSERT' or not old.done);
begin
  -- --- State exclusivity (write-path enforcement) -------------------------
  -- Pinning removes Done and Hidden.
  if pin_on then
    new.done   := false;
    new.hidden := false;
  end if;
  -- Hiding clears Pin.
  if hide_on then
    new.pinned := false;
  end if;
  -- Marking Done clears Pin (Done is where pinned items go when they leave
  -- the queue). Because done_on is transition-based, an explicit Done on a
  -- pinned row now correctly drops the pin and keeps Done.
  if done_on then
    new.pinned := false;
  end if;

  -- --- Timestamp stamping -------------------------------------------------
  -- The trigger is the trusted source of *_at — never accept a client-supplied
  -- timestamp. On INSERT, set now() for each flag that is true and NULL
  -- otherwise (a coalesce() would let a client insert a far-future hidden/
  -- opened timestamp and skew TTL retention + library ordering until the row
  -- is toggled again).
  if (tg_op = 'INSERT') then
    new.pinned_at   := case when new.pinned   then now() else null end;
    new.favorite_at := case when new.favorite then now() else null end;
    new.done_at     := case when new.done     then now() else null end;
    new.hidden_at   := case when new.hidden   then now() else null end;
    new.opened_at   := case when new.opened   then now() else null end;
  else
    -- On UPDATE, stamp on a false→true transition and clear on true→false.
    if new.pinned and not old.pinned then new.pinned_at := now();
    elsif not new.pinned then new.pinned_at := null; end if;

    if new.favorite and not old.favorite then new.favorite_at := now();
    elsif not new.favorite then new.favorite_at := null; end if;

    if new.done and not old.done then new.done_at := now();
    elsif not new.done then new.done_at := null; end if;

    if new.hidden and not old.hidden then new.hidden_at := now();
    elsif not new.hidden then new.hidden_at := null; end if;

    if new.opened and not old.opened then new.opened_at := now();
    elsif not new.opened then new.opened_at := null; end if;
  end if;

  -- --- Monotonic version bump --------------------------------------------
  -- Always server-assigned and derived SOLELY from the stored row, ignoring
  -- whatever `version` the client sent. (Using the client's value — even via
  -- greatest() — would let a caller pick the next version by sending a huge
  -- number, breaking conflict resolution and risking bigint overflow.) On
  -- insert start at 1; on update increment the stored value.
  if (tg_op = 'INSERT') then
    new.version := 1;
  else
    new.version := old.version + 1;
  end if;

  return new;
end;
$$;

-- BEFORE so the computed values land in the stored row.
create trigger item_state_bump_trg
  before insert or update on public.item_state
  for each row
  execute function public.item_state_bump();

comment on function public.item_state_bump() is
  'Server-assigns item_state.version (monotonic), stamps *_at timestamps, and '
  'enforces pin/done/hidden exclusivity at the write path. See SPEC.md Sync + '
  'Shields.';
