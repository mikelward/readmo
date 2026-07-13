-- Reverse newshacker sync, part 3: make the pull apply set-based and
-- write-on-new-information-only, so it's fast and quiet.
--
-- 0063's `apply_newshacker_state` looped over every pulled entry (the Edge
-- Function sends up to 1000 Done + 1000 Pinned per pull) and, PER ENTRY, ran a
-- three-table join (items x subscriptions x feeds, regex on the feed URL,
-- OR-match across three unindexed item URL columns), then issued a
-- `set_item_state` write for EVERY match on EVERY pull — even when the entry
-- changed nothing. At real list sizes that is thousands of scans and hundreds
-- of no-op writes per pull, running as the `authenticated` role under
-- Supabase's default 8s statement_timeout: the call could blow the timeout and
-- fail outright (the Edge GET then reports applied=0 and nothing syncs), and
-- when it did finish, `applied` counted every re-applied no-op, so the client
-- kicked a full item_state re-hydrate after every tab focus.
--
-- Same signature, same trust model (runs as the signed-in caller; every write
-- still delegated to `set_item_state` so per-field LWW, the far-future-clock
-- clamp, and the visibility gate apply unchanged). Three structural changes:
--
--   1. SET-BASED MATCHING. Parse both lists once, unpivot the caller's
--      subscribed-HN-feed items' three URL columns, and match entries to items
--      with a single hash join — one pass over the caller's HN items instead
--      of one join per entry.
--
--   2. NEW-INFORMATION-ONLY WRITES. An entry only reaches `set_item_state`
--      when the write it would issue changes the stored row. The check runs
--      per field of the entry's WRITE SET (a tombstone writes only its own
--      field; a non-deleted entry also writes the exclusivity clears): the
--      field's clock is unset or older than the entry's (even if the value
--      matches — recording the newer action clock is what lets LWW reject a
--      stale offline write timestamped between the two clocks, exactly as
--      0063's unconditional re-apply did), or the clocks tie and the value
--      differs (set_item_state's >= rule lets the pulled value win the tie,
--      as it always has). Once applied, every touched field's clock is >= the
--      entry's, so the same entry never writes again: a steady-state pull
--      issues ZERO writes and returns 0, the client skips the post-pull
--      re-hydrate, and a return from an open-on-newshacker handoff applies
--      exactly the opened article's change. `applied`'s meaning tightens from
--      "writes issued" to "writes carrying new information".
--
-- Deliberate behavior deltas from 0063, all safe:
--   * An entry whose whole write set is outranked or already reflected is
--     filtered out instead of issuing a write set_item_state fully rejects —
--     so it no longer counts toward `applied` (0063 counted it forever,
--     re-triggering a client resync on every pull).
--   * `id` / `at` must be JSON numbers. 0063 also accepted numeric strings via
--     the cast-and-catch loop, but the Edge Function has only ever forwarded
--     numbers (normalizeList / extractDoneEntries require typeof number), so
--     no caller loses anything; malformed entries are dropped by predicate
--     instead of per-row exception handlers.
--
-- Additive: same name and argument list (create or replace), so the deployed
-- Edge Function picks it up with no redeploy, and 0062's Done-only fallback
-- stays untouched.

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
  r record;
  -- Mirrors isHackerNewsFeed (src/lib/newshacker.ts); see 0062 for the rationale.
  v_hn_re constant text :=
    '^https?://(www\.)?(news\.ycombinator\.com|hnrss\.org)([/:?#]|$)';
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  for r in
    -- MATERIALIZED pins evaluation order: the CASE-guarded casts below must
    -- run against the WHERE-filtered rows only, never be pushed around by the
    -- planner (a bare cast on a non-numeric `id` would abort the whole call).
    with entries as materialized (
      -- Both lists as rows. Malformed entries (non-object, id/at not JSON
      -- numbers, non-integral or out-of-range id, `at` past the timestamptz-
      -- safe ceiling ~year 5000) are dropped here, replacing 0063's per-entry
      -- exception blocks. Non-array inputs degrade to empty lists.
      --
      -- Far-future clocks (`at` beyond set_item_state's 10-minute tolerance,
      -- 0057) are DROPPED rather than clamped: a clamped write stores now(),
      -- and since now() keeps advancing, the same raw-future entry would
      -- outrank the stored clock again on every subsequent pull — writing and
      -- returning applied>0 forever, the exact noisy steady state this
      -- migration removes. The entry syncs once real time reaches its clock;
      -- local/forward writes still clamp-and-apply as before.
      select raw.kind,
             'https://news.ycombinator.com/item?id=' ||
               ((raw.e ->> 'id')::bigint)::text                      as url,
             to_timestamp((raw.e ->> 'at')::double precision / 1000.0) as at,
             -- coalesce: a missing key must yield FALSE, not NULL — a NULL
             -- would poison the change-only gate below (`not NULL` is NULL,
             -- and `x is distinct from NULL` is true for any non-null x).
             coalesce(raw.e ->> 'deleted', '') = 'true'              as deleted
      from (
        select 'done'::text as kind, value as e
        from jsonb_array_elements(
          case when jsonb_typeof(p_dones) = 'array' then p_dones else '[]'::jsonb end)
        union all
        select 'pin', value
        from jsonb_array_elements(
          case when jsonb_typeof(p_pins) = 'array' then p_pins else '[]'::jsonb end)
      ) raw
      where jsonb_typeof(raw.e) = 'object'
        and case when jsonb_typeof(raw.e -> 'id') = 'number'
              then (raw.e ->> 'id')::numeric between 1 and 9007199254740991
                   and (raw.e ->> 'id')::numeric = floor((raw.e ->> 'id')::numeric)
              else false end
        and case when jsonb_typeof(raw.e -> 'at') = 'number'
              -- Nested CASEs pin evaluation order: range-check the numeric
              -- before to_timestamp (a huge value would error), and only then
              -- apply the far-future cutoff.
              then case when (raw.e ->> 'at')::numeric between 0 and 100000000000000
                     then to_timestamp((raw.e ->> 'at')::double precision / 1000.0)
                          <= now() + interval '10 minutes'
                     else false end
              else false end
    ),
    -- Every stored HN-discussion-URL column of every item in the caller's
    -- subscribed Hacker News feeds, unpivoted so the entry match is one hash
    -- join instead of an OR-of-three-columns probe per entry. The HN-feed gate
    -- keeps a non-HN item that merely links to an HN thread from matching
    -- (symmetric with the forward mirror; see 0062).
    candidate_urls as (
      select i.id as item_id, u.url
      from public.items i
      join public.subscriptions s on s.feed_id = i.feed_id
      join public.feeds f on f.id = i.feed_id
      cross join lateral (values (i.comments_url), (i.guid), (i.url)) as u(url)
      where s.user_id = v_uid
        and (f.url ~* v_hn_re or f.site_url ~* v_hn_re)
        and u.url is not null
    ),
    matched as (
      select distinct e.kind, e.at, e.deleted, c.item_id
      from entries e
      join candidate_urls c on c.url = e.url
    )
    select m.kind, m.at, m.deleted, m.item_id
    from matched m
    left join public.item_state st
      on st.user_id = v_uid and st.item_id = m.item_id
    -- New-information gate: keep the entry only when the write it would issue
    -- changes the stored row. Per FIELD in the entry's write set, that means:
    -- no stored clock yet, a strictly newer clock (even with the same value —
    -- recording the newer action clock is what shields the field from a stale
    -- offline write timestamped between the clocks), or a tied clock with a
    -- differing value (set_item_state's >= rule lets the pulled value win the
    -- tie). A tombstone writes only its own field; a non-deleted entry ALSO
    -- writes the exclusivity clears (pinned/done/hidden), so it must be
    -- admitted when any of those would land — an entry stale for its own
    -- field can still carry a winning cross-field clear (e.g. a Done whose
    -- closure unpins an older pin even though a newer un-done outranks the
    -- Done itself). After one write every touched field's clock is >= the
    -- entry's, so the same entry never re-admits: pulls stay idempotent.
    where case when m.deleted then
            case when m.kind = 'done'
              then st.done_at is null or m.at > st.done_at
                   or (m.at = st.done_at and coalesce(st.done, false))
              else st.pinned_at is null or m.at > st.pinned_at
                   or (m.at = st.pinned_at and coalesce(st.pinned, false))
            end
          else
            (st.done_at is null or m.at > st.done_at
             or (m.at = st.done_at
                 and coalesce(st.done, false) is distinct from (m.kind = 'done')))
            or (st.pinned_at is null or m.at > st.pinned_at
                or (m.at = st.pinned_at
                    and coalesce(st.pinned, false) is distinct from (m.kind = 'pin')))
            or (st.hidden_at is null or m.at > st.hidden_at
                or (m.at = st.hidden_at and coalesce(st.hidden, false)))
          end
      -- Same-item, same-clock Done+Pin conflict (newshacker's lists are
      -- independent and millisecond clocks can tie): the pin wins and the Done
      -- entry is dropped outright. Without this, each side's exclusivity
      -- closure re-arms the other's tied-clock branch above, and the item
      -- would flip Done<->Pinned on alternating pulls forever. Pin-beats-Done
      -- matches 0063's effective outcome (its loop applied pins after dones)
      -- and keeps the permanent keepsake over the dismissal.
      and not (m.kind = 'done' and not m.deleted and exists (
            select 1 from matched p
            where p.item_id = m.item_id
              and p.kind = 'pin' and not p.deleted and p.at = m.at))
    -- Oldest action first, so when the same item survives in both lists the
    -- newest write lands last (either order converges under per-field LWW,
    -- but this keeps the write sequence deterministic).
    order by m.at
  loop
    -- Same writes as 0063: a non-tombstone closes over the exclusive fields at
    -- the same clock; a tombstone clears only its own field.
    if r.kind = 'done' then
      if r.deleted then
        perform public.set_item_state(
          p_item_id => r.item_id,
          p_done    => false, p_done_at => r.at);
      else
        perform public.set_item_state(
          p_item_id  => r.item_id,
          p_done     => true,  p_done_at   => r.at,
          p_pinned   => false, p_pinned_at => r.at,
          p_hidden   => false, p_hidden_at => r.at);
      end if;
    else  -- 'pin'
      if r.deleted then
        perform public.set_item_state(
          p_item_id   => r.item_id,
          p_pinned    => false, p_pinned_at => r.at);
      else
        perform public.set_item_state(
          p_item_id  => r.item_id,
          p_pinned   => true,  p_pinned_at => r.at,
          p_done     => false, p_done_at   => r.at,
          p_hidden   => false, p_hidden_at => r.at);
      end if;
    end if;
    v_applied := v_applied + 1;
  end loop;

  return v_applied;
end;
$$;

comment on function public.apply_newshacker_state(jsonb, jsonb) is
  'Reverse newshacker sync: apply batches of newshacker Done AND Pinned entries '
  '({id,at,deleted?}, id = numeric HN item id) onto the caller''s item_state. '
  'Set-based (0065): matches all entries to the caller''s subscribed-HN-feed '
  'items in one join and writes ONLY entries carrying new information (a newer '
  'field clock, or a tied clock with a differing value), delegating each write '
  'to set_item_state. Returns the number of such writes (0 for an already-'
  'in-sync pull). See SPEC.md "Mirror dismissals and pins to newshacker" '
  '(reverse pull).';

-- Runs as the signed-in user (the Edge Function calls it with the caller's JWT).
revoke execute on function public.apply_newshacker_state(jsonb, jsonb) from public;
grant  execute on function public.apply_newshacker_state(jsonb, jsonb) to authenticated;
