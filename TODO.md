# TODO

Deferred work, tracked here so it isn't lost. Each item links to where the
constraint is documented in more detail.

## Finish the gate → lanes check rename

The consumer-facing required check was renamed from `gate` to `lanes`
(mikelward/lanes#9). `lanes` now runs alongside `gate` here (both green),
but two steps remain, outside what a session without ruleset API access can
do:

- [ ] Flip the ruleset to require `lanes` instead of `gate`, now that
      `lanes` has reported on a `pull_request` run here: `repo-rules
      mikelward/readmo lanes ...` (naming every check the ruleset should
      require — `mikelward/scripts`' tool).
- [ ] Once the ruleset requires `lanes`, delete the now-redundant `gate`
      job and its parity test (`.github/workflow-check-rename.test.ts`) in
      a follow-up PR.

## Decisions needing review

Calls that haven't been settled — guesses autopilot made without asking, and
decisions deliberately postponed — recorded so they don't silently become
permanent by default. Each is cheap to change.

- **`grafana/README.md` and `infra/cf-gateway/README.md` are now code, not
  docs** (autopilot, 2026-08-30). Narrowing `.github/lanes.conf` from
  `docs **/*.md` to `docs *.md` + `docs docs/**/*.md` — the standard
  mikelward/lanes' README states — moves the two markdown files that are
  neither at the root nor under `docs/` onto the code lane. **Alternative:**
  add `docs grafana/*.md` and `docs infra/**/*.md` to keep them on the docs
  lane. **Not taken**, because a per-path exception list is exactly what
  lanes' README warns decays silently, and both directories hold
  configuration *and* tests — a README edit there sits beside things CI
  validates, which is the case the narrowing exists for. The cost is a full
  CI run on a prose-only edit to either file. **Reversible** by adding those
  two lines if that turns out to happen often enough to matter.

- **DEFERRED: US-spelling enforcement (owner call, 2026-08-18).** gedmap
  enforces its US-English rule with a dictionary-difference test
  (usSpelling.test.js: an offense is a word valid in en-GB AND invalid in
  en-US, so names and jargon are unreachable false positives); porting it here
  was prepared and then set aside — "we can worry about that later." The
  prepared scan found ~50 British-only spellings — the doubled-l forms of
  canceled/canceling (in the ShareResult literal, settings-sync, hooks, and
  /debug copy) and mislabeled/labeled, plus the British forms of license,
  neighbors, traveled, and acknowledgment in fixtures and prose — all
  mechanical and suite-green when applied. Reviving it: add
  nspell + dictionary-en + dictionary-en-gb devDependencies, port the test
  with ALLOW = prev, oversized (US words dictionary-en lacks), land the
  renames, and reword guardrail 3 so the rule stops quoting the British forms
  it forbids.

- **UNDECIDED: whether to hold a remotely-adopted filter list until the list
  rematerializes** (Codex P2 on #623). A filter list adopted from another device
  currently applies to the list already on screen, removing rows under a reader
  who did nothing — against the stable-set invariant. A *local* add must stay
  immediate (the reader just tapped Filter… and SPEC promises the article
  vanishes), so only the remote case would defer, and telling them apart means
  threading provenance from the settings store into `visibleItems`, which already
  carries two overlays with their own retention rules (`struckIdsRef`,
  `localDismissedIdsRef`). **The decision is postponed, not made** — shipped as-is
  for now because it needs a cross-device edit against a still-open tab to
  trigger and the effect is the feature applying early rather than data loss.
  Worth noting the premise is arguable: a filter set on one device taking effect
  on another reads as sync working, not as a violation — the invariant is about
  content moving under a reader's thumb, and a list that quietly loses rows the
  reader has already filtered elsewhere may be exactly what they want. **Narrowed
  by 0072's client half (#625):** a remotely-adopted list now also triggers a
  feed REFETCH, not just an overlay re-run, because the rows the server excluded
  aren't in the cache to restore. So the remote case is now a full
  re-materialization — more reflow, not less — and it arrived for correctness
  rather than as an answer to this question. What's left open is only whether
  that re-materialization should be deferred to the next natural one (return
  past the TTL, pull-to-refresh, More) instead of happening on focus; the
  alternative is to accept it and say so in SPEC.
- **`title_filters` is a `text[]` on `user_settings`, not its own table**
  (0071). Consequence: two devices editing the list before either syncs resolve
  last-write-wins over the **whole list**, not per word. Judged fine for a list
  edited a few times a year, and it rides the existing sync engine with no new
  read path. Reversible: a `title_filters` child table is the fix if it bites.
- **A short all-caps acronym folds onto its lowercase homograph** — filtering
  `US` also matches the pronoun "us". Recorded in a test rather than fixed; the
  menu never offers it (`us` is a stopword), so it takes typing `US` by hand,
  and removing the entry undoes it. The fix is case-preserving storage plus
  case-sensitive matching for all-caps entries, which is its own change.
- **Filtered words is its own Settings section**, between Reading and
  Appearance, rather than a subsection of Reading. Purely presentational;
  reversible in one edit.

## Offline / PWA

- **Background Sync API.** Writes queued in the outbox while offline are
  flushed on the next page open / focus-return. The
  [Background Sync API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
  would let the service worker flush the outbox in the background — even when
  the tab is closed — on browsers that support it (Chrome/Android, not Safari).
  The outbox already delivers reliably (per-field LWW makes a crash/lost-ack
  replay idempotent — see SPEC.md §Sync), so this is gated only on browser
  support and priority.

## Storage / dedup

- **Cross-feed item dedup.** Same-feed dupes (a publisher re-issuing the same
  URL under a new `<guid>`) are now collapsed by the `(feed_id, url)` partial
  unique index and the `upsert_feed_items` RPC (migration `0013`), with the URL
  first canonicalized (fragment + tracking params stripped) so cosmetic
  re-issues collapse too (migration `0048`, parser `canonicalizeItemUrl`). The
  remaining case is when the SAME article URL shows up in two DIFFERENT feed
  subscriptions — e.g. a user subscribed to both "BBC News - Home" and "BBC
  News - Top Stories", which carry overlapping articles. Today those land as
  separate `items` rows (one per `feed_id`) and the user sees two rows for the
  same story. Options to consider, with tradeoffs:
  - **De-dup at read time in `feed_items`** (`distinct on (lower(url))`,
    keep the newest): cheapest, reversible, but hides the duplication rather
    than fixing storage; needs care with the section/order_by to avoid losing
    the Pinned-first guarantee.
  - **Share `items` rows across feeds**: lift the `feed_id` off `items` into a
    join table; biggest schema change, but the cleanest. Costs a migration on
    the hottest table and the `feed_items` RPC.
  - **Subscription-level dedup hint**: let the user pick a "primary" feed when
    two of their subscriptions share articles. Lowest impact, requires UI.
  See SPEC.md §Data → De-dup.

## Feed discovery

- **Support sites that don't publish a feed (e.g. inews.co.uk).** Today
  discovery fails on sites with no `<link rel="alternate">` and no
  well-known `/feed`/`/rss` path. Two paths considered:

  - **[RSSHub](https://docs.rsshub.app/) (community-maintained scraper that
    emits RSS).** Open-source Node service with ~1,500 per-site routes
    (Twitter, YouTube channels, lots of news sites, …). Two consumption
    modes:
    - *Public instance* (`rsshub.app`): free, no infra to run, but
      rate-limited and frequently IP-blocked by upstream publishers; the
      single shared IP gets hammered, so reliability is poor. Fine for
      hobby use, not for a reader users depend on.
    - *Self-hosted*: long-running container with in-process cache. The
      existing stack doesn't fit well — Supabase Edge Functions are Deno
      (RSSHub is Node-only); Vercel serverless technically works via
      RSSHub's "Vercel mode" but the project itself flags it as
      not-recommended (cold starts kill the cache, ~250 MB bundle bumps
      against Vercel limits, every poll re-scrapes upstream → faster
      blocks). The right shape is a $5/mo container on Fly.io / Railway /
      Render plus Upstash Redis (free tier) for cache/dedup state. Adds
      one more service to monitor; upstream routes break when sites
      redesign, but the *community* wears that maintenance, not us.
    Either way the integration on our side is trivial — RSSHub URLs are
    just RSS, so the existing poller handles them unchanged. Decision is
    "is the operational cost worth the coverage."

  - **DIY user-supplied selector.** Per-feed CSS selector
    (e.g. `article h2 a`) stored on the `feeds` row; the poller fetches
    via the SSRF-hardened helper and emits one item per match (title +
    absolute href, no body — tap opens the publisher externally, same
    path as today's "open original"). Zero extra infra, but fragile:
    every site redesign silently breaks the feed, and the user has to
    re-author the selector. Would need a per-feed "last successful
    parse" health signal and a graceful empty-state in the UI. Lower
    coverage than RSSHub (one site at a time, by hand), but no third
    party in the loop.

  Not mutually exclusive — RSSHub for the long tail of popular sites,
  selector feeds as the always-available fallback. Revisit when a user
  asks for a no-feed site we care about.

## Fetching / robots.txt

- **Consider honoring robots.txt on the poller and/or discovery fetches.**
  Today only the full-text reading-mode fetch consults robots.txt
  (`supabase/functions/_shared/robots.ts`, wired into `fulltext/index.ts`; see
  SPEC.md §"Full-text reading mode" and PR #271). The poller and `/discover`
  were deliberately left ungated — a subscribed feed URL is published *for*
  syndication, and discovery is a one-time, explicitly user-pasted URL — but
  whether to extend robots honoring to them is worth revisiting. Open
  questions / tradeoffs:
  - **Poller:** the recurring automated crawl is the most "crawler-like" path,
    so it's the strongest candidate for politeness. Risk: a publisher blanket
    `Disallow: /` (common for unknown bots) would park a feed the user
    explicitly subscribed to — arguably the wrong call for an opt-in feed
    reader. Would also want robots cached per-origin (a robots fetch per feed
    poll is wasteful) and a clear feed-health surface when a feed is parked for
    robots rather than an error.
  - **Discover:** user-initiated and one-shot; gating it could block a feed the
    user is actively trying to add, which is a worse UX than the politeness win.
  - **Shared seam:** if we do gate either, the clean home is a per-hop
    authorization hook in `safeFetch` (the shared SSRF funnel) rather than a
    per-caller re-check — that also closes the redirect-target gap the
    full-text path accepts as a residual today (one GET to a redirected
    disallowed URL before discarding; see the open thread on PR #271). Cons of
    the hook: it touches the shared security module every consumer routes
    through, must avoid re-entrancy (the robots fetch itself goes through
    `safeFetch`), and adds a robots fetch per hop without an origin cache.
  Revisit if a publisher complains, or when we next touch the poller's
  politeness logic (it already honors `Retry-After`/`ttl`).

## Server RPCs

- **DONE (0073): the SQL transcription of the title matcher is gone.** Recorded
  because it reverses a decision this file made, and the reversal is the useful
  part.

  0072 transcribed `src/lib/titleFilter.ts` into SQL so the badge counts and the
  per-feed floor could honor the reader's filters. Its weak seam was
  `title_fold`: JS says `\p{M}`, Postgres has no property classes, so the
  combining-mark ranges were enumerated by hand. Review found FOUR defects in
  that one regex, and the fourth reversed the safety property the first three
  were argued under — a mark the list failed to strip survived into
  `title_tokens`, which split the word at it, so a filter entry equal to one of
  the fragments matched server-side while the client kept the word whole and
  `feed_items` withheld a row the reader would otherwise see. Not confined to
  non-Latin scripts either: a mark can sit between two Latin letters, and
  publisher titles are untrusted.

  0073 stops folding in SQL. `items.title_normalized` holds the folded,
  tokenized, space-wrapped title, computed in Deno by
  `_shared/titleFilterCore.ts` — a byte-identical copy of the client module,
  enforced by a test — and SQL does nothing but ASCII-delimited `strpos`. The
  over-filtering direction closes by construction: there is no tokenizer left to
  split a word at a character it doesn't recognize.

  *Why this was previously rejected, and what changed.* An earlier entry costed
  this design and turned it down: a materialized column, a version, a converging
  backfill, an index, a compare-and-swap, a SECOND backlog with its own epoch to
  repair non-canonical stored filter entries, a compatibility window for
  service-worker-cached clients, and a server-to-client signal that doesn't
  exist. That costing was accurate and almost all of it was MIGRATION cost —
  machinery to protect live users and live data. The feature had no users yet, so
  the owner set that constraint aside and the cost collapsed to the column, the
  version, one bounded pass and one CAS. Worth keeping as a pattern: most of what
  made that design expensive was compatibility, not design, and "is anyone
  actually on this yet" was the question that resolved it.

  *What survives.* `normalize()` and the `\p{M}` tables come from each runtime's
  own Unicode data, so a Deno upgrade or an old browser engine can still fold
  differently with no source change — the byte-identity test pins the SOURCE, not
  the behavior. `title_normalized_version` exists for that: bump the constant and
  the poller's pass re-derives every row. Closing the residue entirely needs
  pinned Unicode on both sides, which isn't worth it. Note a compatibility
  window would NOT close it — a window sheds old app code, and the disagreement
  is in the engine beneath it.

  *A limitation now asserted rather than assumed.* Whole-word matching needs word
  boundaries, so in a script written without spaces a filter only matches a
  headline it spans entirely. 0072's SQL corpus claimed otherwise (`がく` matching
  `がくの話`); that file needs a live `psql` and CI never runs it, so the claim was
  never executed. It was wrong on both sides and always had been —
  `titleFilterCore.test.ts` now pins the real behavior.

- **Server-side subscription-scoped feed RPC for very large libraries.** Home/
  folder reads use `.in('feed_id', feedIds)`; a user with hundreds of
  subscriptions could exceed request-line limits. The scalable fix is the
  server-side subscription-scoped feed join (the `feed_items` RPC already covers
  the paged path). See `SupabaseDataSource.feedView` and SPEC.md §Data.

- **`feed_unread_ids` RPC for exact section badges.** The per-feed unread badge
  reads `getFeedUnreadCounts` (a server-only *count*), so it lags local triage by
  a sync round-trip. The client reconciles this with `UnreadDecrementLedger`
  (`src/lib/unreadAdjust.ts`): a dismissal's decrement applies immediately and
  holds until a count response that provably reflects the synced write lands, so
  the flicker at sync-completion (the badge bouncing to the stale count between
  outbox drain and count refetch — Codex P2 threads on PR #194) is gone. What
  remains approximate: a pinned-then-read row later marked Done lags until its
  write syncs (the conservative predicate can't tell it was server-counted); an
  Undo *after* the dismissal synced under-counts for one round-trip in the other
  direction; and a count fetch that starts pre-drain but is evaluated post-commit
  server-side double-discounts its item (badge one low) until the drain-triggered
  refetch lands — a bare count can't reveal whether it includes a given write. The exact fix is a `feed_unread_ids` RPC returning the
  per-feed unread **ID list** (~tens of KB; the listable set is already capped
  under the PostgREST row limit): the client holds the unread set and mutates it
  atomically with triage, so the badge is exact with no approximation at all.
  Backend migration + manual `make migrate`/`make deploy`; keep the client
  tolerant of the count-only backend until it lands. See SPEC.md §"Per-feed
  unread count" and PR #194.

## newshacker mirror

- **Event-driven newshacker → Readmo push (webhook + Realtime).** Deliberately
  deferred (2026-07): with newshacker's flush-on-hide upload and the cheap
  set-based reverse pull on every focus/PTR, pull-on-focus covers the
  single-device flow — staleness is only observable when the user looks at
  Readmo, which is exactly what triggers the pull. The two gaps pull can't
  close, and what each half buys if they ever matter: (1) *the handoff race*
  (return-focus pull vs newshacker's just-flushed upload) — mitigated by the
  PR #496 retry ladder; fully removed only by a webhook from newshacker's
  `/api/sync` POST handler to a new Readmo Edge Function (auth: the same
  linked bearer token; best-effort, the pull stays the reconciler);
  (2) *two screens visible at once* (Readmo already open + focused while
  triaging on newshacker elsewhere — no focus event ever fires) — needs
  Supabase Realtime on `item_state` (free tier: 200 concurrent connections,
  2M messages/mo — family-scale is nothing), which also gives
  Readmo↔Readmo cross-device instant updates on its own and is the half to
  build first. Rejected shape: a long-poll/pubsub endpoint on newshacker —
  Readmo's client can't hold the newshacker token (server-only by design),
  and Supabase Realtime already is the pubsub.

## Server / batch query limits

- **Decide whether `service_role` (poll / refresh / import batch) needs an
  explicit query ceiling.** `0013_user_query_statement_timeout.sql` caps
  `statement_timeout` for *user-initiated* queries (`authenticated` 5 s, `anon`
  3 s) but does not change `service_role`. That does **not** leave batch work
  unbounded: an unset `service_role` timeout inherits the `authenticator`
  default (8 s per Supabase's
  [timeouts docs](https://supabase.com/docs/guides/database/postgres/timeouts)),
  so a batch statement running past ~8 s is already canceled — possibly aborting
  a legitimately long feed sync mid-batch. So the real decision is whether 8 s is
  the right batch ceiling, or whether to set `service_role` explicitly (to `0`
  for no limit, or a generous value like 30–60 s) and reload PostgREST. Options
  to weigh:
    - A *generous* `service_role` statement_timeout (e.g. 30–60 s) as a safety
      net for truly-stuck queries, set well above any healthy batch.
    - Per-operation `SET LOCAL statement_timeout` inside the function around the
      known-heavy statements (the item upserts), leaving the role default unset.
    - Rely on the bounds that already exist: the poller chunks ~25 feeds/run,
      `safeFetch` caps each upstream fetch at 10 s, and Edge Functions have a
      platform wall-clock limit — so total batch time is already loosely bounded.
  Not urgent: batch volume is small today and the fetch timeout covers the common
  stall. Revisit if a stuck batch query is ever seen pinning a connection. See
  `0013_user_query_statement_timeout.sql` and SCALING.md.

## UI / layout


- **`ItemRowMenu`'s popover items are 36px tall, below the 44px touch floor
  guardrail 2 requires — app-wide, not just one call site.** Found via Codex
  on PR #660 (reader Filter…), but verified pre-existing: `popover = open &&
  !!anchorEl` is the component's only sheet/popover switch
  (`ItemRowMenu.tsx`), and every current caller — `ItemRow.tsx`'s own
  long-press/context-menu `openMenu` (`setMenuAnchor(articleRef.current)`,
  twice), the reader's More button, both admin pages — always passes a
  non-null anchor, so `.item-menu__sheet--popover .item-menu__item`
  (`min-height: 36px`, `ItemRowMenu.css:88-91`) is what every row/reader menu
  item actually renders at today, list rows included. The component's own
  header comment ("popover on pointer devices, bottom-sheet fallback on
  touch") describes intent nothing currently wires up — `usePointerDevice()`
  exists and is imported in `ItemRow.tsx`, but nothing feeds it into
  `anchorEl` selection anywhere. Fix: at each call site, pass `null` on touch
  (→ sheet, 44px) and the real anchor on a pointer device (→ compact
  popover), rather than patching one call site and leaving the rest
  inconsistent.

- **Reader tags (PR #657) should filter out generic categories like "News"/
  "news".** A publisher category that's just the section name of the whole
  feed ("News") carries no real information and clutters the first-few-tags
  row under the byline. Needs a small stoplist (case-insensitive) applied in
  `ItemPage.tsx` before slicing to `MAX_READER_TAGS` — deliberately not done
  in #657, which only added the display.

- **Filter candidates: a single Han character (CJK) is never offered, even
  though it's routinely a complete word.** Found while scoping PR #656's
  single-ASCII-character suppression (`isSingleAsciiChar` in
  `lib/titleFilter.ts`) — that fix is deliberately ASCII-only and doesn't
  touch this. The actual blocker is different and pre-existing: a Han
  character (e.g. "水" = water) never matches `\p{Lu}` (no case distinction in
  that script), so it never reaches the capitalized-run tier 1 at all, and
  falls to tier 2 where `MIN_CANDIDATE_LENGTH = 3` drops it for being too
  short — a floor sized for Latin-script abbreviations, not CJK, where most
  words are 1-2 characters. Net effect: the row-menu Filter… candidate list is
  close to useless for a CJK-language headline today. Needs a real fix
  (script-aware minimum length, or a different candidate-extraction strategy
  entirely for scripts without word-breaking spaces) rather than another
  special case bolted onto the Latin-oriented heuristics here.

- **Category filters are unified with title filters — one list, not two.**
  Shipped: an article's own `categories[]` feed the SAME filter list as typed
  title words (`lib/titleFilter.ts`'s `titleIsFiltered` + the new
  `categoriesAreFiltered`, `useTitleFilters().addTitleFilter`) — tapping a
  category in a row's Filter… menu (offered first, ahead of title-word
  candidates) folds it exactly the way a typed word is folded and adds it to
  `title_filters`. There is deliberately no second stored list, no second
  Settings chip kind, and no way to tell a category-added entry apart from a
  typed one once it's in the list — an earlier version of this feature did
  ship a separate `category_filters` column (migration 0076) with exact-string
  category matching, but it was replaced with this unified design before that
  migration was ever deployed (see PR #655's history if the "why not both"
  question comes up again).
  - **Punctuation-preserving matching: done.** `titleFilterCore.ts`'s
    `tokenize()` keeps `.`, `+` and `#` as word characters instead of
    stripping them (`.NET`, `C++`, `C#` now match as themselves, not the
    over-broad "net"/"c"/"c"); `.` still ends a word normally when nothing but
    whitespace or the string's end follows it, so an ordinary sentence-ending
    period is unaffected. Bumped `TITLE_NORMALIZED_VERSION` to 2 — the
    poller's backfill re-normalizes existing rows over a few polls, no
    migration needed. `filterCandidates` (`lib/titleFilter.ts`) offers a
    punctuated title term as its own candidate the same way, and a bare
    single-character candidate ("C" alone) is no longer offered — never a
    useful filter on its own. Apostrophe handling is untouched: `Trump's` →
    `Trump` still works exactly as before, via the unrelated existing
    display-stripping in `titleWords()`.
  - **Still missing: server-side enforcement for a category-only match.** A
    title-word match is already enforced server-side (the RPC reads
    `title_filters` against `items.title_normalized`); an article that matches
    only via its category (not literally in the title) is filtered client-side
    only — it still counts toward a feed's unread badge and can still occupy a
    per-feed floor slot. Needs the server-side matcher extended to also check
    `items.categories` against `title_filters`, not just the title.
  - **Per-feed scope — open question, may not be needed.** Filters (both
    title- and category-sourced) are account-wide across every feed. Raised
    as a possible follow-up but not clearly worth the complexity — revisit
    only if global scope turns out to be too broad in practice.

- **Filter by author, too.** The meta row's fallback slot is domain, else
  category, else author (`formatItemMetaTail` — see `lib/itemMeta.ts`), so the
  author still surfaces on a row with neither. An eventual author-based filter
  (parallel to the existing title filters) was raised alongside the category
  work but not designed or scoped.

- **Try omitting the feed name from list rows in group-by-feed view.** The
  section header already names the feed once per group, so the row's own
  `source` segment (`ItemRow`'s `showSource` prop, already built and tested)
  is arguably redundant there — the same reasoning `showRowFavicon` already
  acts on (off in grouped view, on in non-grouped). Tried and reverted once
  (kept for now, per feedback) because it wasn't clear the row read well with
  nothing before the domain/category/author fallback slot in a bare case
  (`4h` alone). `ItemRows.tsx` has the wiring commented at the `showRowFavicon`
  computation — flip it back to `showSource={!groupHeaders}` to retry.

- **Show more than the first category on the reader (article) view.** The list
  row shows only `item.categories[0]` (row space is tight — guardrail #2), but
  the reader header has room for more; the request was to show the first 5-6,
  possibly as its own meta row rather than folded into the existing author ·
  date · domain line. Deliberately deferred to a separate PR from the initial
  category-storage/list-row work (migration 0075).

- **A library view still claims to be empty before the first item-state
  hydrate.** The remaining finding from the loading-placeholder audit that shut
  down the persisted-cache restore flash. `useStateBucket` reads the item-state
  store, which loads from localStorage *synchronously*, so on a device that has
  synced before the buckets are right at first paint. On a device that hasn't —
  a new browser, a cleared profile, a fresh sign-in — they're empty until the
  server hydrate lands, and `/pinned` says "Your reading list is empty. Pin
  items to read later." to a reader whose list is full. Same lie as the feed's
  caught-up flash, but a different mechanism: it's the item-state store, not
  React Query, so `useIsRestoring` doesn't see it and the fix isn't the same
  one. Two things need deciding before it can be written: the store exposes
  `subscribeHydrated` (which fires per map-changing hydrate and has no consumer
  today) but no *first-hydrate-done* flag, and whatever flag replaces it has to
  settle for the cases where a hydrate never comes at all — mock mode, a signed-
  out reader, a failed read — or the empty label just becomes a permanent
  spinner, which is the worse lie. See SPEC *No view answers for a read it
  hasn't done*.

- **Consider upping the tap targets and/or the min row height to match
  newshacker's density.** readmo currently keys the list row body's `min-height`
  to the bare `--rm-tap: 44px` touch floor (`ItemRow.css`), so a non-wrapping
  row is `44 + 12px` padding = **56px** (see the hard-coded skeleton height in
  `ItemList.css`). newshacker instead sets story rows to **48px** above the same
  44px touch floor (`--tap-min: 48px`), making its rows `48 + 12` = **60px**.
  Net effect: on the same viewport readmo packs ~7% more rows (~18.3 vs ~17),
  which reads as more cramped — counter to guardrail #9 ("match newshacker's UX
  by default"). Two ways to close the gap: (a) give `.item-row__body` its own
  `min-height: 48px` (and bump the `56px` skeleton to `60px`) while keeping
  `--rm-tap: 44px` as the genuine touch floor for buttons — targeted, doesn't
  inflate other controls; or (b) raise `--rm-tap` to 48px, which also enlarges
  every pin button / control keyed off it. Lean toward (a). Update `SPEC.md`'s
  story-row layout section in the same commit.

- **Promote a locally-pinned row the refreshed grouped read dropped
  entirely.** In the group-by-feed windowed view, PR #418 makes `mergedRaw`
  fill each section pinned-first over the whole *base run* (`items[]`), so a
  pin sitting outside the sticky window still renders. That covers the common
  case (the pin is in the read but past the window). It does **not** cover the
  live-path edge Codex flagged (#418 review, `discussion_r3539240069`): a row
  pinned **this session, before the outbox syncs the pin**, in a **busy** feed
  (≥ `PER_FEED_WINDOW+1` newer non-dismissed rows). There, the server
  `feed_items` read caps each feed to its newest N by date and — because the
  pin isn't server-side yet, so the "pinned, any age" branch (`0031` branch c)
  doesn't rescue it — the pinned older row is absent from `items[]` altogether;
  `SupabaseDataSource` overlays local *state* onto returned rows but can't
  re-insert an absent one. The pinned-first pass scans only `baseRun`, never
  `rowCacheRef`, so the row (still pinned in the local store, and cached from
  before the refresh) is dropped and its section can collapse to a phantom
  "More" until the next focus/resync re-pulls with the pin synced. Not the
  reported bug (that feed was sparse, so the pin was in the read). Fix options
  weighed: (a) **flush the outbox and await pending pins before PTR refetches**
  so the server returns the pin via branch c — cleanest, but adds PTR latency
  and changes the refresh contract (risk when offline); (b) **promote
  locally-pinned rows from `rowCacheRef` that the server dropped** — client-
  only, no latency, but carries a resurrection tradeoff (a pin genuinely
  removed on another device could linger until sync) and is more invasive to
  the windowing. Lean toward (a). See the code comment on the pinned-first pass
  in `ItemList.tsx`.

- **Consider scrolling the feed in an inner container to retire the
  dynamic-toolbar scroll-jump machinery.** The feed currently scrolls the
  *window*, so the reader's max scroll depends on `window.innerHeight` — the
  exact value Chromium's mobile dynamic toolbar momentarily doubles, which
  clamps `scrollY` and produces the bottom-of-list "scroll jump." A large
  subsystem in `ItemList.tsx` exists only to survive that: the min-height
  freeze, spike detection (`viewportIsHonest`/`layoutViewportHeight`), the
  spike-safe deferred hold + `deviceSpikesRef` latch, and the reactive restore
  (settle watch). If the feed instead scrolled inside its own
  `overflow-y: auto` region sized off a *stable* height (not the buggy viewport
  metric), the `innerHeight` spike wouldn't reach it and most of that code
  could be deleted. Cost: it loses native mobile URL-bar auto-hide and diverges
  from newshacker's window-scroll (guardrail #9), so it needs a real
  spike/experiment and a UX call, not a drive-by change. Raised while hardening
  the window-scroll path (PRs #405/#406). Weigh against option of just keeping
  the current, now-well-tested mechanism.

## Infrastructure / hosting

- **Consider consolidating the frontend onto Cloudflare (Vercel → CF Pages).**
  Once the Cloudflare gateway (`infra/cf-gateway/`) is in the picture, we
  considered moving the rest of the front end off Vercel too — the SPA bundle to
  **Cloudflare Pages** and the one Vercel function (`api/img.ts`) to a Worker —
  to drop a platform and the Vercel Pro (~$20/mo). The move would be *small*
  because Vercel does very little here: it serves the static SPA, runs the single
  `api/img.ts` image shim, and supplies the `VERCEL_*` build-env vars; the
  lock-in is minimal. **Decided against it for now** — the **GitHub PR preview
  DX** (the `vercel[bot]` preview deployments + inspector) is valued, and CF
  Pages' previews, while real, are less polished. The blocker is DX preference,
  not feasibility.

  If revisited, the move is roughly: SPA → CF Pages (the `vercel.json` SPA
  rewrite becomes a `_redirects` / `_routes.json` rule); `api/img.ts` → a Worker
  or Pages Function (or fold it into the gateway Worker, which already proxies
  `/functions/`); and `vite.config.ts` must accept CF Pages' build-env vars
  (`CF_PAGES`, `CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`) in place of `VERCEL_*`
  **and re-gate the production poison-pill guard** (currently
  `VERCEL_ENV === 'production'`) on CF Pages' "is production" signal, or it would
  silently never fire. Revisit if the Vercel preview DX stops mattering, if CF
  Pages previews improve, or to cut the Vercel Pro cost. (Moving the *backend* —
  Postgres / Auth / RLS / Edge Functions — off Supabase is a separate, much
  larger re-platforming and is **not** what this is about.)

## Allowlist / gating

- **Close the direct-RPC Google News bypass.** `discover` is the authoritative
  Google News gate (real `new URL()` — see `_shared/googleNews.ts`), and it
  covers every normal subscribe path (Add-a-feed, OPML, curated catalog). The
  one remaining bypass is a *hand-crafted* direct `subscribe_to_feed(...)` RPC
  call with a Google News URL by a non-allowlisted caller while the allowlist is
  armed. An earlier attempt gated this **in SQL** inside `subscribe_to_feed`, but
  matching "is this Google News" requires real WHATWG/IDNA URL canonicalization
  (percent-encoding, control/space stripping, slash/backslash, Unicode dots, …)
  which a Postgres regex can't faithfully replicate — it turned into an unbounded
  series of normalization edge cases, so the SQL gate was removed. The correct
  fix is to do the canonical check in an **Edge layer** (where `new URL()`
  exists): e.g. route subscribes through a thin Edge function that canonicalizes
  + checks the allowlist before calling the RPC, or have the poller refuse to
  fetch a Google News feed for a feed with no allowlisted subscriber. Low
  priority — `discover` already covers the UI, and an empty allowlist is open to
  all. See `supabase/migrations/0028_allowlist_admin.sql` and SPEC *Feed
  discovery*.


## Merge gates

- [ ] **Enable auto-merge and arm it on the weekly dependency PR.** The
  repository setting is off (Settings → General → Pull Requests → Allow
  auto-merge), and unlike gedmap the weekly `npm-update.yml` never
  runs `gh pr merge --auto --rebase` after opening its PR. The ruleset
  already does the reviewing — CI, the `codex` status, conversation
  resolution — so arming can only remove toil: a green weekly batch
  currently waits for a manual merge that the gates have already earned.
  One constraint gedmap's arming block does not carry: this repository
  excludes pre-1.0 (`0.x`) packages from auto-merge — SemVer permits
  breaking changes in a 0.x minor — so the arming step must first classify
  the batch's direct moves (the publish job's deps-summary.md already
  names them) and skip arming when any moved package is pre-1.0, leaving
  that batch for review. Add the workflow-test assertion alongside, and
  keep the arming deliberately non-fatal like gedmap's.
- Add an AGPL license gate to `ci.yml`: fail if a dependency declares an AGPL
  license, catching one added by hand in a normal PR, not just ones the
  weekly bot bumps. Likely `license-checker-rseidelsohn`. GPL/LGPL undecided,
  matching typelauncher#632. Independent of `npm-update`. Covers the Node
  app only — `edge`'s Deno functions have no `package.json`/lockfile for an
  npm tool to read, needs its own answer, not investigated. Work out
  placement and gate/lanes wiring when actually building this.
- [ ] **Make `zizmor` a required check, not just advisory.** #651 retired
  the hand-rolled "no expression is spliced into a run: script" test in
  `npm-update.test.ts` in favor of zizmor's `template-injection` audit —
  correctly, since the regex missed real cases across six separate rounds
  and zizmor catches them natively — but `.github/workflows/zizmor.yml`
  is still advisory/non-blocking today, so until it's a required status
  check, a future regression of that shape would only turn the
  (non-blocking) zizmor job red, not `npm test` or any required gate. Same
  gap flagged by Codex on the identical change in newshacker#532; recorded
  here too rather than waiting for the same finding to repeat.
  - [x] ~~First, widen the trigger.~~ Done — `zizmor.yml`'s `paths:
        ['.github/**']` filter is gone from both triggers (it blocked making
        the check required: GitHub leaves a required check pending, not
        passing, when its workflow is skipped by a path filter, so any PR
        touching `src/`, `supabase/`, or anything outside `.github/` would
        have become permanently unmergeable), and `pull_request` now lists
        its types explicitly, `edited` included. Same fix still needed in
        newshacker, homepage, gedmap, and web's identical copies.
  - [ ] **Also first: a dispatch route for the weekly dependency PR**
        (Codex flagged this on the identical gedmap and newshacker
        changes). The batch PR is authored with `GITHUB_TOKEN`, whose
        events start no workflows — the same trap the batch's explicit
        ci.yml and codex-review-check dispatches exist for — so a required
        `zizmor` would block every weekly batch forever. Before the flip,
        give zizmor.yml a `workflow_dispatch` trigger and teach
        mikelward/npm-update's reusable workflow to dispatch it alongside
        ci.yml — a shared-mechanism change that lands in that repository,
        piloted through one consumer per its conventions.
  - [ ] Then: `repo-rules mikelward/readmo` (now defaults to `lanes codex
        zizmor`) once zizmor has reported on a `pull_request` run here —
        outside what a session without ruleset API access can do.
