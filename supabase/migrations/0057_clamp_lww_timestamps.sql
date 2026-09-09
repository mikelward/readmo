-- set_item_state: clamp far-future client LWW timestamps.
--
-- The per-field LWW clocks (`p_<f>_at`) come from the writing device's wall
-- clock, and 0023/0024 stored them unclamped. A device with a badly wrong
-- (future) clock — or a hand-crafted PostgREST call — could stamp e.g.
-- `p_done_at = '2035-01-01'`, after which:
--   * no correctly-clocked device can change that field again until that date
--     (`p_at >= stored_at` never holds; the write is SILENTLY superseded, and
--     the client's loss-detection re-pull just re-adopts the bad clock), and
--   * the Done/Hidden/Opened TTL windows (`<f>_at > now() - interval …` in
--     feed_items / feed_unread_counts) never expire the flag.
-- 0003 explicitly documented that client timestamps must not be trusted for
-- exactly this reason; dropping its trigger in 0023 dropped the protection.
--
-- Clamp with a TOLERANCE rather than to now() exactly: the client treats "the
-- server echoed the exact `at` I sent" as write-landed and re-pulls otherwise
-- (SupabaseDataSource's LWW-loss detection), so clamping every write from a
-- device a few seconds ahead — ordinary clock skew — would turn each triage
-- action into an extra hydration read. Within the window the timestamp is
-- stored verbatim (exact echo, no re-pull); beyond it the write is treated as
-- happening "now", which still applies the value, still echoes back a changed
-- `at`, and lets the device's next re-pull adopt the sane clock. The bounded
-- residue (a field can be up to the tolerance ahead of a peer's clock) is the
-- pre-existing skew exposure, just capped.
--
-- Body otherwise VERBATIM from 0024 (incl. its p_base_version compat shim) —
-- fold this into any later signature change.

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
  p_opened_at   timestamptz default null,
  p_base_version bigint     default null  -- accepted and ignored (compat shim)
)
returns public.item_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.item_state;
  -- Latest client timestamp accepted verbatim. Generous enough that real
  -- devices (skew is typically seconds) never hit it, small enough that a
  -- runaway clock can't lock a field or pin a TTL open for years.
  v_max timestamptz := now() + interval '10 minutes';
  -- Effective per-field action times: the sent clock, defaulted to now() for
  -- an old client that sent none (0024). A clock past the tolerance is
  -- replaced with now() itself — NOT the ceiling — so the very next
  -- sane-clocked write already outranks it (clamping to the ceiling would
  -- still lock the field for the tolerance window).
  v_pinned_at   timestamptz :=
    case when coalesce(p_pinned_at,   now()) > v_max then now() else coalesce(p_pinned_at,   now()) end;
  v_favorite_at timestamptz :=
    case when coalesce(p_favorite_at, now()) > v_max then now() else coalesce(p_favorite_at, now()) end;
  v_done_at     timestamptz :=
    case when coalesce(p_done_at,     now()) > v_max then now() else coalesce(p_done_at,     now()) end;
  v_hidden_at   timestamptz :=
    case when coalesce(p_hidden_at,   now()) > v_max then now() else coalesce(p_hidden_at,   now()) end;
  v_opened_at   timestamptz :=
    case when coalesce(p_opened_at,   now()) > v_max then now() else coalesce(p_opened_at,   now()) end;
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

  -- Lock any existing row so concurrent writers serialize on its timestamps.
  perform 1 from public.item_state
   where user_id = v_uid and item_id = p_item_id
   for update;

  insert into public.item_state as st
    (user_id, item_id,
     pinned, pinned_at, favorite, favorite_at,
     done, done_at, hidden, hidden_at, opened, opened_at)
  values (
    v_uid, p_item_id,
    coalesce(p_pinned, false),   case when p_pinned   is not null then v_pinned_at   end,
    coalesce(p_favorite, false), case when p_favorite is not null then v_favorite_at end,
    coalesce(p_done, false),     case when p_done     is not null then v_done_at     end,
    coalesce(p_hidden, false),   case when p_hidden   is not null then v_hidden_at   end,
    coalesce(p_opened, false),   case when p_opened   is not null then v_opened_at   end
  )
  on conflict (user_id, item_id) do update set
    -- Per-field LWW: apply the incoming value only when supplied AND its
    -- effective action time is at least the stored field's last-change time.
    -- Record that time as the new last-change clock.
    pinned = case when p_pinned is not null
                   and (st.pinned_at is null or v_pinned_at >= st.pinned_at)
                  then p_pinned else st.pinned end,
    pinned_at = case when p_pinned is not null
                   and (st.pinned_at is null or v_pinned_at >= st.pinned_at)
                  then v_pinned_at else st.pinned_at end,
    favorite = case when p_favorite is not null
                   and (st.favorite_at is null or v_favorite_at >= st.favorite_at)
                  then p_favorite else st.favorite end,
    favorite_at = case when p_favorite is not null
                   and (st.favorite_at is null or v_favorite_at >= st.favorite_at)
                  then v_favorite_at else st.favorite_at end,
    done = case when p_done is not null
                   and (st.done_at is null or v_done_at >= st.done_at)
                  then p_done else st.done end,
    done_at = case when p_done is not null
                   and (st.done_at is null or v_done_at >= st.done_at)
                  then v_done_at else st.done_at end,
    hidden = case when p_hidden is not null
                   and (st.hidden_at is null or v_hidden_at >= st.hidden_at)
                  then p_hidden else st.hidden end,
    hidden_at = case when p_hidden is not null
                   and (st.hidden_at is null or v_hidden_at >= st.hidden_at)
                  then v_hidden_at else st.hidden_at end,
    opened = case when p_opened is not null
                   and (st.opened_at is null or v_opened_at >= st.opened_at)
                  then p_opened else st.opened end,
    opened_at = case when p_opened is not null
                   and (st.opened_at is null or v_opened_at >= st.opened_at)
                  then v_opened_at else st.opened_at end
  returning st.* into v_row;

  return v_row;
end;
$$;

comment on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz, bigint
) is
  'Client item_state write path (upsert) with per-field last-write-wins. '
  'Compat shim (0024): accepts and ignores a trailing p_base_version so a '
  'pre-0023 cached client''s write still resolves, and treats a missing '
  'p_<f>_at as now() so that write applies. Clamps far-future client clocks '
  '(0057) so a wrong device clock cannot lock a field or hold a TTL open. '
  'Gates on current item visibility. See SPEC.md Sync.';

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz, bigint
) from public;
grant execute on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz, bigint
) to authenticated;
