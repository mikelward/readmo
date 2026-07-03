-- Admin feed-status console (`/admin/feeds`): persisted full-download outcomes.
--
-- The operator wants a system-wide health view of every feed: whether its most
-- recent poll failed, and — for the article most recently fetched in reading
-- mode from that feed — whether the full-article download succeeded, and if not,
-- WHY (the publisher's HTTP status, or the robots.txt rule that blocked it).
--
-- The "why" isn't stored today. The `fulltext` function computes the outcome on
-- every attempt (it knows the publisher's HTTP status, the 401/403 bot-block,
-- the Jina fallback result, a robots.txt disallow + the matching rule, …) but
-- persists only the extracted BODY (`items.full_content_html`, or nothing). So
-- `full_content_html IS NULL` can't distinguish "403 bot-block" from "never
-- opened" from "robots-disallowed" from "paywall".
--
-- This migration adds a server-only record of the last download ATTEMPT per
-- shared item, which the `fulltext` function writes on each terminal outcome, so
-- the admin read can surface a download status + the server's response. It lives
-- in its own table (not new `items` columns) so it stays entirely off every
-- client read path — no `feed_items` scrub, no `ITEM_COLS` change — and never
-- rides along in a list payload. It is operational metadata, not gated content;
-- the admin RPC (SECURITY DEFINER, is_admin) is the only reader.
--
-- A recorded attempt only ever exists for an ALLOWLISTED fetch (the `fulltext`
-- gate refuses everyone else before any fetch), so the admin read can simply
-- take the most recent attempt row per feed — no pin/allowlist join needed here.

create table if not exists public.item_fulltext_status (
  item_id      uuid        primary key references public.items(id) on delete cascade,
  -- The `fulltext` outcome of the last attempt: 'ok' (extracted + cached),
  -- 'auth' (publisher gated it, Jina couldn't help), 'unreachable' (network /
  -- SSRF-blocked / non-2xx / oversized), 'empty' (no URL, robots-disallowed, or
  -- nothing article-like extracted).
  status       text        not null,
  -- The publisher's HTTP status from the direct fetch, when there was a response
  -- (e.g. 403 on a bot-block, 500 on a server error). NULL for a transport-level
  -- failure or a pre-fetch outcome (no URL / robots).
  http_status  int,
  -- A short human reason for a non-'ok' outcome (e.g. 'disallowed by robots.txt
  -- (User-agent: *)', a network error message). NULL when uninformative.
  error        text,
  -- The exact robots.txt directive that blocked the fetch, when the outcome was
  -- a robots disallow (e.g. 'Disallow: /news/'). NULL otherwise.
  robots_rule  text,
  attempted_at timestamptz not null default now()
);

comment on table public.item_fulltext_status is
  'Server-only record of the last full-text (reading-mode) download attempt per '
  'shared item, written by the `fulltext` Edge Function on every terminal '
  'outcome. Powers the /admin/feeds download-status/server-response columns '
  '(incl. the robots.txt denial reason + matching rule). Operational metadata, '
  'not gated content; kept off all client reads (its own table, RLS-locked, no '
  'authenticated grant) and read only by the admin-gated admin_list_feeds RPC.';

-- Fail closed: RLS on, and no policy for anon/authenticated → clients can never
-- read or write it. The `fulltext` function writes it with the service role
-- (which bypasses RLS), and admin_list_feeds reads it as SECURITY DEFINER.
alter table public.item_fulltext_status enable row level security;

revoke all on public.item_fulltext_status from anon, authenticated;
grant select, insert, update on public.item_fulltext_status to service_role;

create or replace function public.admin_list_feeds()
returns table (
  id                uuid,
  title             text,
  site_url          text,
  favicon_url       text,
  last_fetched_at   timestamptz,
  next_fetch_at     timestamptz,
  error_count       int,
  last_error        text,
  sample_item_id    uuid,
  sample_item_title text,
  sample_has_full_content   boolean,
  sample_download_status    text,
  sample_download_http      int,
  sample_download_error     text,
  sample_download_robots_rule text,
  sample_download_at        timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  return query
    -- NB: `feeds.url` (the fetch URL, possibly subscriber-tokenized — 0002/0004,
    -- guardrail #7) is deliberately NOT returned: this RPC is read by the browser
    -- admin page, so only display-safe metadata (site_url/title/favicon) leaves
    -- the server. The sample's `items.url` is likewise omitted (unused by the UI).
    select
      f.id,
      f.title,
      f.site_url,
      f.favicon_url,
      f.last_fetched_at,
      f.next_fetch_at,
      coalesce(f.error_count, 0)::int,
      f.last_error,
      s.id,
      s.title,
      (s.full_content_html is not null) as sample_has_full_content,
      s.status,
      s.http_status,
      s.error,
      s.robots_rule,
      s.attempted_at
    from public.feeds f
    -- The sample article: the item in this feed with the most recent recorded
    -- reading-mode download attempt. A recorded attempt implies an allowlisted
    -- fetch, so no pin/allowlist filter is needed. A feed with no attempt yields
    -- a null sample → the client's "not tried" status.
    left join lateral (
      select
        i.id, i.title, i.full_content_html,
        fs.status, fs.http_status, fs.error, fs.robots_rule, fs.attempted_at
      from public.item_fulltext_status fs
      join public.items i on i.id = fs.item_id
      where i.feed_id = f.id
      order by fs.attempted_at desc, fs.item_id desc
      limit 1
    ) s on true
    order by f.title asc nulls last, f.id asc;
end;
$$;

comment on function public.admin_list_feeds() is
  'Admin-only (is_admin) system-wide feed-status read for /admin/feeds: one row '
  'per feed with fetch-health fields (last_fetched_at, next_fetch_at, '
  'error_count, last_error) plus a single sample item — the article in the feed '
  'with the most recent reading-mode download attempt — its cached-body presence '
  'and that attempt (status / HTTP code / error / robots rule / when) from '
  'item_fulltext_status. Null sample columns mean the feed has no recorded '
  'attempt. Fails closed for non-admins (42501).';

revoke execute on function public.admin_list_feeds() from public;
grant  execute on function public.admin_list_feeds() to authenticated;
