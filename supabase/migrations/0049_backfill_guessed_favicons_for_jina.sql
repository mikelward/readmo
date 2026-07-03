-- One-time backfill (redo of 0038): clear derived `/favicon.ico` guesses again so
-- feeds re-run homepage `<link rel="icon">` discovery — now that discovery can
-- fall back to Jina Reader for bot-blocked homepages.
--
-- 0038 nulled the guess once, so feeds would run the (then-new) homepage icon
-- discovery. But that discovery had NO fallback for a bot-blocked homepage: a
-- publisher that 403s a plain server-side GET (ft.com, economist.com) discovered
-- nothing and re-stored the same `/favicon.ico` guess — which 404s in the
-- browser, leaving no icon. Because discovery is one-shot (it runs only when no
-- favicon is stored), those feeds would never retry, even after the poller
-- gained a Jina fallback for exactly this case.
--
-- Nulling the guess a second time makes the next poll treat these feeds as "not
-- yet discovered" once more: discovery runs, and for a bot-blocked homepage it
-- now retries through Jina Reader (a headless-browser proxy that bypasses the bot
-- wall) and recovers the real icon; feeds whose homepage is reachable but names
-- no icon simply re-settle on the guess, unchanged. Affected feeds show no icon
-- for the gap until their next poll repopulates it (<= one fetch interval) —
-- cosmetic and self-healing; the `<img>` hides itself meanwhile.
--
-- As in 0038 we also clear `etag`/`last_modified` for the same rows: discovery
-- only runs on the 200 parse path, and `pollOne` short-circuits a conditional-GET
-- 304 *before* resolving the favicon, so a stable feed with stored validators
-- would return 304 forever and never pick up the new discovery pass. Dropping the
-- validators forces the next poll to fetch unconditionally (one full GET, then
-- the poller re-stores fresh validators from that 200); item upsert de-dups by
-- guid/url, so nothing is duplicated.
--
-- The predicate matches ONLY the derived guess shape: `scheme://host[:port]/
-- favicon.ico` at the origin root, with no query/fragment (deriveFavicon builds
-- exactly that). An advertised or already-discovered icon at a sub-path
-- (`/assets/favicon.ico`) or with a query (`?v=2`) is left untouched — and even
-- if one matched, the next poll would re-set it through the advertised-icon path
-- with no extra fetch.
--
-- Cost/reliability (guardrail #5): a single bounded UPDATE over `feeds`, run once
-- at migrate time. No network, no third-party call. The only runtime cost is one
-- unconditional (rather than 304) fetch per affected feed on its next poll, plus
-- — for the bot-blocked ones — one Jina fetch (documented in the Jina row of the
-- External services table). Negligible.

update public.feeds
  set favicon_url = null,
      etag = null,
      last_modified = null
  where favicon_url ~ '^https?://[^/]+/favicon\.ico$';
