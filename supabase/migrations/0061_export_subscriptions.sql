-- Authenticated OPML export.
--
-- `feeds_public` deliberately withholds BOTH fetch URLs (url + secret_url) from
-- clients (0002_rls), so the client's live `exportOpml` could only emit the
-- display-safe homepage (`site_url`) — an OPML that opens the right websites but
-- is NOT re-importable into another reader, since the homepage isn't the RSS/
-- Atom endpoint. This RPC closes that gap: it returns the feed fetch URL
-- (`feeds.url`) for the CALLER'S OWN subscriptions only, so the OPML round-trips
-- into Feedly/Inoreader/NetNewsWire.
--
-- WHY EXPOSING `url` HERE IS SAFE (a deliberate, owner-scoped carve-out to the
-- 0002_rls invariant "url is server-only"). 0002 hides `url` from clients
-- because it may embed a pasted per-user token (paid newsletters, private feed
-- URLs) and a shared `feeds_public` read could otherwise hand that token to a
-- CO-SUBSCRIBER or a permanent-state reader who never had it. This RPC does not
-- create that exposure:
--   * It joins ONLY `subscriptions` rows where user_id = auth.uid() — never the
--     broader permanent-state visibility feeds_public's RLS allows, and never
--     another user's row. A caller gets back `url` solely for feeds THEY
--     subscribe to.
--   * To hold a subscription to a tokenized feed you must have presented that
--     fetch URL yourself: `subscribe_to_feed` authorizes on the fetch url
--     (`secret_url ?? url`, 0004/0043), so the token in `url` is already the
--     caller's own. The export returns each user only tokens they already have —
--     the co-subscriber leak 0002 guards against cannot happen here.
--   * It still NEVER returns `secret_url` (the separate token-bearing variant).
--     For a secret-backed row `url` is the token-stripped canonical, so that
--     rare feed exports a non-fetchable address and does not round-trip — the
--     accepted limit, since emitting `secret_url` would leak a token 0002 keeps
--     server-only. (No app path populates `secret_url` today; the RPC honors the
--     boundary regardless.)
--   * SECURITY DEFINER so it can read `feeds.url` past the 0002 column-privilege
--     lockdown; hardening mirrors 0004/0028: `set search_path = ''`, fully-
--     qualified names, identity from auth.uid() (never a parameter), no client
--     table grant.
--
-- Backwards compatible (guardrail #11): additive. A new client feature-detects a
-- backend without this function (PGRST202) and falls back to the homepage export;
-- an old cached client never calls it. Goes live via `make deploy`/`make migrate`.

create or replace function public.export_subscriptions()
returns table (feed_url text, site_url text, title text)
language sql
security definer
set search_path = ''
stable
as $$
  select
    f.url                                              as feed_url,
    f.site_url,
    coalesce(s.title_override, f.title, f.site_url)    as title
  from public.subscriptions s
  join public.feeds f on f.id = s.feed_id
  where s.user_id = auth.uid()
  order by s.sort;
$$;

revoke execute on function public.export_subscriptions() from public;
grant  execute on function public.export_subscriptions() to authenticated;
