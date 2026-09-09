-- One-time backfill: clear derived `/favicon.ico` guesses so existing feeds get
-- a homepage `<link rel="icon">` discovery pass.
--
-- Before homepage icon discovery landed, the poller wrote the guessed
-- `<origin>/favicon.ico` for every feed that advertised no icon of its own. The
-- new poller discovers a real icon from the site homepage, but only when no
-- favicon is stored yet (discovery is one-shot, to avoid re-fetching the page on
-- every poll). Feeds polled by the old code already have the guess stored, so
-- without this they would permanently skip discovery and keep serving a guess
-- that may 404 (e.g. ft.com).
--
-- Nulling the guess makes the next poll treat the feed as "not yet discovered":
-- it runs discovery once, then stores the result (a real icon, or the guess it
-- settles on) and the one-shot logic reuses it thereafter. Affected feeds show
-- no icon for the gap until their next poll repopulates it (<= one fetch
-- interval) — cosmetic and self-healing; the `<img>` hides itself meanwhile.
--
-- We also clear `etag`/`last_modified` for the same rows. Discovery only runs on
-- the 200 parse path; `pollOne` short-circuits a conditional-GET 304 *before*
-- resolving the favicon, so a stable feed with stored validators would return
-- 304 forever and never pick up the discovery pass — left with no icon
-- indefinitely. Dropping the validators forces the next poll to fetch
-- unconditionally (one full GET, then the poller re-stores fresh validators from
-- that 200); item upsert de-dups by guid/url, so nothing is duplicated.
--
-- The predicate matches ONLY the derived guess shape: `scheme://host[:port]/
-- favicon.ico` at the origin root, with no query/fragment (deriveFavicon builds
-- exactly that). An advertised icon at a sub-path (`/assets/favicon.ico`) or
-- with a query (`?v=2`) is left untouched — and even if one matched, the next
-- poll would re-set it through the advertised-icon path with no extra fetch.
--
-- Cost/reliability (guardrail #5): a single bounded UPDATE over `feeds`, run once
-- at migrate time. No network, no third-party call. The only runtime cost is one
-- unconditional (rather than 304) fetch per affected feed on its next poll.
-- Negligible.

update public.feeds
  set favicon_url = null,
      etag = null,
      last_modified = null
  where favicon_url ~ '^https?://[^/]+/favicon\.ico$';
