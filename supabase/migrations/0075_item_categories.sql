-- Store each item's publisher-supplied categories/tags — RSS/RDF <category>,
-- Atom <category label|term>, JSON Feed `tags` — so the client can show the
-- primary one in the list-view meta row (in place of the author) and, later,
-- filter/hide by category. See _shared/parser.ts's category extractors and
-- SPEC.md "Display-only meta".
--
-- text[], not null, default '{}' — matches the `enclosures` column's shape
-- (present-but-empty rather than null), so client mappers never need a
-- null-array branch.

alter table public.items
  add column if not exists categories text[] not null default '{}'::text[];

comment on column public.items.categories is
  'Publisher-supplied categories/tags, in the feed''s own order (first is the '
  'client''s displayed "primary" category). Empty for a feed/item that carries '
  'none, or a row written before this column existed. Trimmed/capped at parse '
  'time (_shared/parser.ts MAX_CATEGORIES/MAX_CATEGORY_LEN).';

-- --- upsert_feed_items: store categories alongside the rest of the row ------
-- Recreated from 0073 (body otherwise unchanged) because that definition
-- enumerates its columns explicitly and would silently drop the new key.
-- `itm->'categories'` is a jsonb array of strings (or absent, from a caller
-- predating this column); jsonb_array_elements_text over it, coalesced to an
-- empty jsonb array, is how a jsonb array becomes a text[] value.
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
  v_categories text[];
begin
  for itm in select * from jsonb_array_elements(p_items)
  loop
    -- Canonicalize the incoming URL so the (feed_id, url) collision fallback
    -- below matches the canonical survivor even when an old caller sends a raw
    -- URL. (The trigger canonicalizes the stored value regardless; this makes
    -- the WHERE line up so the re-issue updates instead of being dropped.)
    v_url := public.canonicalize_item_url(itm->>'url');
    -- array_agg with no ORDER BY has unspecified input order — WITH ORDINALITY
    -- + an explicit `order by ord` is what actually guarantees the publisher's
    -- own order survives, which SPEC.md's "first is the displayed primary
    -- category" promise depends on.
    select coalesce(array_agg(c order by ord), '{}'::text[]) into v_categories
    from jsonb_array_elements_text(coalesce(itm->'categories', '[]'::jsonb))
      with ordinality as t(c, ord);
    begin
      insert into public.items (
        feed_id, guid, url, comments_url, title, author, published_at,
        content_html, summary, enclosures, content_hash,
        title_normalized, title_normalized_version, categories
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
        itm->>'content_hash',
        itm->>'title_normalized',
        (itm->>'title_normalized_version')::smallint,
        v_categories
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
        categories   = excluded.categories,
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
        content_hash = excluded.content_hash,
        -- Written from the SAME payload item as `title`, so the pair cannot go
        -- stale. A caller that predates the column sends neither, which stores
        -- NULL/NULL and puts the row in the backfill backlog — the safe
        -- direction. What must NEVER happen is `title` moving while these keep
        -- a current version, because the backlog predicate would then skip the
        -- row forever and the server would filter it on text it no longer has.
        title_normalized = excluded.title_normalized,
        title_normalized_version = excluded.title_normalized_version;
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
          categories                      = v_categories,
          content_hash                    = itm->>'content_hash',
          title_normalized                = itm->>'title_normalized',
          title_normalized_version        = (itm->>'title_normalized_version')::smallint,
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
          categories                      = v_categories,
          content_hash                    = itm->>'content_hash',
          title_normalized                = itm->>'title_normalized',
          title_normalized_version        = (itm->>'title_normalized_version')::smallint,
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

-- --- get_shared_item: carry categories on a shared /item/<id> link ---------
-- Display-safe, so it rides the same projection as everything else here (see
-- 0068's header — never full_content_html/ai_summary/fetch URLs). OUT columns
-- change, so drop first (create-or-replace can't add a return column).
drop function if exists public.get_shared_item(uuid);

create or replace function public.get_shared_item(p_item_id uuid)
returns table (
  id                    uuid,
  feed_id               uuid,
  guid                  text,
  url                   text,
  comments_url          text,
  title                 text,
  spoiler_free_title    text,
  author                text,
  published_at          timestamptz,
  content_html          text,
  summary               text,
  enclosures            jsonb,
  categories            text[],
  content_hash          text,
  created_at            timestamptz,
  feed_site_url         text,
  feed_title            text,
  feed_favicon_url      text,
  feed_last_fetched_at  timestamptz,
  feed_next_fetch_at    timestamptz,
  feed_fetch_interval_s integer,
  feed_error_count      integer,
  feed_last_error       text,
  feed_created_at       timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    i.id, i.feed_id, i.guid, i.url, i.comments_url, i.title,
    i.spoiler_free_title, i.author, i.published_at, i.content_html,
    i.summary, i.enclosures, i.categories, i.content_hash, i.created_at,
    f.site_url, f.title, f.favicon_url, f.last_fetched_at, f.next_fetch_at,
    f.fetch_interval_s, f.error_count, f.last_error, f.created_at
  from public.items i
  join public.feeds f on f.id = i.feed_id
  where i.id = p_item_id
    and f.secret_url is null
    and not public.looks_tokenized(f.url);
$$;

comment on function public.get_shared_item(uuid) is
  'Resolve a shared /item/<id> link for any signed-in user, keyed on the item''s '
  'unguessable uuid (capability-by-URL). Returns display-safe item + feed columns '
  'only (never full_content_html / ai_summary / fetch URLs); a private/tokenized '
  'feed returns nothing. See 0068 header + SPEC "Sharing an article".';

revoke all on function public.get_shared_item(uuid) from public;
grant execute on function public.get_shared_item(uuid) to authenticated;

-- feed_items / feed_unread_counts need no change: both select the item's
-- WHOLE row (jsonb_populate_record(i, …) / cand ids re-hydrated via `i`), so
-- the new column rides along automatically once it exists on `items`.
