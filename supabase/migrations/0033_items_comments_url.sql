-- Persist the item comments/discussion URL.
--
-- RSS 2.0 has a standard optional <comments> item element (the URL of the
-- item's comments page — Hacker News, WordPress, lobste.rs, …); Atom's analog is
-- <link rel="replies"> (RFC 4685). The parser now captures it as
-- NormalizedItem.commentsUrl, but the poller's upsert dropped it because
-- upsert_feed_items lists columns explicitly. Add the column and thread it
-- through the RPC so the structured discussion link is stored alongside the
-- article url, instead of leaving consumers to scrape it back out of the
-- sanitized body HTML.
--
-- Additive + nullable: existing rows stay null until their feed is next polled.
-- No client read selects it yet (ITEM_COLS is unchanged), so this is a safe
-- backend-only "expand" step — a consumer (the "open on newshacker" mode) reads
-- it in a later change, gated for backward compatibility.

alter table public.items
  add column if not exists comments_url text;

comment on column public.items.comments_url is
  'Absolute URL of the item''s comments/discussion page: RSS 2.0 <comments> or '
  'Atom <link rel="replies"> (RFC 4685). Distinct from `url` (the article); for '
  'aggregator feeds (Hacker News, lobste.rs) this is the discussion thread.';

-- Re-create the poller upsert (0013) to carry comments_url through both the
-- INSERT/ON CONFLICT path and the (feed_id, url) unique_violation UPDATE path.
-- Everything else is unchanged from 0013. CREATE OR REPLACE keeps the existing
-- ownership and privileges, but we re-assert the lock-down below to stay
-- self-documenting.
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
        content_hash = excluded.content_hash;
    exception when unique_violation then
      -- (feed_id, url) partial-unique collision: publisher re-issued the same
      -- article under a new guid. Update the existing row in place (and adopt
      -- the new guid as the canonical identity going forward).
      update public.items set
        guid         = itm->>'guid',
        comments_url = itm->>'comments_url',
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
  'updates the existing row instead of inserting a duplicate. Carries '
  'comments_url (0033). Service-role only — clients have no need to call this.';

revoke execute on function public.upsert_feed_items(uuid, jsonb) from public;
grant  execute on function public.upsert_feed_items(uuid, jsonb) to service_role;
