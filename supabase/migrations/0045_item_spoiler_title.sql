-- Readmo spoiler-free sports headlines cache.
--
-- At poll time, for feeds that have an allowlisted subscriber, the poller asks
-- Gemini to classify each new headline and — when it spoils a sporting result —
-- rewrite it spoiler-free ("EPL MNU vs ARS result"). The rewrite is cached here
-- on the SHARED item so every subscriber's list shows it without another model
-- call. The ORIGINAL headline always stays in `title`, so display is reversible
-- (the client picks which to show). SPEC.md "Spoiler-free sports headlines".
--
-- Trust model, and how this DIFFERS from `ai_summary` (0035):
--   - `ai_summary` is a generation-cost, higher-exposure surface, so it's gated
--     on the allowlist AND scrubbed from list payloads (served only via the
--     allowlist-gated `summary` function). The spoiler-free title is the
--     opposite: it's a LIST feature (the point is to de-spoiler the river before
--     you open anything), and it's non-sensitive — it HIDES information and is
--     derived from the title the caller can already see. So it is deliberately
--     NOT scrubbed from `feed_items`; it rides the normal list payload and the
--     client gates who SEES the rewrite (the allowlist capability + a per-user
--     setting). Generation is still allowlist-gated (see
--     `feeds_with_allowlisted_subscriber` below), so only family feeds spend the
--     model budget.
--   - Writes stay server-only (0002 revoked client INSERT/UPDATE on items; the
--     poller writes as the service role, granted UPDATE in 0009).

alter table public.items
  -- The spoiler-free rewrite of `title` (plain text). NULL when the headline
  -- isn't a sports-result spoiler, or hasn't been processed yet.
  add column if not exists spoiler_free_title              text,
  -- When the item was last run through the spoiler pass. Non-null marks it
  -- PROCESSED (whether or not a rewrite was produced), so "needs processing" is
  -- `spoiler_free_title_generated_at is null` — distinguishing "no rewrite" from
  -- "never tried" and bounding poll-time work to genuinely new/changed items.
  add column if not exists spoiler_free_title_generated_at timestamptz;

-- Partial index for the poller's "next unprocessed items" lookup, which filters
-- `spoiler_free_title_generated_at IS NULL` and orders by (feed_id, sort_at
-- desc). Indexing exactly that predicate keeps the index SMALL — processed rows
-- drop out of it — so fetching the next batch (or proving a fully-processed feed
-- has none) is a tiny index scan regardless of the feed's archive size, instead
-- of walking the processed prefix of items_feed_sort_idx (0005). Steady-state
-- cron work then scales with UNPROCESSED items, not total items.
create index if not exists items_feed_unspoiled_idx
  on public.items (feed_id, sort_at desc)
  where spoiler_free_title_generated_at is null;

-- feed_items is intentionally NOT recreated here: it returns the whole
-- `public.items` composite, and the new columns are not in its scrub list, so
-- the spoiler-free title flows through list reads automatically — which is what
-- we want (unlike the gated full-text/summary fields it nulls).

-- Which of the given feeds have at least one ALLOWLISTED subscriber.
--
-- The poller calls this with the batch it just polled and only generates
-- spoiler-free titles for the feeds it returns — so the cost is bounded to feeds
-- an allowlisted (family) user actually reads. Joins subscriptions → the user's
-- email → the `allowlist` table (emails, case-insensitive; same list as reading
-- mode / summaries).
--
-- COST-SAFETY: unlike the app's usual "empty allowlist = open to all", an EMPTY
-- allowlist here returns NO feeds (the join finds nothing), i.e. the feature is
-- OFF until the operator arms the allowlist. That's deliberate: poll-time
-- generation for every feed on an unseeded deploy would be an unbounded Gemini
-- bill. Service-role only (the poller); never exposed to clients.
create or replace function public.feeds_with_allowlisted_subscriber(
  p_feed_ids uuid[]
)
returns setof uuid
language sql
security definer
set search_path = ''
as $$
  select distinct s.feed_id
  from public.subscriptions s
  join auth.users u on u.id = s.user_id
  join public.allowlist a
    on lower(a.email) = lower(u.email)
  where s.feed_id = any(p_feed_ids);
$$;

comment on function public.feeds_with_allowlisted_subscriber(uuid[]) is
  'Poller-only: the subset of the given feed ids that have >=1 allowlisted '
  'subscriber (subscriptions → auth.users.email → allowlist). Bounds poll-time '
  'spoiler-title generation to family feeds. An empty allowlist returns no rows '
  '(feature OFF) — a deliberate cost guard against generating for every feed on '
  'an unseeded deploy. Service-role only.';

revoke execute on function public.feeds_with_allowlisted_subscriber(uuid[]) from public;
grant  execute on function public.feeds_with_allowlisted_subscriber(uuid[]) to service_role;

-- Invalidate the cached spoiler-free title when an item's content changes.
--
-- Recreate `upsert_feed_items` (verbatim from 0035, same signature so grants are
-- preserved) to ALSO clear `spoiler_free_title` + `spoiler_free_title_generated_at`
-- on a change, exactly like the `ai_summary` invalidation already there:
--   - guid-conflict path: clear only when `content_html`/`title` differs, so an
--     identical re-poll keeps the cached rewrite;
--   - url-collision path (same url re-issued under a new guid): always clear — a
--     re-issue is a new article, so any prior rewrite is stale.
-- Clearing `generated_at` is what re-queues the item for the next poll's pass.
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
        feed_id, guid, url, comments_url, title, author, published_at,
        content_html, summary, enclosures, content_hash
      )
      values (
        p_feed_id,
        itm->>'guid',
        itm->>'url',
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
        and url     = itm->>'url';
    end;
  end loop;
end $$;

comment on function public.upsert_feed_items(uuid, jsonb) is
  'Poller-only items upsert that handles BOTH (feed_id, guid) and (feed_id, '
  'url) unique constraints atomically. Falls back to UPDATE on a (feed_id, '
  'url) conflict so a publisher re-issuing the same URL under a new guid '
  'updates the existing row instead of inserting a duplicate. Carries '
  'comments_url (0033). Nulls the cached ai_summary (0035) and spoiler_free_title '
  '(0045) — plus their timestamps — when the content changes (content_hash '
  'differs on the guid path, always on a url re-issue) so edited articles are '
  're-derived instead of serving stale AI output. Service-role only.';

revoke execute on function public.upsert_feed_items(uuid, jsonb) from public;
grant  execute on function public.upsert_feed_items(uuid, jsonb) to service_role;
