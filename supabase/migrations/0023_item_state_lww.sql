-- Readmo item_state sync: replace server-version optimistic concurrency with
-- per-field LAST-WRITE-WINS.
--
-- Background. 0003 added a monotonic `version` column + bump trigger, and 0007
-- made `set_item_state` reject a write whose `p_base_version` no longer matched
-- (errcode 40001) so a stale offline replay reconciled instead of clobbering.
-- That bought conflict-safety at the cost of a large client apparatus (base
-- tracking, a hold-for-hydration window, conflict reconcile/rollback) — far more
-- machinery than per-item boolean flags need.
--
-- New model (SPEC.md *Sync → Conflict resolution*). Each field carries the
-- wall-clock time of the action that set it (`p_<f>_at`). On write we keep, per
-- field, whichever value has the newer timestamp. So:
--   * two devices touching INDEPENDENT fields never conflict, and
--   * a stale write (an hour-old offline replay) loses to a newer change instead
--     of being rejected — the loser is simply superseded, no 40001, no reconcile.
-- `<f>_at` becomes each field's last-change clock (stored even when the field is
-- false, so a later stale write still loses); it is only ever *read* while the
-- flag is true, so library ordering and the TTLs are unaffected.
--
-- Pin/done/hidden exclusivity is NOT re-derived server-side: the client always
-- sends an exclusivity-closed diff (a Pin write carries Done=false + Hidden=false,
-- a Done/Hide write carries Pinned=false, all stamped with the same `at`). The
-- closure is UNCONDITIONAL — the client emits the cleared fields even when its
-- local mirror already shows them false (it may be stale: another device set the
-- field server-side and this tab hasn't hydrated it). So the server's pinned/
-- done/hidden fields each always carry the latest set-or-clear, and per-field LWW
-- lands on a consistent state without server-side re-derivation. (See
-- ItemStateStore.emitDiff.) The visibility gate (the security boundary) is
-- preserved verbatim.
--
-- No backwards compatibility: this drops the `version` column, the bump trigger,
-- and the base-version RPC overload outright (two-user app, coordinated cutover —
-- deploy this migration, then ship the client). Old persisted client state is
-- discarded via a CACHE_BUSTER bump on the client side.

-- --- Drop the version machinery --------------------------------------------
drop trigger if exists item_state_bump_trg on public.item_state;
drop function if exists public.item_state_bump();

-- The 0007/0019 overload carries the trailing bigint base param; drop it so the
-- new signature is the single canonical entry point.
drop function if exists public.set_item_state(
  uuid, boolean, boolean, boolean, boolean, boolean, bigint
);

alter table public.item_state drop column if exists version;

-- --- Per-field last-write-wins write path -----------------------------------
create or replace function public.set_item_state(
  p_item_id     uuid,
  p_pinned      boolean     default null,
  p_pinned_at   timestamptz default null,
  p_favorite    boolean     default null,
  p_favorite_at timestamptz default null,
  p_done        boolean     default null,
  p_done_at     timestamptz default null,
  p_hidden      boolean     default null,
  p_hidden_at   timestamptz default null,
  p_opened      boolean     default null,
  p_opened_at   timestamptz default null
)
returns public.item_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.item_state;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Visibility gate — mirrors items_select in 0002_rls.sql exactly. A
  -- hidden/opened-only row grants no visibility, so it can't bootstrap a write
  -- on an item the caller never had access to.
  if not exists (
    select 1
    from public.subscriptions s
    join public.items i on i.feed_id = s.feed_id
    where i.id = p_item_id and s.user_id = v_uid
  ) and not exists (
    select 1 from public.item_state st
    where st.item_id = p_item_id and st.user_id = v_uid
      and (st.pinned or st.favorite or st.done)
  ) then
    raise exception 'item % not visible to caller', p_item_id
      using errcode = '42501';
  end if;

  -- Lock any existing row so two concurrent writers serialize and each sees the
  -- other's committed timestamps (the second then wins/loses per field on `at`).
  perform 1 from public.item_state
   where user_id = v_uid and item_id = p_item_id
   for update;

  insert into public.item_state as st
    (user_id, item_id,
     pinned, pinned_at, favorite, favorite_at,
     done, done_at, hidden, hidden_at, opened, opened_at)
  values (
    v_uid, p_item_id,
    coalesce(p_pinned, false),   case when p_pinned   is not null then p_pinned_at   end,
    coalesce(p_favorite, false), case when p_favorite is not null then p_favorite_at end,
    coalesce(p_done, false),     case when p_done     is not null then p_done_at     end,
    coalesce(p_hidden, false),   case when p_hidden   is not null then p_hidden_at   end,
    coalesce(p_opened, false),   case when p_opened   is not null then p_opened_at   end
  )
  on conflict (user_id, item_id) do update set
    -- For each field: apply the incoming value only when it is supplied AND its
    -- action time is at least the stored field's last-change time (a null stored
    -- time means the field was never written, so the incoming write wins). Record
    -- that action time as the field's new last-change clock.
    pinned = case when p_pinned is not null
                   and (st.pinned_at is null or p_pinned_at >= st.pinned_at)
                  then p_pinned else st.pinned end,
    pinned_at = case when p_pinned is not null
                   and (st.pinned_at is null or p_pinned_at >= st.pinned_at)
                  then p_pinned_at else st.pinned_at end,
    favorite = case when p_favorite is not null
                   and (st.favorite_at is null or p_favorite_at >= st.favorite_at)
                  then p_favorite else st.favorite end,
    favorite_at = case when p_favorite is not null
                   and (st.favorite_at is null or p_favorite_at >= st.favorite_at)
                  then p_favorite_at else st.favorite_at end,
    done = case when p_done is not null
                   and (st.done_at is null or p_done_at >= st.done_at)
                  then p_done else st.done end,
    done_at = case when p_done is not null
                   and (st.done_at is null or p_done_at >= st.done_at)
                  then p_done_at else st.done_at end,
    hidden = case when p_hidden is not null
                   and (st.hidden_at is null or p_hidden_at >= st.hidden_at)
                  then p_hidden else st.hidden end,
    hidden_at = case when p_hidden is not null
                   and (st.hidden_at is null or p_hidden_at >= st.hidden_at)
                  then p_hidden_at else st.hidden_at end,
    opened = case when p_opened is not null
                   and (st.opened_at is null or p_opened_at >= st.opened_at)
                  then p_opened else st.opened end,
    opened_at = case when p_opened is not null
                   and (st.opened_at is null or p_opened_at >= st.opened_at)
                  then p_opened_at else st.opened_at end
  returning st.* into v_row;

  return v_row;
end;
$$;

comment on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz
) is
  'Client item_state write path (upsert) with per-field last-write-wins. Gates '
  'on current item visibility, then applies each supplied field only if its '
  'action time (p_<f>_at) is at least the stored field''s last-change time, so a '
  'stale offline replay is superseded rather than rejected. The client sends '
  'exclusivity-closed diffs, so pin/done/hidden stay consistent without '
  'server-side re-derivation. See SPEC.md Sync.';

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz
) from public;
grant execute on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz
) to authenticated;
