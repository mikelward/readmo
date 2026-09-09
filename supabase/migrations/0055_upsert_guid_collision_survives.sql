-- upsert_feed_items: survive a guid/url cross-collision instead of aborting
-- the whole per-feed batch.
--
-- The (feed_id, url) collision fallback (0013, body last touched in 0048)
-- adopts the incoming guid onto the url-matching survivor:
--
--   update public.items set guid = itm->>'guid', … where url = v_url
--
-- That UPDATE itself can violate `unique (feed_id, guid)`: the feed already
-- holds row A (guid=G, url=U1) and row B (guid=G2, url=U), and the publisher
-- emits an item claiming BOTH (guid=G, url=U) — a guid/url swap or partial
-- re-issue. The INSERT conflicts on guid (row A), the DO UPDATE trips over
-- row B's url, the fallback then tries to give row B the guid row A still
-- holds — and this second unique_violation had no handler, so it escaped the
-- exception block and rolled back the entire RPC. Since the RPC is the
-- poller's single per-feed item write, every item in the batch was lost, and
-- the identical publisher data re-aborted every subsequent poll: recordFailure
-- backed the feed off to the max interval and the feed stuck until the
-- publisher happened to change its data.
--
-- Fix: nest a handler around the fallback UPDATE. When guid adoption would
-- collide, retry the same content update WITHOUT the guid change — the fresh
-- content still lands on the url survivor (the row a reader following that
-- URL sees), row A keeps its guid, and the batch commits. The steady state
-- (the publisher keeps emitting the swapped pair) re-takes this path each
-- poll, which is bounded and harmless.
--
-- Body otherwise VERBATIM from 0048 (which is 0045 + the v_url delta) — keep
-- in sync with those if the column set changes.

begin;

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
  itm   jsonb;
  v_url text;
begin
  for itm in select * from jsonb_array_elements(p_items)
  loop
    -- Canonicalize the incoming URL so the (feed_id, url) collision fallback
    -- below matches the canonical survivor even when an old caller sends a raw
    -- URL. (The trigger canonicalizes the stored value regardless; this makes
    -- the WHERE line up so the re-issue updates instead of being dropped.)
    v_url := public.canonicalize_item_url(itm->>'url');
    begin
      insert into public.items (
        feed_id, guid, url, comments_url, title, author, published_at,
        content_html, summary, enclosures, content_hash
      )
      values (
        p_feed_id,
        itm->>'guid',
        v_url,
        itm->>'comments_url',
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
        comments_url = excluded.comments_url,
        title        = excluded.title,
        author       = excluded.author,
        published_at = excluded.published_at,
        content_html = excluded.content_html,
        summary      = excluded.summary,
        enclosures   = excluded.enclosures,
        -- Drop the AI summary when the article's text actually changed. We
        -- compare content_html/title, NOT content_hash: the live poller/refresh
        -- set `content_hash = it.guid`, so the hash is stable across a same-guid
        -- edit and useless for change detection. All SET RHS see the pre-update
        -- row, so this is the OLD body/title vs. the incoming ones.
        ai_summary = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
          then null else public.items.ai_summary end,
        ai_summary_generated_at = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
          then null else public.items.ai_summary_generated_at end,
        -- Change-detection for the spoiler-free title: a changed headline or body
        -- re-queues it (generated_at → null) for the next poll's pass. This ALSO
        -- watches `summary` (unlike the ai_summary block above): the spoiler
        -- classifier's input is `content_html` ?? `summary` (spoilerContentText),
        -- so for a JSON-Feed-style item with no content_html a changed summary
        -- changes the model input and must re-classify. (ai_summary reads
        -- full_content_html ?? content_html, never `summary`, so it correctly
        -- ignores it.) A summary-only change while content_html is present
        -- re-classifies unnecessarily, but that's bounded by the per-poll budget +
        -- shared cache and is negligible.
        spoiler_free_title = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
            or public.items.summary is distinct from excluded.summary
          then null else public.items.spoiler_free_title end,
        spoiler_free_title_generated_at = case
          when public.items.content_html is distinct from excluded.content_html
            or public.items.title is distinct from excluded.title
            or public.items.summary is distinct from excluded.summary
          then null else public.items.spoiler_free_title_generated_at end,
        content_hash = excluded.content_hash;
    exception when unique_violation then
      -- (feed_id, url) partial-unique collision: publisher re-issued the same
      -- article under a new guid. Update in place (and adopt the new guid). A
      -- re-issue is a new article, so always clear the stale derived fields.
      -- Match on the CANONICAL url (v_url) so the WHERE lines up with what the
      -- trigger stored.
      begin
        update public.items set
          guid                            = itm->>'guid',
          comments_url                    = itm->>'comments_url',
          title                           = itm->>'title',
          author                          = itm->>'author',
          published_at                    = (itm->>'published_at')::timestamptz,
          content_html                    = itm->>'content_html',
          summary                         = itm->>'summary',
          enclosures                      = coalesce(itm->'enclosures', '[]'::jsonb),
          content_hash                    = itm->>'content_hash',
          ai_summary                      = null,
          ai_summary_generated_at         = null,
          spoiler_free_title              = null,
          spoiler_free_title_generated_at = null
        where feed_id = p_feed_id
          and url     = v_url;
      exception when unique_violation then
        -- Guid adoption collided: a DIFFERENT row in this feed still holds the
        -- incoming guid (guid/url swap, partial re-issue). Retry without the
        -- guid change so the content still lands on the url survivor and the
        -- batch survives — this violation used to escape the outer handler and
        -- roll back the whole per-feed batch on every poll (a stuck feed).
        update public.items set
          comments_url                    = itm->>'comments_url',
          title                           = itm->>'title',
          author                          = itm->>'author',
          published_at                    = (itm->>'published_at')::timestamptz,
          content_html                    = itm->>'content_html',
          summary                         = itm->>'summary',
          enclosures                      = coalesce(itm->'enclosures', '[]'::jsonb),
          content_hash                    = itm->>'content_hash',
          ai_summary                      = null,
          ai_summary_generated_at         = null,
          spoiler_free_title              = null,
          spoiler_free_title_generated_at = null
        where feed_id = p_feed_id
          and url     = v_url;
      end;
    end;
  end loop;
end $$;

comment on function public.upsert_feed_items(uuid, jsonb) is
  'Poller-only items upsert across BOTH (feed_id, guid) and (feed_id, url) '
  'unique constraints. Canonicalizes the incoming url (canonicalize_item_url, '
  '0048) so the (feed_id, url) collision fallback matches the canonical survivor '
  'even for a raw URL from a not-yet-redeployed caller. A guid/url cross-'
  'collision (0055) updates the url survivor without adopting the guid instead '
  'of aborting the batch. Carries comments_url (0033); nulls the cached '
  'ai_summary (0035) and spoiler_free_title (0045) — plus timestamps — when '
  'content changes (always on a url re-issue). The items_canonicalize_url '
  'trigger enforces canonical storage independently. Service-role only. Keep '
  'the body in sync with 0045/0048.';

-- Re-assert the lockdown from 0013 (create-or-replace preserves grants, but be
-- explicit so a fresh apply order can't leave it EXECUTE-to-PUBLIC).
revoke execute on function public.upsert_feed_items(uuid, jsonb) from public;
grant  execute on function public.upsert_feed_items(uuid, jsonb) to service_role;

commit;
