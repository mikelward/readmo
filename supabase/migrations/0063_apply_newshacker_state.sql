-- Reverse newshacker sync, part 2: also pull the PINNED list back.
--
-- 0062 added `apply_newshacker_dones(jsonb)` (Done pull). This adds the general
-- `apply_newshacker_state(p_dones, p_pins)` that applies BOTH newshacker's Done
-- and Pinned lists in one call, so a story pinned on newshacker is pinned in
-- Readmo too (SPEC.md "Mirror dismissals and pins to newshacker" → reverse
-- pull). The Edge Function's GET branch switches to this function; 0062's
-- `apply_newshacker_dones` is LEFT IN PLACE (additive — an older, still-deployed
-- Edge Function keeps working during a rollout).
--
-- Mapping + trust are identical to 0062: runs as the signed-in caller (RLS),
-- matches each numeric HN id to items in the caller's subscribed HACKER NEWS
-- feeds by the stored discussion URL, and delegates every write to
-- `set_item_state` so per-field last-write-wins, the far-future-clock clamp, and
-- the visibility gate all apply unchanged. So the round-trip is idempotent and a
-- stale pulled action loses to a newer local one.
--
-- Done vs Pinned, and their exclusivity. Readmo's Pinned / Done / Hidden are
-- mutually exclusive; the client always sends an exclusivity-closed diff. We do
-- the same here:
--   * Done   (not deleted): done=true,   and clears pinned+hidden at the same clock.
--   * Pinned (not deleted): pinned=true, and clears done+hidden at the same clock.
--   * A tombstone (deleted:true) clears only its own field.
-- If newshacker reports the SAME item as both pinned and done (independent lists
-- there), per-field LWW on each `at` decides which wins — newer action stands,
-- and its closure clears the other field. No global ordering needed.
--
-- Pinned is the permanent keepsake, but the pull can only attach a pin to an
-- item that still EXISTS in Readmo (a subscribed HN feed's item inside the
-- freshness window). A pin for a story that has aged out has no item to hang on
-- and is silently skipped — a documented limitation of the pull (SPEC).
--
-- Best-effort + additive: the client feature-detects; an old backend without
-- this function keeps the Done-only pull via 0062.

create or replace function public.apply_newshacker_state(
  p_dones jsonb default '[]'::jsonb,
  p_pins  jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_applied integer := 0;
  v_dones   jsonb;
  v_pins    jsonb;
  v_kind    text;
  v_entry   jsonb;
  v_id      bigint;
  v_at      timestamptz;
  v_deleted boolean;
  v_url     text;
  v_item_id uuid;
  -- Mirrors isHackerNewsFeed (src/lib/newshacker.ts); see 0062 for the rationale.
  v_hn_re constant text :=
    '^https?://(www\.)?(news\.ycombinator\.com|hnrss\.org)([/:?#]|$)';
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Non-array inputs (null / object / scalar) degrade to an empty list rather
  -- than erroring the whole call.
  v_dones := case when jsonb_typeof(p_dones) = 'array' then p_dones else '[]'::jsonb end;
  v_pins  := case when jsonb_typeof(p_pins)  = 'array' then p_pins  else '[]'::jsonb end;

  for v_kind, v_entry in
    select 'done', value from jsonb_array_elements(v_dones)
    union all
    select 'pin',  value from jsonb_array_elements(v_pins)
  loop
    if jsonb_typeof(v_entry) <> 'object' then
      continue;
    end if;

    -- id: a positive integer HN item id. Skip anything malformed.
    begin
      v_id := (v_entry ->> 'id')::bigint;
    exception when others then
      continue;
    end;
    if v_id is null or v_id <= 0 then
      continue;
    end if;

    -- at: newshacker's action clock is Date.now() milliseconds since epoch.
    begin
      v_at := to_timestamp((v_entry ->> 'at')::double precision / 1000.0);
    exception when others then
      continue;
    end;
    if v_at is null then
      continue;
    end if;

    v_deleted := (v_entry ->> 'deleted') = 'true';
    v_url := 'https://news.ycombinator.com/item?id=' || v_id::text;

    -- Items in the caller's subscribed Hacker News feeds matching this id.
    for v_item_id in
      select i.id
      from public.items i
      join public.subscriptions s on s.feed_id = i.feed_id
      join public.feeds f on f.id = i.feed_id
      where s.user_id = v_uid
        and (f.url ~* v_hn_re or f.site_url ~* v_hn_re)
        and (i.comments_url = v_url or i.guid = v_url or i.url = v_url)
    loop
      if v_kind = 'done' then
        if v_deleted then
          perform public.set_item_state(
            p_item_id => v_item_id,
            p_done    => false, p_done_at => v_at);
        else
          perform public.set_item_state(
            p_item_id  => v_item_id,
            p_done     => true,  p_done_at   => v_at,
            p_pinned   => false, p_pinned_at => v_at,
            p_hidden   => false, p_hidden_at => v_at);
        end if;
      else  -- 'pin'
        if v_deleted then
          perform public.set_item_state(
            p_item_id   => v_item_id,
            p_pinned    => false, p_pinned_at => v_at);
        else
          perform public.set_item_state(
            p_item_id  => v_item_id,
            p_pinned   => true,  p_pinned_at => v_at,
            p_done     => false, p_done_at   => v_at,
            p_hidden   => false, p_hidden_at => v_at);
        end if;
      end if;
      v_applied := v_applied + 1;
    end loop;
  end loop;

  return v_applied;
end;
$$;

comment on function public.apply_newshacker_state(jsonb, jsonb) is
  'Reverse newshacker sync: apply batches of newshacker Done AND Pinned entries '
  '({id,at,deleted?}, id = numeric HN item id) onto the caller''s item_state. '
  'Matches items in the caller''s subscribed Hacker News feeds by HN discussion '
  'URL and delegates each write to set_item_state (per-field LWW, exclusivity-'
  'closed). Returns the number of item_state writes issued. Supersedes '
  'apply_newshacker_dones (0062), which is kept for rollout compatibility. See '
  'SPEC.md "Mirror dismissals and pins to newshacker" (reverse pull).';

-- Runs as the signed-in user (the Edge Function calls it with the caller's JWT).
revoke execute on function public.apply_newshacker_state(jsonb, jsonb) from public;
grant  execute on function public.apply_newshacker_state(jsonb, jsonb) to authenticated;
