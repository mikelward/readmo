-- Readmo shared-article links: a hosted /item/<id> link opens for ANY signed-in
-- user when the article belongs to a PUBLIC feed, without them subscribing to
-- that feed. SPEC.md "Sharing an article".
--
-- The security model is CAPABILITY-BY-URL, not row visibility:
--   - items.id is a random uuid (gen_random_uuid, ~122 bits) — unguessable and
--     not enumerable. The only way to reach a specific item is to be handed its
--     link, exactly like an "anyone with the link" document share. That URL IS
--     the secret.
--   - So we do NOT touch feeds_select / items_select. Nothing new becomes
--     enumerable; every existing privacy invariant + test (a private feed stays
--     invisible to a plain `select … from feeds/items`) holds unchanged. The
--     shared item is served ONLY through the narrow definer read below, which
--     requires the caller to already possess the item's uuid.
--   - get_shared_item returns DISPLAY-SAFE columns only (the client ITEM_COLS +
--     the feed's display metadata). The copyright-gated columns
--     (full_content_html, ai_summary) are NEVER returned here — full text/summary
--     stay behind the allowlist-gated `fulltext` / `summary` Edge Functions,
--     which get a matching public-feed branch so an allowlisted family member
--     still reads full text on a shared link (see supabase/functions/*).
--
-- The public/private classifier is a SOFT paywall gate, not the security
-- boundary (the uuid is). Its only job is to keep a shared link to a PAID /
-- tokenized feed from resolving its body. Being imperfect is low-harm: too
-- strict → a public share link just doesn't resolve for a non-subscriber; too
-- permissive → a link-holder you chose sees an RSS body. Neither enumerates.
-- "Public feed" = no secret_url AND the url doesn't look like it embeds a token.
-- secret_url is never populated in practice (a pasted tokenized feed URL lands
-- in `url` with secret_url null; see 0004), so the url tokenization heuristic is
-- the load-bearing signal. It mirrors the TS looksTokenized
-- (_shared/urlSafety.ts) and is deliberately CONSERVATIVE (when in doubt →
-- tokenized/private). The paired Edge-function check reuses that same TS helper.

-- ---------------------------------------------------------------------------
-- looks_tokenized(url) — conservative "does this URL embed a secret token?"
-- heuristic. IMMUTABLE so a definer function can call it cheaply. See the
-- shared_public_items.sql test for the pinned cases.
-- ---------------------------------------------------------------------------
create or replace function public.segment_looks_tokenized(p_seg text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- A single path segment. Short segments can't hold a meaningful secret; an
  -- absurdly long one is suspicious regardless of composition.
  select case
    when p_seg is null or length(p_seg) < 20 then false
    when length(p_seg) >= 80 then true
    -- NOTE: we screen the RAW segment, not a URL-decoded one (unlike the TS
    -- sibling `looksTokenized`, which decodes first). We deliberately do NOT
    -- blanket-reject percent-encoded segments: a foreign-language slug is long
    -- percent-encoded UTF-8 that decodes to a readable word, so rejecting `%xx`
    -- would wrongly mark those feeds private. The residual — an ENCODED ASCII
    -- high-entropy token slipping the checks below — is unrealistic (real tokens
    -- are URL-safe and aren't percent-encoded) and low-harm (soft gate; the uuid
    -- is the boundary). TODO: decode-then-check parity with the TS heuristic (a
    -- tested SQL url_decode, or classify in a TS edge path).
    -- Hyphen/underscore slug or hyphenated UUID (readable): tokenized only when
    -- one of its parts is itself a long hex blob (e.g. /a/<32-hex>-thumb).
    when p_seg ~ '^[a-z0-9]+([-_][a-z0-9]+)+$' then exists (
      select 1
      from regexp_split_to_table(p_seg, '[-_]') as part
      where length(part) >= 20 and part ~ '^[0-9a-fA-F]+$'
    )
    -- A single long hex run (md5/sha-style), no separators.
    when p_seg ~ '^[0-9a-fA-F]+$' then true
    -- base64url / random-token charset with no word breaks: a long run that
    -- mixes case, or mixes letters and digits — the signature of an encoded token
    -- rather than a word.
    when p_seg ~ '^[A-Za-z0-9_-]+$' and length(p_seg) >= 24
      and ( (p_seg ~ '[a-z]' and p_seg ~ '[A-Z]')
         or ((p_seg ~ '[a-z]' or p_seg ~ '[A-Z]') and p_seg ~ '[0-9]') )
      then true
    else false
  end;
$$;

create or replace function public.looks_tokenized(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    -- Fail closed: null / non-http(s) / credentials in the authority / any query
    -- string is treated as possibly-secret.
    when p_url is null then true
    when p_url !~* '^https?://' then true
    when p_url ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/@]*@' then true
    when position('?' in p_url) > 0 then true
    else exists (
      -- Strip scheme://authority and any fragment, then screen each path segment.
      select 1
      from regexp_split_to_table(
        regexp_replace(split_part(p_url, '#', 1),
                       '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', ''),
        '/'
      ) as seg
      where public.segment_looks_tokenized(seg)
    )
  end;
$$;

comment on function public.looks_tokenized(text) is
  'Conservative "does this URL embed a secret token?" heuristic (SQL sibling of '
  '_shared/urlSafety.ts looksTokenized). Classifies a feed as public (shareable) '
  'vs private for get_shared_item. When in doubt, returns true (private).';

-- ---------------------------------------------------------------------------
-- get_shared_item(item_id) — resolve a shared /item/<id> link. SECURITY DEFINER
-- (so it reads past items_select/feeds_select), but the caller must present the
-- item's unguessable uuid, it returns DISPLAY-SAFE columns only (never
-- full_content_html / ai_summary / feeds fetch URLs), and it returns nothing for
-- a private/tokenized feed. One row: the item (client ITEM_COLS shape) plus the
-- feed's display metadata (FEED_COLS, prefixed `feed_`), so a non-subscriber's
-- reader can render name/favicon without a feeds_select grant. Granted to
-- authenticated only; the /item route is auth-gated.
-- ---------------------------------------------------------------------------
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
    i.summary, i.enclosures, i.content_hash, i.created_at,
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

-- ---------------------------------------------------------------------------
-- Re-create get_capabilities() (last defined in 0047) with a `shared_items`
-- flag so a client shipped AHEAD of this migration (Vercel auto-deploys the
-- frontend before a human runs `make migrate`) can tell whether
-- `get_shared_item` exists yet. Until it does, the reader's Share hands out the
-- publisher URL instead of a `/item/:id` link a non-subscriber couldn't resolve
-- (guardrail #11). Literal TRUE — the flag can only return once 0068 is live; an
-- old backend returns the pre-0068 shape (column absent → client reads false).
-- OUT columns change, so drop first (create-or-replace can't change the type).
-- ---------------------------------------------------------------------------
drop function if exists public.get_capabilities();
create or replace function public.get_capabilities()
returns table(
  family                 boolean,
  admin                  boolean,
  allowlist_armed        boolean,
  can_manage_users       boolean,
  can_view_subscriptions boolean,
  shared_items           boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    (
      exists (select 1 from public.allowlist)
      and exists (
        select 1 from public.allowlist
        where email = lower(auth.jwt() ->> 'email')
      )
    ) as family,
    public.is_admin() as admin,
    exists (select 1 from public.allowlist) as allowlist_armed,
    true as can_manage_users,
    true as can_view_subscriptions,
    true as shared_items;
$$;

revoke execute on function public.get_capabilities() from public;
grant  execute on function public.get_capabilities() to authenticated;
