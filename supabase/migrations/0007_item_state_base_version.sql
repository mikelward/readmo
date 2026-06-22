-- Readmo item_state optimistic concurrency — reject stale outbox writes.
--
-- Background (SPEC.md *Sync → Conflict resolution*): item_state carries a
-- server-assigned monotonic `version` (bumped by the 0003 trigger). The offline
-- outbox can replay a write made hours ago; without a check it would upsert
-- blindly and clobber a newer change another device made in the meantime.
--
-- Fix: set_item_state takes the caller's last-seen `version` as `p_base_version`
-- and applies the write only if the row hasn't moved on since; otherwise it
-- raises a serialization-failure (errcode 40001) so the client treats it as a
-- non-transient rejection — it drops the queued entry and re-reconciles from
-- server truth (the "winning value"), per the SPEC rule.
--
-- Semantics of p_base_version:
--   * NULL  → no check (legacy/unknown base): plain upsert, as before.
--   * 0     → caller expects NO existing row (a first-ever write for the item).
--   * N > 0 → caller expects the row to currently be at version N.
-- A mismatch (row at a different version, or gone, or unexpectedly present) is a
-- conflict. The per-write version is row-level, so two devices editing the SAME
-- item conflict even on independent flags; that's deliberately conservative
-- (the loser re-reconciles and may re-apply) rather than risk a silent clobber.
--
-- We replace the 5-flag function with a 6th trailing param. Adding a defaulted
-- param yields a NEW overload rather than replacing in place, so DROP the old
-- signature first (keeping a single canonical entry point), then recreate.

drop function if exists public.set_item_state(
  uuid, boolean, boolean, boolean, boolean, boolean
);

create or replace function public.set_item_state(
  p_item_id      uuid,
  p_pinned       boolean default null,
  p_favorite     boolean default null,
  p_done         boolean default null,
  p_hidden       boolean default null,
  p_opened       boolean default null,
  p_base_version bigint  default null
)
returns public.item_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.item_state;
  v_cur bigint;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Visibility gate — mirrors items_select in 0002_rls.sql exactly.
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

  -- Optimistic concurrency: apply only if the row is still at the version the
  -- caller's queued change was based on. coalesce(no row) → 0, so a base of 0
  -- means "expected fresh". A mismatch is a non-transient conflict. The check
  -- must be atomic with the write, or two concurrent writers both read the same
  -- version, both pass, and the second silently clobbers the first:
  --   1. SELECT ... FOR UPDATE locks an EXISTING row, serializing same-row
  --      updaters — the second waits, then sees the bumped version and conflicts.
  --   2. For a base-0 FIRST insert there is no row to lock above, so the loser
  --      of the INSERT race is caught by re-asserting the base in the ON CONFLICT
  --      DO UPDATE's WHERE (evaluated under the lock ON CONFLICT takes): a
  --      version mismatch updates no row, and the `not found` below rejects it.
  if p_base_version is not null then
    select version into v_cur
    from public.item_state
    where user_id = v_uid and item_id = p_item_id
    for update;

    if coalesce(v_cur, 0) <> p_base_version then
      raise exception
        'item_state % changed since version % (server at %)',
        p_item_id, p_base_version, coalesce(v_cur, 0)
        using errcode = '40001';
    end if;
  end if;

  insert into public.item_state as st
    (user_id, item_id, pinned, favorite, done, hidden, opened)
  values (
    v_uid, p_item_id,
    coalesce(p_pinned,   false),
    coalesce(p_favorite, false),
    coalesce(p_done,     false),
    coalesce(p_hidden,   false),
    coalesce(p_opened,   false)
  )
  on conflict (user_id, item_id) do update set
    pinned   = coalesce(p_pinned,   st.pinned),
    favorite = coalesce(p_favorite, st.favorite),
    done     = coalesce(p_done,     st.done),
    hidden   = coalesce(p_hidden,   st.hidden),
    opened   = coalesce(p_opened,   st.opened)
  -- NULL base → no check (version = version, always true).
  where st.version = coalesce(p_base_version, st.version)
  returning st.* into v_row;

  if not found then
    -- A concurrent writer won the row between our check and the upsert (the
    -- base-0 first-insert race); reject so the loser reconciles.
    raise exception
      'item_state % changed concurrently (base %)', p_item_id, p_base_version
      using errcode = '40001';
  end if;

  return v_row;
end;
$$;

comment on function public.set_item_state(
  uuid, boolean, boolean, boolean, boolean, boolean, bigint
) is
  'Client item_state write path (upsert) with optimistic concurrency. Gates on '
  'current item visibility, then applies the write only if p_base_version '
  'matches the row''s current server version (NULL = skip check, 0 = expect no '
  'row), else raises 40001 so a stale offline replay reconciles instead of '
  'clobbering newer server truth. See SPEC.md Sync.';

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.set_item_state(
  uuid, boolean, boolean, boolean, boolean, boolean, bigint
) from public;
grant  execute on function public.set_item_state(
  uuid, boolean, boolean, boolean, boolean, boolean, bigint
) to authenticated;
