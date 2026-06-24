-- Readmo items dedup — collapse same-feed (feed_id, url) dupes and enforce.
--
-- Storage today dedups items only on (feed_id, guid) (0001). Publishers like
-- the BBC sometimes re-publish the SAME article URL under a new GUID — the
-- poller can't see it's the same story, so it inserts a second row and the
-- user sees two identical-looking entries in the same feed. The React list key
-- is items.id, so this isn't a render glitch: there really are two rows.
--
-- Cleanup + future-proof, in three steps:
--
--   1. Collapse existing same-feed dupes by URL. For each (feed_id, url) group
--      with >1 row, keep the newest (highest created_at, tied by id — the
--      publisher's most recent version). Merge any item_state from the dupes
--      into the survivor (OR the booleans, take the newer *_at). The items→
--      item_state FK ON DELETE CASCADE drops the now-orphaned dupe state.
--   2. Add `unique (feed_id, url) where url is not null` so the situation
--      can't recur. Partial — items with no parseable URL still dedup via
--      (feed_id, guid).
--   3. Add `upsert_feed_items` so the poller can upsert atomically across
--      BOTH unique constraints: ON CONFLICT can only target one index, so the
--      RPC catches the (feed_id, url) unique_violation and folds the new
--      guid + content into the existing row instead of failing the batch.
--
-- Cross-feed dupes (the same article URL appearing in two SEPARATE feed
-- subscriptions, e.g. BBC News + BBC Top Stories) are a different problem —
-- those live as separate items rows by design, one per feed — and are tracked
-- in TODO.md "Cross-feed item dedup".

-- ---------------------------------------------------------------------------
-- 1) Cleanup. The 0003 trigger force-stamps *_at = now() on insert and bumps
--    version, so the merged item_state row's pinned_at / hidden_at land at
--    migration time rather than the original action time. Acceptable one-off:
--    these are dupes a small number of users have triaged on the wrong row,
--    and the next pin/hide write re-stamps cleanly. Disabling the trigger
--    here would defeat the timestamp/version contract the rest of the schema
--    depends on, so we accept the skew.
-- ---------------------------------------------------------------------------

do $$
declare
  rec record;
begin
  for rec in
    select
      feed_id,
      url,
      -- Survivor = newest by created_at; id tiebreak keeps the loop idempotent.
      (array_agg(id order by created_at desc, id desc))[1] as keep_id,
      (array_agg(id order by created_at desc, id desc))[2:] as dupe_ids
    from public.items
    where url is not null
    group by feed_id, url
    having count(*) > 1
  loop
    -- Fold every dupe's per-user state into the survivor. Group by user_id so
    -- a user who acted on multiple dupes collapses into one survivor row.
    --
    -- 0003's item_state_bump evaluates pin_on/hide_on/done_on BEFORE applying
    -- exclusivity, so a row written with both pinned=true and hidden=true (or
    -- both pinned=true and done=true) has pin_on, hide_on, AND done_on all
    -- true at once — pin_on clears done/hidden, then hide_on/done_on clear
    -- pin, and the row lands with EVERY triage flag false. Resolve the pin >
    -- {done, hidden} precedence in this query (mirrors the trigger's pin-
    -- clears-done/hidden rule for the normal one-flag-flip path) so the
    -- trigger only ever sees at most one of {pinned, done, hidden} true and
    -- can't silently strip what the user actually triaged.
    insert into public.item_state (
      user_id, item_id,
      pinned, favorite, done, hidden, opened
    )
    select
      user_id, rec.keep_id,
      bool_or(pinned),
      bool_or(favorite),
      bool_or(done)   and not bool_or(pinned),
      bool_or(hidden) and not bool_or(pinned),
      bool_or(opened)
    from public.item_state
    where item_id = any(rec.dupe_ids)
    group by user_id
    on conflict (user_id, item_id) do update set
      pinned   = item_state.pinned   or excluded.pinned,
      favorite = item_state.favorite or excluded.favorite,
      -- done/hidden are cleared if pin wins after the merge, again so the
      -- BEFORE-trigger can't catch multiple *_on transitions in one write.
      done     = (item_state.done   or excluded.done)
                   and not (item_state.pinned or excluded.pinned),
      hidden   = (item_state.hidden or excluded.hidden)
                   and not (item_state.pinned or excluded.pinned),
      opened   = item_state.opened   or excluded.opened;

    -- ON DELETE CASCADE (0001) drops the dupes' item_state rows for us.
    delete from public.items where id = any(rec.dupe_ids);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Future-proof.
-- ---------------------------------------------------------------------------

create unique index if not exists items_feed_url_unique_idx
  on public.items (feed_id, url)
  where url is not null;

comment on index public.items_feed_url_unique_idx is
  'Prevents the poller from inserting a duplicate (feed_id, url) item when a '
  'publisher re-issues the same article under a new GUID. The upsert_feed_items '
  'RPC catches the conflict and updates the existing row in place.';

-- ---------------------------------------------------------------------------
-- 3) Atomic upsert across both unique constraints.
--
-- Why an RPC: Postgres ON CONFLICT can target only ONE index per statement.
-- We want "upsert on (feed_id, guid) OR (feed_id, url)", so the poller can't
-- express that as a single Supabase .upsert(). The RPC runs the per-item
-- insert with ON CONFLICT (feed_id, guid), and on a (feed_id, url) unique_
-- violation falls back to UPDATE — folding the publisher's new guid + content
-- into the existing row. Called by the cron-only poller with the service role.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_feed_items(
  p_feed_id uuid,
  p_items   jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  itm jsonb;
begin
  for itm in select * from jsonb_array_elements(p_items)
  loop
    begin
      insert into public.items (
        feed_id, guid, url, title, author, published_at,
        content_html, summary, enclosures, content_hash
      )
      values (
        p_feed_id,
        itm->>'guid',
        itm->>'url',
        itm->>'title',
        itm->>'author',
        (itm->>'published_at')::timestamptz,
        itm->>'content_html',
        itm->>'summary',
        coalesce(itm->'enclosures', '[]'::jsonb),
        itm->>'content_hash'
      )
      on conflict (feed_id, guid) do update set
        url          = excluded.url,
        title        = excluded.title,
        author       = excluded.author,
        published_at = excluded.published_at,
        content_html = excluded.content_html,
        summary      = excluded.summary,
        enclosures   = excluded.enclosures,
        content_hash = excluded.content_hash;
    exception when unique_violation then
      -- (feed_id, url) partial-unique collision: publisher re-issued the same
      -- article under a new guid. Update the existing row in place (and adopt
      -- the new guid as the canonical identity going forward).
      update public.items set
        guid         = itm->>'guid',
        title        = itm->>'title',
        author       = itm->>'author',
        published_at = (itm->>'published_at')::timestamptz,
        content_html = itm->>'content_html',
        summary      = itm->>'summary',
        enclosures   = coalesce(itm->'enclosures', '[]'::jsonb),
        content_hash = itm->>'content_hash'
      where feed_id = p_feed_id
        and url     = itm->>'url';
    end;
  end loop;
end $$;

comment on function public.upsert_feed_items(uuid, jsonb) is
  'Poller-only items upsert that handles BOTH (feed_id, guid) and (feed_id, '
  'url) unique constraints atomically. Falls back to UPDATE on a (feed_id, '
  'url) conflict so a publisher re-issuing the same URL under a new guid '
  'updates the existing row instead of inserting a duplicate. Service-role '
  'only — clients have no need to call this.';

-- Definer functions default to EXECUTE for PUBLIC; lock down to the only role
-- that should call this. RLS bypass does NOT make service_role the function
-- owner — function EXECUTE is a separate privilege (cf. 0009's explicit table
-- grants), so revoke from public and grant to service_role explicitly.
revoke execute on function public.upsert_feed_items(uuid, jsonb) from public;
grant  execute on function public.upsert_feed_items(uuid, jsonb) to service_role;
