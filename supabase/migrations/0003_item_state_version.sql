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
begin
  -- --- State exclusivity (write-path enforcement) -------------------------
  -- Pin wins over Done/Hidden.
  if new.pinned then
    new.done   := false;
    new.hidden := false;
  end if;
  -- Hiding clears Pin (re-check after the block above so an explicit hide in
  -- the same write still drops the pin).
  if new.hidden then
    new.pinned := false;
  end if;
  -- Done clears Pin (Done is where pinned items go when they leave the queue).
  if new.done then
    new.pinned := false;
  end if;

  -- --- Timestamp stamping -------------------------------------------------
  -- On INSERT, OLD is NULL: stamp any flag that is being set true.
  if (tg_op = 'INSERT') then
    if new.pinned   then new.pinned_at   := coalesce(new.pinned_at, now());   end if;
    if new.favorite then new.favorite_at := coalesce(new.favorite_at, now()); end if;
    if new.done     then new.done_at     := coalesce(new.done_at, now());     end if;
    if new.hidden   then new.hidden_at   := coalesce(new.hidden_at, now());   end if;
    if new.opened   then new.opened_at   := coalesce(new.opened_at, now());   end if;
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
  -- Always server-assigned. On insert start at 1; on update take the greater
  -- of (old.version + 1) and (new.version) so the value never regresses even
  -- if a client echoes a stale version.
  if (tg_op = 'INSERT') then
    new.version := 1;
  else
    new.version := greatest(old.version, new.version) + 1;
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
