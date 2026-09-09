-- Reverse newshacker sync (pull): apply a linked newshacker account's own Done
-- list back onto Readmo item_state. Companion to the forward mirror (0050 +
-- the `newshacker-sync` Edge Function, which pushes Readmo → newshacker); this
-- is the pull half the SPEC left as a stretch goal ("Mirror dismissals and
-- pins to newshacker" → reverse pull).
--
-- The Edge Function's GET branch fetches newshacker's `done` list (a batch of
-- `{ id, at, deleted? }` where `id` is the numeric HN item id) and hands it to
-- this RPC AS THE SIGNED-IN USER (the caller's JWT, so `auth.uid()` is the
-- account), never the service role — the write must stay inside that user's
-- RLS boundary.
--
-- Mapping. Readmo doesn't store the HN item id as a column; it lives in the HN
-- discussion URL the parser already persists (`comments_url`, and for some
-- feeds the `guid`/`url`). newshacker's id N canonicalizes to
-- `https://news.ycombinator.com/item?id=N`, the exact string the parser writes
-- (see _shared/parser + newshacker.ts `hackerNewsItemId`), so we match on that.
-- We only look at items in feeds THIS user subscribes to, so a Done can never
-- reach an item the caller couldn't already see — AND only in feeds that are
-- actually Hacker News (host = news.ycombinator.com / hnrss.org), mirroring the
-- forward mirror's `isHackerNewsFeed` gate. Without that a non-HN post that
-- merely links to an HN thread in its `comments_url`/`url` would be conflated
-- with that story and wrongly marked Done. Items whose HN id lives only
-- in the body HTML (the official HN feed's older rows predating comments_url)
-- won't match — acceptable: Readmo's freshness window drops old items anyway,
-- and the forward push keeps the common path in step.
--
-- Writes go through `set_item_state` (0060) unchanged, so the pulled Done gets
-- the SAME per-field last-write-wins + far-future-clock clamp + visibility gate
-- as a local dismissal — a stale pulled Done loses to a newer local change, and
-- the round-trip is idempotent (re-pulling the same Done re-applies the same
-- value at the same clock, a no-op). A Done sets `done=true` and, per the
-- exclusivity closure the client always sends, clears `pinned`/`hidden` at the
-- same clock (LWW-gated, so a more recent local pin survives). A tombstone
-- (`deleted:true`, an un-done on newshacker) clears `done` only.
--
-- Best-effort and additive: the client feature-detects a backend without this
-- RPC and no-ops, so shipping the client before this migration is deployed is
-- safe (guardrail #11).

create or replace function public.apply_newshacker_dones(p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_applied integer := 0;
  v_entry   jsonb;
  v_id      bigint;
  v_at      timestamptz;
  v_deleted boolean;
  v_url     text;
  v_item_id uuid;
  -- Mirrors isHackerNewsFeed (src/lib/newshacker.ts): a feed is Hacker News when
  -- its feed url OR site url host is news.ycombinator.com / hnrss.org (optionally
  -- www.). The trailing boundary rejects look-alikes (news.ycombinator.com.evil).
  v_hn_re constant text :=
    '^https?://(www\.)?(news\.ycombinator\.com|hnrss\.org)([/:?#]|$)';
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    return 0;
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
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
    -- set_item_state clamps a far-future value, so no clamp is needed here.
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

    -- Every item in one of the caller's subscribed HACKER NEWS feeds whose
    -- stored HN discussion link matches this id. A given HN id typically maps to
    -- one item, but a user could subscribe to two HN feeds carrying the same
    -- story. The `is HN feed` gate keeps a non-HN feed's item that merely links
    -- to the same HN thread from being swept Done (symmetric with the push).
    for v_item_id in
      select i.id
      from public.items i
      join public.subscriptions s on s.feed_id = i.feed_id
      join public.feeds f on f.id = i.feed_id
      where s.user_id = v_uid
        and (f.url ~* v_hn_re or f.site_url ~* v_hn_re)
        and (i.comments_url = v_url or i.guid = v_url or i.url = v_url)
    loop
      if v_deleted then
        perform public.set_item_state(
          p_item_id => v_item_id,
          p_done    => false,
          p_done_at => v_at);
      else
        perform public.set_item_state(
          p_item_id  => v_item_id,
          p_done     => true,  p_done_at   => v_at,
          p_pinned   => false, p_pinned_at => v_at,
          p_hidden   => false, p_hidden_at => v_at);
      end if;
      v_applied := v_applied + 1;
    end loop;
  end loop;

  return v_applied;
end;
$$;

comment on function public.apply_newshacker_dones(jsonb) is
  'Reverse newshacker sync: map a batch of newshacker Done entries '
  '({id,at,deleted?}, id = numeric HN item id) onto the caller''s item_state. '
  'Matches items in the caller''s subscribed feeds by HN discussion URL and '
  'delegates each write to set_item_state (per-field LWW). Returns the number '
  'of item_state writes issued. See SPEC.md "Mirror dismissals and pins to '
  'newshacker" (reverse pull).';

-- Runs as the signed-in user (the Edge Function calls it with the caller's JWT
-- so auth.uid() is the account). Definer functions default to EXECUTE for
-- PUBLIC; restrict to signed-in users.
revoke execute on function public.apply_newshacker_dones(jsonb) from public;
grant  execute on function public.apply_newshacker_dones(jsonb) to authenticated;
