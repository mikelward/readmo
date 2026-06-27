# Readmo — SPEC

> **Paste-ready spec for a new app.** **Readmo** is a mobile-first RSS/Atom
> reader PWA that reuses *newshacker*'s UX **as-is** — same row layout, same
> tap-target discipline, the **same Pinned / Favorite / Done / Hidden /
> Opened model**, same swipe gestures, same library views, same Sweep/Undo,
> same offline/PWA behavior. The **only** intended differences are the data
> source (your RSS subscriptions instead of Hacker News) and the plumbing
> that requires (server-side fetch/parse + accounts + sync). Where this says
> "same as newshacker," it means *copy that behavior*, not reinterpret it.
> Read this alongside newshacker's `SPEC.md`; this document calls out only
> where Readmo must differ and why.

---

## Overview

**Readmo** is a mobile-friendly, installable reader for the RSS/Atom/JSON
feeds you subscribe to. You add feeds, Readmo polls them on the server, and
you triage articles with the **exact newshacker interaction model**: a clean
chronological feed with **Pinned** items at the top, fading **Opened**
titles, swipe to **Done** (dismiss), **Pin** to keep in your reading list, **Favorite**
to keep forever, **Done** to complete — synced across devices and readable
offline.

- Primary domain: **readmo.app**.
- Stack: **React + TypeScript + Vite**, frontend on **Vercel** (same as
  newshacker).
- Backend: **Supabase** — Postgres (data), Auth (social OAuth), Row-Level
  Security (per-user isolation), and scheduled Edge Functions (feed polling).
  Feed fetching/parsing runs in serverless functions, never the browser
  (CORS forbids cross-origin feed fetches).
- **No AI features in MVP.** RSS items usually carry full content; we don't
  summarize. (Deferred — would reuse newshacker's Gemini/Jina caching path.)

Readmo is independent and not affiliated with any feed publisher; it renders
publishers' own syndicated content and always links back to the original.

## What is identical to newshacker (do not redesign)

The following are inherited **verbatim in behavior** — only the data behind
them changes. Treat newshacker's `SPEC.md` as the normative description and
copy it:

- **Story/item row layout** — at most three tap zones, two shipped (row body
  stretched link + right-side icon button), reserved middle slot. Min 44×44px
  touch targets, ≥8px gaps, 48px+ rows, pressed-state on every zone, metadata
  display-only.
- **Pinned / Favorite / Done — three intents, three buckets**, plus **Hidden**
  and **Opened**, with the same semantics and the same shields. Retention
  diverges: only Pinned/Favorite persist forever, Done/Opened are 30-day views,
  and a **3-day feed freshness window** drops old items (Pinned exempt). See
  *Item state model* below.
- **Pinned prepended to the top of every feed**, rendered once, oldest-pinned
  first; pinning a body row keeps its position; **Sweep** consolidates.
- **Swipe gestures** — swipe-right = Done (dismiss), swipe-left = Pin,
  rubber-band shields with outcome labels.
- **Library views** — `/pinned`, `/favorites`, `/done`, `/opened`,
  reusing the feed row with the right-side button swapped to the view's
  inverse action. (No `/hidden` route — dismissal goes directly to Done.)
- **List toolbar** (sticky Undo + Sweep) and **bottom action bar**
  (Back-to-top + More + Undo + Sweep).
- **Thread/reader action bar** discipline, **pull-to-refresh**, **keyboard
  shortcuts**, **header account chip**, **offline pill**, **/offline** view.
- **PWA install identity, service worker (`autoUpdate` + PTR update-check),
  caching strategy, persisted query cache, offline UX** — same shapes.

## What necessarily differs from newshacker (and why)

1. **Data source: your RSS subscriptions, not Hacker News.** The "feed" is
   the chronological merge of items from the feeds you subscribe to, newest
   first — wherever newshacker says "Top/New/Best/Ask/Show/Jobs," Readmo
   substitutes "your subscriptions / a folder / a single feed."
2. **Server-side fetch + accounts + sync.** RSS origins don't send CORS
   headers, so feeds are fetched/parsed server-side; per-user subscriptions
   and item state live in Postgres and sync across devices. newshacker was
   stateless (HN's API is public); Readmo owns a backend.
3. **No comments, no votes.** RSS items have neither. So: no comment thread,
   no comment-summary card, no "N new comments" badge, no Upvote/Downvote in
   the action bar. The "thread page" becomes the **reader view** (the article
   itself). Everything else on that page (Open original, Pin, Done, Favorite,
   Share, More) is unchanged.
4. **AI summaries off** (see Overview).

Everything not in this list should match newshacker.

## Language & spelling

**US English everywhere** — copy, identifiers, CSS class names, storage keys
(now DB column names), comments, docs (e.g. *favorite*, *color*). Same as
newshacker.

## Visual design

Ink on paper (monochrome) — a calm, soft-charcoal accent on warm paper rather
than a colored hue (charcoal, not pure black, so larger ink fills — the brand
tile, the primary button — read softer than the near-black body text). The ink accent clears 4.5:1 on the paper background so it
can be used for links and the primary button, not just as a glyph backdrop.
Everything else about the visual system mirrors newshacker.

- **Accent / primary:** ink `--rm-accent: #363636` (light) / `#ececec` (dark)
  — focus rings, links, active library icons, the brand wordmark, and the
  primary "Open original" button (an accent-tinted fill with an accent-colored
  icon — emphasized without a heavy solid block).
  Links also carry an underline so they remain distinguishable without a hue.
  Verify the final values clear 4.5:1 on both light and dark.
- **Background:** warm off-white paper `--rm-bg: #faf9f5`; white
  `--rm-bg-card: #ffffff` for rows/cards.
- **Text:** `--rm-text: #1a1a1a`; **opened/read titles** `--rm-read: #4a4a4a`
  (mid-tone below unopened, above meta); meta `--rm-meta: #6b6b6b`. The
  opened-title fade is the same read/unread treatment newshacker uses (color
  gap + weight step), identical in light and dark. Unread titles render at
  **weight 500**, read titles at **400** — the weight step only reads if the
  active typeface actually ships a 500 (Medium) face, which is why the
  default font is a self-hosted webfont rather than the system stack (see
  *Typeface* below).
- **Typeface:** the body font is a **self-hosted webfont** (Fontsource,
  bundled into the app and served same-origin — no Google Fonts CDN, no
  third-party request) so the app renders identically on every platform
  instead of substituting whatever fonts the OS happens to have. This also
  guarantees the unread/read weight step works everywhere: Linux system
  fonts (DejaVu Sans, Liberation Sans) ship only 400/700, so a system-stack
  500 silently collapsed to 400 and unread titles stopped looking unread.
  The **Font** picker in Settings offers **Roboto (default)**, Inter, Public
  Sans, Work Sans, Fira Sans, and **System** (opt back into the native
  stack). Variable (weight-axis) files where available; Fira Sans ships
  static weights. Stored under `readmo:font` (default `roboto` owns the bare
  `:root` and stores nothing; others set `data-font` on `<html>`), applied
  before first paint in `main.tsx` alongside theme/palette/text-size. Each
  `@font-face` only fetches when its family is actually rendered, so a normal
  page loads just the active font; the Settings picker — which previews every
  option in its own face — is the only screen that loads all of them. Font
  woff2 is runtime-cached by the service worker (`readmo-fonts`, cache-on-use)
  so the active font survives offline.
- **Mark:** ink (near-black) rounded-square tile, paper-white uppercase
  **"R"** letterform centered slightly above the midline, paper-white
  **home-indicator pill** near the bottom (the letter-mark + mobile-first
  motif, in our ink-on-paper palette). The same mark renders inline before
  the **readmo** wordmark in the app header. Generate the icon set once
  (`scripts/generate-icons.mjs`) into `public/`.
- **App header layout:** three slots in a single sticky row. The drawer
  toggle is pinned to the viewport's left edge and the account chip to the
  viewport's right edge so both stay reachable at any width; the centered
  inner (brand mark + wordmark, Offline pill, Search, Settings) tracks the
  article column max-width — 720px, widening toward 860px on roomy screens
  (from ≥960px, the same breakpoint that widens `.app-main`) — so it aligns
  with the list below. Because the inner shares the row with the
  absolutely-positioned edge controls, the desktop widen is clamped to
  reserve ~100px of gutter per side (so the signed-out "Sign in" chip never
  overlaps the Settings target); the inner reaches the full column-aligned
  860px once the viewport clears ~1060px. Safe-area
  insets reserve space for landscape-iPhone notches on the edge controls.
- **Navigation drawer sections:** Home (feed picker — All subscriptions or a folder), Library (Pinned / Favorites / Done / Opened / Offline), Folders (folder nav, hidden when none exist), Feeds (subscription list), Appearance (mode + palette + text-size segmented controls), App (Settings, Debug).
- **Dark mode:** full light/dark/system via tokens.
- **Palette:** two color families selectable in the drawer's Appearance section (and also in Settings), orthogonal to the
  light/dark/**mode** axis — **Ink** (default, the monochrome ink-on-paper above)
  and **Grape** (a vivid violet: grape accent
  `--rm-accent: #6d2c91` light / `#cba6ed` dark on faintly grape-tinted paper);
  both clear 4.5:1. Mode drives
  the `data-theme` attribute, palette drives `data-palette`; each palette ships
  its own light and dark variants. The brand mark's tile follows the palette
  (near-black ink tile by default, deep grape under Grape) via the
  `--rm-brand-tile` / `--rm-brand-fg` tokens; the non-ink palette freezes the
  tile to its deep accent across both modes for recognizability.
  In the drawer the palette picker renders each option as a two-tone color
  **swatch** (paper background + accent, split on the diagonal) rather than a
  text label, with the active palette's swatch ringed, laid out in a single
  flex row (matching the mode row of three above it, within the per-row
  tap-zone cap); Settings keeps the text buttons.
- **Text size:** a third orthogonal appearance axis with three steps — Small
  (15px), Medium (16px, default), Large (17px). Selectable in **two** places:
  Settings ("Text size" section) as text buttons, and the drawer's
  **Appearance** section as a segmented row of capital-**A** glyphs sized
  small/medium/large (the conventional font-size control; accessible name from
  the button's label). The choice drives the `data-font-size` attribute on
  `<html>` (Medium = 16px owns the bare `:root`, no attribute), which maps to
  the `--rm-font-size` token; the token sets the **root** (`html`) font-size so
  the `rem`-based type throughout the UI — including the reader article body —
  scales with it. Both pickers stay at three tap zones, within the per-row cap.
  Persisted in `localStorage` under `readmo:fontSize`, applied before first
  paint (alongside theme/palette) to avoid a flash, and synced across tabs/hook
  instances via the shared `readmo:themeChanged` event.
- Icons inlined monochrome SVG (Material Symbols, `fill="currentColor"`), no
  icon font / runtime request.

CSS gotchas inherited verbatim: wrap painted `:hover` in `@media (hover: hover)`
(keep `:active` outside) to avoid sticky touch-hover; use a `<TooltipButton>`-style
wrapper for interactive buttons; icon-only buttons carry an `aria-label`.

---

## Item state model (Pinned / Favorite / Done / Hidden / Opened)

**This is newshacker's model, unchanged.** Five states per `(user, item)`,
stored server-side and synced. Same intents, same shields, same retention —
the only difference is they're DB columns instead of localStorage keys.

- **Pinned (📌)** — your **active reading list**. Pin from a row (pin button,
  swipe-left, or long-press → Pin). Pins stay until you remove them (explicit
  in, explicit out, no auto-pruning). **Pinned items are prepended to the top
  of every feed** (see *Feed views*). Verb pair Pin / Unpin.
- **Favorite (♥)** — a **permanent keepsake**. Favorite from the **reader
  view** (action bar) — a row-level heart on a feed would add a fourth tap
  target and break the fewer-targets rule. On `/favorites` the row's
  right-side slot carries a filled heart that unfavorites. Never swept, never
  expired.
- **Done (✓)** — your **completion log** and the **dismiss action**. Mark done
  from the row menu, swipe-right, or the reader view action bar; on `/done` the
  row carries a filled check that unmarks done. Marking Done also **unpins**
  (Pin is the queue, Done is where items go when they leave it; mutually
  exclusive). Done items are filtered out of every feed, and the `/done`
  completion log is a **30-day** history (see *Retention*). `done` is the **one
  dismiss concept**: the `hidden` DB column is retained for backward compat but
  the UI routes all dismissals through `done`, and legacy `hidden=true` rows are
  migrated to `done=true` on first load.
- **Opened** — auto, set when you open an item. Fades the title (`--rm-read`),
  shows on `/opened` (**30-day** history). "Mark unread" in the row menu clears it.
  (newshacker's "N new comments" badge does **not** apply — RSS items don't
  accrue comments — so the opened entry stores only the open timestamp.)

**Shields (identical to newshacker):**

- **Pin shields against every swipe.** On a pinned row both swipe directions
  are suppressed (swipe-right Done and swipe-left Pin — the latter because
  re-pinning would re-stamp the timestamp and reorder the pinned list). The
  row-menu "Done" item is hidden on pinned rows. A pinned item leaves the list
  only via **Done** (normal lifecycle, also unpins) or **Unpin** (explicit).
- **Suppressed swipes rubber-band, don't silently absorb** — the row tracks
  the finger and snaps back; the revealed edge label names the outcome
  (`Pinned` on both edges of a pinned row; otherwise `Done` / `Pin`). Same
  `useSwipeToDismiss` fall-through-to-`setOffset(0)` mechanism.
- **Dismissal swipes hold off-screen until the data layer drops the row.**
  Because the feed list is paginated via React Query and the refetch that
  removes a Done row takes a tick, the swipe-right exit animation keeps the
  row translated off-screen + opacity 0 after `handleHide` fires instead of
  resetting to rest. Otherwise the row would visibly snap back into place
  during the async unmount window and flash before disappearing. Swipe-left
  Pin still snaps back (the row stays mounted and reflows to the top).
- **The feed view filters Done/Hidden client-side, in addition to the
  DataSource's fetch-time filter.** The DataSource always returns clean
  pages, but a local mutation (single-row swipe, Sweep) flips the store
  synchronously while the invalidating refetch is still in flight — or may
  fail outright (offline, network error). Without the client-side overlay
  the dismissed row's `<li>` would keep its 56px in the flow while only its
  `<article>` was translated off-screen, leaving an indefinite blank gap.
  `ItemList` subscribes to `ItemStateStore` via `useSyncExternalStore` and
  excludes any item whose `done`/`hidden` flag is set so the row unmounts
  the moment the local state flips. Undo restores the flag and the row
  re-mounts in place.
- **Enforcement at the mutation layer, not just the UI**: pinning removes Done;
  marking Done removes Pinned.

**Retention:** **Favorite and Pinned are permanent** — the only forever-keep
states. **Done, Opened, and the legacy Hidden expire after 30 days** (`TTL_MS`),
collapsing to their default on read (`withRetention`) so `/done` and `/opened`
auto-prune without a background sweep. This is a deliberate divergence from
newshacker, where Done is permanent: in readmo the **feed freshness window**
(below) already drops old items from every list, so a permanent Done would only
ever bloat the completion log. **To *keep* an item, pin it** — pinning is the
sole age-exempt path. (Revisit the 30-day TTL with real usage data.)

> **Note — retention is a *read-time view* concept, not a row delete.**
> `withRetention` collapses an expired flag when state is read; the underlying
> `item_state` row is not deleted. So the RLS visibility exemption keyed on
> `done` (see *RLS*) still holds at the DB layer — a long-dismissed item stays
> *openable*, it just stops appearing in lists.

**Feed freshness window + per-feed floor.** Home, folder, and single-feed list
views serve an item when it is **pinned**, OR **younger than 3 days**
(`HOME_WINDOW_MS`), OR among **its feed's newest 10 non-dismissed items**
(`FEED_FLOOR`). The window declutters a busy feed to "recent only"; the floor
keeps an **infrequently-updated feed from going blank** when nothing it
published is recent — you always see at least its latest handful. Both are knobs
(`HOME_WINDOW_MS` / `FEED_FLOOR`); the server `feed_items` RPC applies the same
3-day interval and a `row_number()`-per-feed floor in its body branch.

- **Pinned items are exempt** from both — a pin keeps an item regardless of age.
- The floor ranks only **non-dismissed** items, so marking one Done frees its
  slot for the next.
- Nothing about *opening* extends the window/floor: an un-pinned item leaves
  once it's both past 3 days and beyond its feed's newest 10 (open it → it's in
  `/opened` for 30 days; want it kept in the feed → pin it).
- **Flat vs. grouped:** in group-by-feed / single-feed views a quiet feed's
  floor items sit at the top of its section; in the flat river they sort to the
  bottom by date (an "older, but here's the latest from quiet feeds" tail).
- **Per-feed unread count.** `getFeedUnreadCounts(feedIds)` (server RPC
  `feed_unread_counts`, mirrored in `MockDataSource`) returns, per feed, how many
  of its **listable** items (the window ∪ floor ∪ pinned set above) are **unread /
  to-do** — not Done or active Hidden, and either **pinned** or not active
  **Opened**. A pinned item always counts (a pin is a to-do, read or not); any
  other item drops out once Opened. It's index-bounded like
  `feed_items`. **Foundation only for now:** the RPC + client method ship here to
  back a planned **group-by-feed section-header unread badge** (so a collapsed
  feed will still show how much it holds unread) — the header *display* lands with
  the grouped-view pagination work, not in this change. (Server-side count, so on
  its own it would lag a just-applied local Sweep/Done until the outbox syncs.
  The badge **display** corrects for this client-side: it discounts loaded rows
  with a still-**pending** write whose current state unambiguously means the
  server still counts them but local triage has removed them — Done/active-Hidden,
  not pinned, not Opened — so a sweep drops the badge immediately. It reads only
  the *current* state, never an inferred server state: the outbox coalesces
  pending writes, so a field's pre-sync value can't be recovered by flipping the
  pending change, and guessing would over-count. The one accepted cost is that a
  pinned-then-read row later marked Done keeps lagging until its write syncs. The
  adjustment self-clears as each write drains — see `adjustUnreadCounts` +
  `DataSource.pendingItemIds`. The mock has no outbox, so its count never lags
  and the adjustment is a no-op. A *count* can't be reconciled atomically with
  local triage, so a sub-second blip survives at sync-completion — the pending id
  drains a round-trip before the invalidated count refetch returns; the exact,
  flicker-free fix is the `feed_unread_ids` ID-list RPC, deferred in
  TODO.md §Server RPCs.)

Rationale: readmo has no upstream ranker (unlike newshacker, whose HN
`top`/`best` lists are already recency-bounded), so an explicit window + floor
gives the same "recent + your pins, and never an empty feed" feel. Cost is
*negligible/negative* — the window bounds the candidate set and the floor is a
bounded per-feed `row_number()` over it (served by `items(feed_id, sort_at
desc)`); no new infra or external calls.

**Cross-device sync:** all five states ride the Postgres `item_state` row and
sync automatically (server is the source of truth — see *Sync*).

**Pinned/Favorite offline warm:** pinning or favoriting an item prefetches its
full content + images into the offline cache so `/pinned` and `/favorites`
work offline — same shape as newshacker's pin/favorite prefetch (see *PWA &
Offline → Prefetch on Pin/Favorite*).

---

## Data & backend architecture

### Why server-side (vs. newshacker's stateless client)

newshacker needed no backend — HN's Firebase API is public, CORS-enabled, and
cacheable, so the client called it directly. RSS origins **do not** send
permissive CORS headers, so the browser can't fetch them. Feed fetch, parse,
and de-dup **must** run server-side, which is also where accounts and sync
live.

### Stack

- **Frontend:** React + TS + Vite on Vercel (same as newshacker).
- **Supabase:** Postgres (all relational data); Auth (social OAuth — Google /
  Discord, Apple deferred, no password storage); Row-Level Security (every per-user
  table gated on `auth.uid()` — the DB-enforced analog of newshacker's
  "fail closed, verify against the source of truth" `/admin` discipline);
  scheduled Edge Functions (`pg_cron` + an Edge Function) for the poller.
- **Serverless feed functions** — fetch/parse/discover; stateless and
  idempotent. (If on Vercel, observe newshacker's `api/` gotchas: inline
  helpers, no cross-`api/` imports — Vercel's bundler drops them at deploy
  time.)

### Schema (sketch)

```
users         (id, oauth_subject, email, created_at, …)               -- Supabase auth
feeds         (id, url UNIQUE, secret_url, site_url, title, etag,
               last_modified, last_fetched_at, next_fetch_at,
               fetch_interval_s, error_count, last_error)             -- shared across users
items         (id, feed_id FK, guid, url, title, author, published_at,
               content_html, summary, full_content_html,
               full_content_fetched_at, enclosures, content_hash,
               created_at,
               sort_at = coalesce(published_at, created_at))          -- shared; UNIQUE(feed_id, guid), UNIQUE(feed_id, url) WHERE url IS NOT NULL
subscriptions (user_id FK, feed_id FK, folder, title_override,
               muted bool, sort, created_at)                         -- user ↔ feed
item_state    (user_id FK, item_id FK,
               pinned bool, pinned_at, favorite bool, favorite_at,
               done bool, done_at, hidden bool, hidden_at,
               opened bool, opened_at, version bigint)               -- PK(user_id,item_id)
folders       (user_id FK, name, sort)
```

- **Feeds and items are shared at the storage layer** (poll each distinct feed
  once regardless of subscriber count) — poll cost scales with *distinct
  feeds*, not users. "Shared storage" does **not** mean "world-readable" (see
  RLS).
- **`item_state` is sparse — one row per item the user has *acted on*, not per
  item that exists.** The poller writes only to shared `items`; it does **not**
  fan out an `item_state` row to every subscriber when a new item arrives
  (that fan-out would make poll/write cost scale with *users × items* and
  contradict the "scales with distinct feeds" claim above). A brand-new item
  therefore has **no** `item_state` row for anyone, which is correct: absence
  of a row means unopened, not-pinned, not-done, not-hidden.
- The hot query is "feed items across a user's subscriptions, newest first,
  paginated, minus Done/Hidden, **inside the freshness window or its feed's
  newest 10**, with Pinned lifted to the top (and Pinned exempt)." Because
  `item_state` is sparse, the feed query **drives from `subscriptions` →
  `items` and LEFT JOINs `item_state`** (on `user_id = auth.uid()`), treating a
  missing row as the default state — so new items surface immediately without
  requiring a pre-inserted state row. The body excludes Done/Hidden and serves
  an item when `items.sort_at > now() - interval '3 days'` **or** it's among its
  feed's newest 10 non-dismissed. To keep that **index-bounded** (never rank a
  feed's full archive), `feed_items` assembles the body from three candidate
  sets — a freshness range scan, a per-feed top-10 `LATERAL … ORDER BY sort_at
  DESC LIMIT 10`, and the pinned partial index — each riding
  `items(feed_id, sort_at desc)`, rather than a `row_number()` over all history.
  Pinned items skip the window/floor;
  the Opened fade reads `COALESCE(is.opened, false)`; Pinned items are
  collected by a separate small query (`item_state.pinned = true` for the user)
  and prepended. Newest-first sorts on `sort_at` (= `coalesce(published_at,
  created_at)`, a stored generated column) so feeds that omit/garble dates still
  surface freshly-fetched items at the top instead of burying them. Index
  `subscriptions(user_id)`, `items(feed_id, sort_at desc)`,
  and `item_state(user_id, item_id)` (plus partial indexes on
  `item_state(user_id) WHERE pinned` / `WHERE done` / `WHERE hidden`) to keep
  the join cheap. A write happens only when the user actually pins/favorites/
  dones/hides/opens something — that's the first time a row is upserted.

### RLS — reads scoped to the caller; `feeds`/`items` are NOT world-readable

- `subscriptions`, `item_state`, `folders`: readable/writable only where
  `user_id = auth.uid()`.
- `feeds` and `items` are physically shared but **must not** be exposed to
  every signed-in user — a feed URL and stored `content_html` are
  user-sensitive whenever a feed is private or tokenized (paid newsletters,
  per-user feed URLs with a secret in the path/query). The policy exposes a
  row only when the caller either **(a)** has a matching `subscriptions` row
  (`EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = feeds.id AND s.user_id = auth.uid())`)
  **or (b)** has a **permanent** item_state row pointing at the item
  (`EXISTS (SELECT 1 FROM item_state st WHERE st.item_id = items.id AND st.user_id = auth.uid() AND (st.pinned OR st.favorite OR st.done))`,
  parent feed by extension). Branch (b) is **required** so unsubscribing
  doesn't orphan kept Pinned/Favorite/Done items pinned against GC. The `done`
  exemption is a *row-access* grant, not a list filter: it keeps a dismissed
  item openable even after it ages out of the feed, and it holds at the DB layer
  because the `item_state` row persists (the 30-day Done TTL is a read-time view
  collapse, not a delete — see *Retention*). Hidden/Opened get no such exemption.
  Enforce via RLS
  predicates or a security-definer view/RPC applying the same test. The poller
  writes with the service role, bypassing RLS.
- **Keep feed secrets out of client-readable metadata.** The fetchable URL may
  embed an auth token: store it in `secret_url`, **never** returned to clients
  (only the poller's service role reads it); expose a display-safe identifier
  (`site_url` / `title` / feed id). De-dup two users who paste the same
  tokenized URL onto one shared `feeds` row keyed by the full URL, token
  server-only.

### Feed fetching & parsing (server)

- Conditional GET with stored `etag`/`last_modified` (`304` is free — bump
  `last_fetched_at`, done).
- Parse RSS 2.0, Atom, RSS 1.0/RDF, JSON Feed into a normalized item shape
  `{ guid, url, title, author, publishedAt, contentHtml, summary, enclosures }`
  (maintained parser, e.g. `fast-xml-parser` + a normalizer).
- **Decode HTML entities in plain-text fields** (`title`, `author`,
  `feedTitle`) before storing. `fast-xml-parser` only resolves the five
  predefined XML entities, so numeric references (`&#8217;`) and HTML named
  entities (`&rsquo;`, `&nbsp;`) — plus the leftover from a double-encoded
  `&amp;#8217;` — would otherwise survive into fields the UI renders as escaped
  plain text and show up literally. `contentHtml` is **not** decoded here: it's
  HTML, where entities are meaningful and the browser decodes them on render.
- **Sanitize** `contentHtml` server-side (DOMPurify/sanitize-html) before
  storing — strip scripts/handlers/disallowed tags, absolutize relative URLs
  against the item URL, force `rel="noopener"`. Never store/serve raw
  publisher HTML.
- De-dup on `(feed_id, guid)` (fall back to `url`, then a content hash);
  compute `content_hash` to detect edits and update in place. **Also dedup on
  `(feed_id, url)` where `url is not null`** — publishers (BBC, …) sometimes
  re-issue the same article URL under a new `<guid>`, which the guid-only key
  doesn't catch. The poller calls the `upsert_feed_items` RPC instead of a
  direct upsert so both unique constraints can resolve atomically: insert with
  `ON CONFLICT (feed_id, guid)` and, on a `(feed_id, url)` `unique_violation`,
  fall back to `UPDATE` (adopting the new guid as the canonical identity).
  Cross-feed dedup — same URL appearing in two distinct subscribed feeds — is
  out of scope here; tracked in `TODO.md`.

### Feed discovery

- **The Settings route is code-split.** It carries the curated popular-feeds
  catalog (`src/lib/popularFeeds.ts`, the app's largest static data blob) and is
  visited rarely, so `/settings` is lazy-loaded as its own chunk on navigation
  rather than baked into the initial bundle; the service worker precaches the
  chunk, so it stays available offline after the first load. If that chunk fails
  to load — a stale content-hashed asset after a deploy, or a network failure
  before precache — `LazyRouteBoundary` reloads the page once to recover, and if
  that still fails it shows a centered recovery state: the message "This page
  couldn't be loaded." above a **Reload** button (≥44px touch target) that
  re-attempts a full reload.
- The Settings **Add a feed** input shows a filtered autocomplete dropdown as
  the user types. Suggestions come from a curated list of popular feeds
  (`src/lib/popularFeeds.ts`); each entry carries a display name, direct feed
  URL, and category. Matching is case-insensitive substring on either the name
  or the feed URL; up to 8 suggestions are shown. Selecting a suggestion fills
  the feed URL directly into the input and bypasses the HTML-discovery step —
  the known feed URL is submitted straight to `subscribe()`. This also avoids
  bot-blocking issues for popular sites whose homepages reject programmatic
  requests (the RSS endpoint itself is almost always accessible). The dropdown
  is keyboard-navigable: ArrowDown/Up move focus, Enter selects, Escape closes.
  When the user subscribes via a curated suggestion, the client always sets the
  subscription's `title_override` to the curated display name — the brand the
  user picked beats whatever the publisher's `<channel>` happens to say (e.g.
  The Economist's `/latest/rss.xml` is literally titled "Latest Updates"). The
  override is per-user and editable from Settings → Subscriptions (see below),
  so users can revert to the publisher's title or pick their own. The curated
  name is captured at the moment the user submits the form, not later, so a
  concurrent autocomplete interaction can't corrupt the override.

- `POST /api/discover { url }` accepts a site or feed URL; for an HTML page,
  parse `<link rel="alternate" type="application/rss+xml|atom+xml|json">` and
  common fallbacks (`/feed`, `/rss`, `/atom.xml`, `/feed.json`); validate by
  fetching+parsing each candidate before offering it.
- **When discovery returns more than one feed**, the Settings **Add a feed**
  flow shows a multi-select picker rather than silently subscribing to the
  first candidate — this is how a user follows a specific section of a site
  (e.g. a news site that advertises Sport and World news feeds alongside its
  main feed). Each row shows the candidate's title, a few sample item titles,
  and its URL, with a 44px-min checkbox; the user can check any combination and
  subscribe to all of them in one action, or Cancel. Multi-feed subscribe is
  per-feed, not all-or-nothing: each selected URL is subscribed independently
  (no transaction spans them), so if one fails (gated/conflict) the others still
  commit and the toast reports "Subscribed to N feeds; M couldn't be added". If
  *every* selected feed fails, nothing commits, the picker stays open so the
  user can adjust and retry, and the specific failure reason is shown. A
  discovery that's superseded before it resolves (the user edits the URL or
  starts another add while it's in flight) is discarded — neither its picker nor
  its error surfaces under the new input. A single discovered
  candidate (the common case) still subscribes directly with no extra tap, and
  curated autocomplete suggestions bypass discovery entirely as before. The
  picker only surfaces the sections a site advertises on the submitted page; it
  does not crawl the site for sections that page doesn't link.
- Discovery reports *why* a URL yields no feed so the client shows a specific
  message instead of a blanket "no feed found": a `code` of `auth`
  (login-gated — the feed/site returned 401/403), `not-found` (404/410), or
  `unreachable` (network / timeout / SSRF-blocked / 5xx). This applies to the
  submitted URL **and** to each advertised candidate, so a public page whose
  advertised RSS URL is dead or paywalled surfaces that reason rather than
  "no feed found"; only a reachable page with genuinely no discoverable feed is
  reported as no feed.
- **Reddit is a first-class supported source** (Reddit no longer offers open
  API access, but every listing exposes Atom over RSS by appending `.rss`).
  Discovery recognizes `reddit.com` URLs and derives the feed form rather than
  relying on `<link>` autodiscovery (Reddit's pages don't always advertise it):
  subreddit `…/r/<sub>.rss` (and `/top`, `/new`, `/hot`, `/rising` →
  `…/r/<sub>/top.rss` etc.), multireddits `…/user/<u>/m/<name>.rss`, user
  posts `…/user/<u>.rss`, search `…/r/<sub>/search.rss?q=…&restrict_sr=1`, and
  the logged-out home/popular `…/.rss`. Reddit feeds parse as standard Atom
  through the normal pipeline; the post body (selftext / link) lands in
  `content_html` and is sanitized like any other feed.
  - **Reddit shorthand in the add-feed box.** Typing the same `r/<sub>`
    shorthand used on Reddit itself — `r/programming`, `u/<user>`,
    `user/<user>`, optionally with a leading slash and a sort/search/multireddit
    tail (`r/news/top`, `r/news/search?q=…`) — expands to the full
    `https://www.reddit.com/r/<sub>` URL on submit (and the box updates to show
    it), so discovery's existing Reddit handling derives the `.rss` feed. The
    first path segment must be exactly `r`, `u`, or `user`; a real hostname
    (`r.jina.ai/feed`) has a dot before the slash and is left untouched for the
    normal `https://`-prepend + discovery path.
- **YouTube channels are first-class.** Each YouTube channel exposes a public
  Atom feed at `https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>`,
  and the channel page advertises it via `<link rel="alternate"
  type="application/rss+xml">`, so the existing discovery path picks it up
  from any channel URL (`/@handle`, `/channel/UC…`, `/c/…`, `/user/…`) with
  no special server handling needed.
  - **YouTube shorthand in the add-feed box.** Typing `youtube/<handle>` or
    the brief alias `yt/<handle>` — with or without a leading `@` or `/` —
    expands to `https://www.youtube.com/@<handle>` on submit (and the box
    updates to show it). Handle case is preserved (YouTube handles are
    case-sensitive). A real hostname (`youtube.com/@mkbhd`, `yt.example.com`)
    has a dot before the slash and is left untouched for the normal
    `https://`-prepend + discovery path.
- **Facebook and Instagram do not expose public feeds** and are not
  supported. Facebook removed RSS in 2015; Instagram never offered it. The
  only access paths are third-party scrapers (RSSHub, RSSBridge, Bridgy)
  which violate ToS or require self-hosting and are deferred indefinitely.
- All discovery fetches go through the **SSRF-hardened fetcher** below
  (discovery is the highest-risk path — a brand-new user-supplied URL).

### Fetch hardening (SSRF — required for every server-side fetch)

`/api/discover`, the poller, the image proxy, and any future full-text
extraction fetch URLs that originate from users, so every outbound fetch
**must** route through one hardened helper enforcing:

- **Scheme allow-list:** `http`/`https` only (reject `file:`, `gopher:`,
  `ftp:`, `data:`, …).
- **Resolved-IP denylist:** block loopback (`127.0.0.0/8`, `::1`), link-local
  (`169.254.0.0/16`, `fe80::/10`, incl. cloud-metadata `169.254.169.254`),
  RFC1918 (`10/8`, `172.16/12`, `192.168/16`), ULA (`fc00::/7`), `0.0.0.0/8`,
  and other reserved ranges. Check the **resolved IP(s)**, not just the literal
  (DNS rebinding).
- **Re-validate every redirect** (manual follow, scheme+IP check per hop;
  reject a 302 to `169.254.169.254`; cap depth ≤5).
- **Timeouts and size caps** (e.g. 10s; 5–10MB body) to bound slowloris /
  decompression bombs.
- **No credential forwarding / no proxy trust** — never attach user session or
  service creds; ignore client `Host`/forwarding headers for target selection.

This is the RSS analog of newshacker's "never trust external input" posture.
Funnel all server fetches through it; a unit test asserts it rejects
loopback/link-local/private/metadata targets and redirects to them.

### Polling (the cron)

- A scheduled Edge Function runs ~every 5 min, selecting feeds with
  `next_fetch_at <= now()` **and** ≥1 subscriber, in batches: conditional GET,
  parse, upsert new items, schedule `next_fetch_at`.
- **Adaptive & polite:** honor `Cache-Control`/`ttl`/`<sy:updatePeriod>`; back
  off on `429`/`Retry-After`; exponential backoff + jitter on errors
  (`error_count`), capped ~6h; circuit-breaker parks a feed after N failures
  (surfaced as a feed-health badge). Healthy interval ~15–30 min.
- **Send a descriptive, contactable `User-Agent` on every fetch** (e.g.
  `Readmo/1.0 (+https://readmo.app)`). Some publishers — **Reddit notably** —
  return `429`/`403` to generic or empty UAs, and Reddit rate-limits by IP.
  Because all users share the poller's IP, a popular Reddit feed could hit
  Reddit's per-IP ceiling for *everyone* at once; mitigate by respecting
  `Retry-After`, polling Reddit feeds no faster than their `ttl`, deduping
  identical Reddit listings to a single shared `feeds` row, and (if it becomes
  a problem) routing Reddit polls through a small pool of egress IPs. Reliability
  note (rule 11): Reddit throttling degrades gracefully to the circuit-breaker
  + feed-health badge; no new infra unless the egress-pool mitigation is needed,
  which we'll cost out only if Reddit volume warrants it.
- **On-demand:** adding a feed or pull-to-refresh triggers an immediate
  server-side fetch for the relevant feed(s), debounced server-side (the
  per-feed `DEBOUNCE_S` skip protects the *publisher*).
- **Per-caller rate limit on `refresh`:** an in-memory token bucket (keyed by
  JWT subject; burst 10, sustained ~12/min) sheds a misbehaving client — e.g.
  one stuck on a buggy build that pull-to-refreshes in a loop — with a `429` +
  `Retry-After` **before** any DB query, so the abuse can't turn into a
  `subscriptions` select + per-feed `feeds` reads. This protects Readmo's own
  Postgres, distinct from the publisher debounce above. It's best-effort per
  warm Edge isolate and does **not** cover the direct `feed_items` read RPC
  (no Edge Function in front of it); a distributed/read-path cap belongs at the
  gateway (Cloudflare / platform) and is tracked separately. Cost: negligible —
  no infra, no external call, no DB work (guardrail #5).
- **Minimum-client-version gate.** The app stamps every Supabase request with
  `x-readmo-build: <commitCount>` (a monotonic build number). Edge functions
  reject builds below the configurable `MIN_CLIENT_BUILD` floor (0 = disarmed)
  with `426 Upgrade Required`, before any DB work. This is the targeted kill
  switch for a client shipped with a runaway-refetch bug: bump the floor past
  the bad build (no redeploy) and old clients are shed; current clients are
  never affected (they're always at/above the floor). The same header lets a
  gateway gate the `feed_items` read path the same way with one header-match
  rule — so an old client's read-loop can be rejected before Postgres without an
  Edge Function in front of it. **Read-path enforcement is implemented as a
  Cloudflare Worker gateway** (`infra/cf-gateway/`): the app points
  `VITE_SUPABASE_URL` at `api.readmo.app`, the Worker forwards to the Supabase
  origin, and a free per-IP WAF Rate Limiting Rule sheds a request storm before
  it reaches Postgres. The Worker's version gate is scoped to the stamped data
  paths (`/rest/`, `/functions/`) so it never blocks an OAuth navigation. It is
  operator-enabled (deploy + flip the URL) and ships with the gate disarmed; see
  `infra/cf-gateway/README.md` and SCALING.md. A new-client
  `426`→service-worker-refresh self-heal is still tracked as a follow-up. Cost:
  negligible in-app (a header compare); the gateway is $0 under 100k req/day,
  else ~$5/mo (Workers Paid).

### Observability — database performance alerting

Operator-facing (not user-visible). The goal: get paged **as soon as a query or
group of queries starves the database or runs longer than it should**, without
adding load or writes to a DB that's already struggling. Two layers, split on
purpose — full rationale + setup in [`OBSERVABILITY.md`](./OBSERVABILITY.md):

- **Detection + paging is out-of-band.** Grafana Cloud (or any Prometheus
  collector) scrapes Supabase's **Metrics API**
  (`/customer/v1/privileged/metrics`, basic-auth as `service_role`) once a
  minute and alerts on host saturation (`node_*` CPU / memory / disk),
  connection-pool starvation and slow/storming query rate
  (`supavisor_*` pooled-traffic metrics, `http_status_codes_total`), and
  DB-unreachable (a failed scrape). The Metrics API exposes **no `pg_stat_*`
  per-query series**, and the `supavisor_*` query/connection metrics cover
  **pooled traffic only** (not PostgREST/direct) — so these alerts say *the DB
  is starving / flooded*, and the per-query/per-`queryid` truth across all
  backends comes from the attribution layer below. Nothing runs inside Postgres,
  so the monitor doesn't share fate with the database and adds zero load; dedup /
  `for:` hysteresis / re-notify / silences are handled by the alert manager, not
  us. Rules ship as code in [`grafana/`](./grafana/).
- **Attribution is read-only and on-demand.** The Metrics API is aggregate
  ("the DB is starving"), not per-query. To find *which* query, the `db-perf`
  Edge Function (service-role only, `--no-verify-jwt`) calls the read-only
  `db_perf_diagnostics` RPC (migration `0022`): `pg_stat_activity` long-runners
  + worst `pg_stat_statements` groups (normalized — no user literals leak). It
  writes nothing and is bounded by a 3s `statement_timeout`; a Grafana alert's
  runbook links to it. Thresholds tune via `DB_PERF_*` secrets.

Cost/reliability: Metrics API is $0 (included, no DB load); Grafana Cloud free
tier covers one operator and keeps paging during a Supabase outage; `db-perf` is
negligible and off every critical path. See the External services table in
`CLAUDE.md` and SETUP.md §12.

### Cost & reliability (rule-11 discipline, carried from newshacker)

- **Supabase free tier** (Postgres 500MB, 50k MAU, scheduled functions) is $0
  at this project's scale; Pro ~$25/mo if it grows.
- **Poll cost scales with distinct feeds, not users**; conditional GETs are a
  few KB (`304`s nearly free).
- **New failure modes vs. newshacker:** DB + OAuth provider become hard
  dependencies; on a Supabase outage, login/sync fail but the offline cache
  still serves already-synced + pinned/favorited content. A flaky publisher
  can't take the app down (per-feed isolation + circuit breaker).

---

## Auth & sync

### Auth (Supabase social OAuth)

- Sign in with Google / Discord (Apple deferred). No password handled by us. Sessions
  are Supabase's HTTP-only refresh-token cookies; the access token is attached
  to API/DB calls.
- First launch (no session) routes to the sign-in page. The page shows a
  static feed preview (hero mockup of article rows) above the sign-in
  card (tagline + OAuth buttons + short privacy disclosure) so visitors
  understand the product before signing in. The hero always stacks above
  the card in a single column. The mock rows have a small top inset and a
  bottom fade gradient (implying more content); the sample row that shows a
  Reddit source / read state is kept out of the bottom row so the fade never
  washes out its source line. Deep links
  round-trip through sign-in then land on the target.
- **Account UI = header chip** (mirrors newshacker): one always-visible
  control, far right, 44×44+, every page. Signed out → "Sign in". Signed in →
  32px avatar (OAuth picture, falling back to an initial-on-color disc —
  deterministic, offline, zero requests); tap → popover with name, link to
  settings, "Sign out". Not in the drawer. Dismissal is the shared dropdown
  contract (`usePopoverDismiss`, also used by the overflow menu and the feed
  row menu): closes on Escape or an outside press, and **the first press
  outside only dismisses** — its trailing click is swallowed, so it never also
  activates whatever was tapped.
- **Implementation status.** Real Supabase OAuth (Google / Discord) is wired
  behind the existing `useAuth` / `getActiveUid` shape: when
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are present the buttons start
  the real redirect and the session drives the header chip + per-user cache
  keying (`getActiveUid` reads the persisted session synchronously at boot);
  when those env vars are absent the app falls back to the mock demo user so
  tests and backend-less local dev still work. Apple sign-in stays deferred.
- **Operator signup notification.** When a new user is created (`auth.users`
  insert), an `AFTER INSERT` trigger (migration `0012`) fire-and-forget posts
  the new row to the `notify-signup` Edge Function via `pg_net`; the function
  emails the operator (default `mikel@mikelward.com`, override
  `SIGNUP_NOTIFY_TO`) over SMTP. It is server-only and off the user's critical
  path — `pg_net` returns immediately, so the notifier can never delay or block
  signup, and the trigger no-ops until the SMTP secrets + Vault config are set
  (SETUP.md §9). The user-supplied email is treated as untrusted: it is forced
  to a single line before being placed in the subject/body, so it can't inject
  SMTP headers (guardrail #6). Not user-visible. Cost/reliability: negligible —
  see the External services table in `CLAUDE.md` and SETUP.md §10.

### Sync (server is the source of truth)

- Subscriptions, folders, and item state live in Postgres; the client keeps an
  optimistic local mirror (persisted React Query cache) and an offline outbox.
- **Offline mutation outbox.** Because Readmo owns its backend, state changes
  made offline are **queued and replayed** (newshacker dropped offline votes;
  Readmo keeps offline pin/favorite/done/hide/open). A toggle writes to a local
  outbox keyed by `(item_id, field)` recording the desired value + local order;
  on reconnect it flushes to Postgres. The UI reflects it immediately, rolling
  back only on a non-transient server rejection.
- **Conflict resolution uses a server-assigned version, not client wall time.**
  Each `item_state` row carries a monotonic `version` bumped **by the server**
  on every write; the flush applies an incoming field only if the caller's
  last-seen `version` is current, else returns the winning value to reconcile.
  We deliberately do **not** compare a client `updated_at` (a skewed/fast clock
  could stamp a future time and clobber newer changes). Per-field, so the
  independent booleans can't cross-conflict. (newshacker's client-timestamp LWW
  was fine for single-user list reconciliation with no server in the path;
  Readmo has a real backend, so the authoritative clock lives there.)
- **Refetch-on-focus.** Boot hydration of `item_state` is memoized and never
  re-runs on its own, so a backgrounded tab would keep showing the pins it
  loaded at boot. `DataSource.resyncState()` re-pulls the caller's `item_state`
  rows; `useStateSync` (mounted app-wide) fires it when the tab regains focus or
  visibility, or the device comes back online, so a pin / favorite / done made
  on another device syncs in without a manual pull-to-refresh. Overlapping calls
  coalesce (one tab return can fire both `focus` and `visibilitychange`); the
  hydrate path's pending overlay preserves an un-synced local write so the
  re-pull can't clobber a just-made change. The store emits on change → the
  feed-invalidation hook refetches and the library pages re-read.
  - **`item_state` reads are `NetworkOnly`** — a dedicated Workbox route
    (`supabaseItemStatePattern`, registered ahead of the NetworkFirst REST route
    — `vite.config.ts`) serves them with no cache fallback, so item-state
    hydration is always *live or it fails*. The read also carries a per-request
    cache-buster (`item_id=not.eq.<uuid>`, which excludes nothing) so that during
    a service-worker rollout — when the new bundle can briefly run under the
    *previous* worker, whose NetworkFirst `/rest/v1/` route would otherwise serve
    a stale cached 200 — the unique URL has no cache entry and the old worker
    still goes live-or-fail. So the live-or-fail property holds under any worker
    version, not just once the new worker activates. That keeps a focus/online resync from
    reconciling the store against a **stale service-worker cache snapshot** (the
    failure mode where a focus during a backend blip reverts a just-made pin),
    AND keeps an offline cold boot from dropping a resync-adopted row against a
    stale cached boot snapshot. A live read is authoritative, so `hydrate`
    reconciles fully (server wins, pending writes preserved, genuinely-absent
    rows dropped). Because "absent ⇒ drop the local flag" only holds when the
    read sees *every* server row, the read is **paged** (keyset by `item_id`,
    1000-row pages until a short page): PostgREST caps a response at 1000 rows, and
    an account that has acted on more than that many items (every pin / favorite /
    done / open writes a row, never auto-deleted) would otherwise have its read
    truncated, dropping the local pin/done/favorite of every row past the cap —
    resurfacing swept items. Keyset (not offset) paging so a row another device
    inserts between two page reads can't shift a window and skip an existing row.
    A failed read (offline / backend down) is a no-op — the store
    keeps its last-good localStorage state; feed/library reads fall back to it,
    and a resync's memo is swapped only on success. Hydrations are **serialized**
    (one read at a time; a resync started during an in-flight boot read runs after
    it), so the last-applied read is always the freshest — its request is sent
    only after the prior response arrived, so the server executes it later. That
    avoids assuming client start order matches the server's execution order (which
    HTTP/2 / server queueing can reorder). `NetworkFirst` already
    hits the network first when online, so this only changes the offline/down
    path. The trade: a resync while genuinely offline does nothing until reconnect
    (the `online` event fires another) — fine, since there's nothing to sync
    while the server is unreachable, and localStorage is a truer picture of the
    user's own state than a cached old server read.
  - **A feed/library read never *blocks* on item_state hydration once there's
    last-good state to overlay.** Hydration is best-effort — `feed_items` filters
    Done/Hidden server-side and the store carries last-good pin/opened/done flags
    from localStorage, so a read only needs hydration to *refine* per-row flags,
    not to render the right rows. So a read waits on hydration **only** on a
    brand-new / cache-purged device whose store is still empty and has never
    hydrated (so the first paint isn't all default flags) — and even then the wait
    is **bounded** (`COLD_HYDRATE_WAIT_MS`), so that device's own slow/paged/
    stalled read can't strand it on skeletons either; past the bound it renders
    with default flags and the library self-heals on the hydration's store emit.
    Otherwise it returns rows immediately and lets the background hydration's
    store emit trigger a refetch to refine flags (same path a focus/visibility
    resync uses). This is what stops a slow/large (paged, >1000-row account) or
    stalled item_state read from stranding the whole feed on its loading
    skeletons — a blocking await there held the home feed query in its initial
    loading state across reloads and pull-to-refresh. The read still flows through the connectivity-tracked,
    8s-bounded `supabaseFetch`, so Down/Offline detection is unchanged; only the
    gating of rows on it is removed.
  - **Offline write bases come from the persisted store**, not the cache. Since
    an offline boot's item-state read fails (no live `observeServerVersions`), the
    constructor seeds the outbox's optimistic-concurrency versions from the
    persisted store's per-row `version`s (`seedConfirmedVersions`). So an edit
    made before the first online read still bases on this device's last-known
    server version and conflicts/reconciles on reconnect, rather than flushing a
    blind no-base write. (The seed does not authorize base 0 — only a live read
    confirms an item is absent.) For the seed to be accurate, a successful write
    normalizes the persisted store's `version` to the server's returned value
    (`confirmServerVersion`): the store's `version` is an optimistic per-mutation
    counter, so coalesced edits (several local toggles → one server write) would
    otherwise leave it above the server's and seed a too-high base that
    false-conflicts. For the same reason the local-only hidden→Done migration
    (constructor and hydrate) preserves the row's existing version rather than
    bumping it — it rewrites a field without writing the server, so it must not
    advance the version.
  - **A write whose concurrency base can't be determined yet is HELD while a
    hydrate is in flight**, not sent unchecked. Because feed/library reads no
    longer block on hydration (above), a user can act on a brand-new row — one
    with no persisted/observed version — before the hydrate lands. The outbox
    brackets each hydration (`noteHydrationStarted`/`noteHydrationSettled`); while
    one is in flight it holds such a write rather than send it with no
    `p_base_version`, then sends it once the hydrate resolves the base (the row's
    observed version, or its absence → base 0). This keeps a write made in that
    window from blindly overwriting a concurrent cross-device change. With **no**
    hydrate in flight to wait on (an offline edit on a brand-new item), the write
    still goes out unchecked on reconnect, as before — the hold only applies while
    a base-resolving read is actually pending. This holds **across a reload** too:
    a no-base write persisted in a prior session would otherwise be replayed
    unchecked at boot, so the data source starts the boot hydration (marking it in
    flight) *before* the initial outbox flush, so the persisted entry is held until
    that hydrate resolves its base. The hold itself is **bounded**
    (`HOLD_MAX_MS`): if a hydrate never settles (the same never-surfacing
    NetworkOnly read the bounded *read* wait guards against), the write is released
    unchecked rather than stranded forever — the resolved base is also persisted
    the moment it's locked, so a crash mid-send replays with it intact.
- Realtime (optional, post-MVP): Supabase Realtime can push `item_state`
  changes to other open sessions. MVP relies on the refetch-on-focus above + PTR.
- **Implementation status.** `SupabaseDataSource` (`src/lib/data/`) implements
  the **read** surface against Postgres + RLS. Home/folder/feed reads run through
  the server-side `feed_items` RPC (`0006_feed_rpcs.sql`), which drives from
  `subscriptions` → `items` and LEFT JOINs `item_state` (scoped to `auth.uid()`)
  and returns one combined, already-paged sequence — Pinned first (oldest-first),
  then the body newest-first by `sort_at` with Done/Hidden excluded and only
  items inside the 3-day freshness window or their feed's newest 10 (Pinned
  exempt) — so each page
  is bounded to the page size and the client never sends an unbounded
  `feed_id`/exclusion `IN (…)` list. Item/library reads (`feeds_public`, chunked
  id lookups), search, subscriptions/folders, and the `discover`/`refresh` Edge
  Function calls round it out; item state is hydrated from the server into the
  shared `ItemStateStore`. Writes are wired through the
  offline outbox (`itemStateOutbox.ts`): triage flags apply to the store
  optimistically, then queue for durable, coalesced, serialized delivery to the
  `set_item_state` RPC — surviving reloads/offline gaps and replaying on
  reconnect. Each queued write carries the server `version` it was based on;
  `set_item_state` (0007) applies it only if the row is still at that version,
  else rejects so the stale replay rolls back and re-reconciles instead of
  clobbering newer truth. The hydrate path overlays only still-pending fields
  onto server truth and clears genuinely-stale rows. Add-feed / OPML import /
  parked-feed retry go through the `subscribe_to_feed` RPC and the `refresh`
  function. `main.tsx` selects the live source when `isSupabaseConfigured()`
  (else the mock seed), so a configured deployment boots on real RLS-scoped data.
  The version check is row-level (per item), so two devices editing the same
  item conflict even on independent flags — deliberately conservative (the loser
  re-reconciles) rather than risk a silent clobber; per-field versioning is a
  possible future refinement. Still deferred: an **authenticated OPML-export
  RPC** — the client can't
  emit real feed fetch URLs (`feeds_public` exposes only `site_url`, never
  `url`/`secret_url`),
  so live `exportOpml` carries homepage URLs until a server-side export exists.
- **Deferred — idempotency keys for exactly-once write delivery.** The outbox is
  at-least-once: a write can commit on the server while the client crashes/loses
  the response before recording the returned `version`. On replay the version
  check (0007) then sees the row already advanced and rejects with `40001`, so
  that write — and any same-item follow-up queued behind it — reconciles away.
  The state stays *consistent* (it matches what committed); at most a triage
  toggle made in that narrow crash-during-ack window is dropped. The complete fix
  is a per-write idempotency token the server dedups on (a replay of a committed
  write returns success + the new version, letting the outbox advance the
  successor's base) — a dedicated milestone, since a client-only dependency hack
  can't close it (the predecessor replay itself conflicts without server dedup).

---

## Feature list (MVP)

1. **Subscriptions & organization**
   - **Add feed** by URL or site URL → discovery → confirm (shows title + a
     sample of recent items before subscribing). If the input resolves to no
     feed it is **refused with a specific reason** — never silently subscribed
     to a non-feed URL (which would sit as an empty "Untitled feed" with no
     items). The surfaced reasons are: no feed found, the URL was not found
     (404), the feed/site requires a login, the URL couldn't be reached
     (network / blocked / 5xx), or you're signed out.
   - **OPML import/export** (table-stakes RSS courtesy — never trap a user's
     list).
   - **Folders/categories**, per-feed title override, drag-to-sort.
   - **Mute feed** — stays subscribed but excluded from the aggregate feed;
     still reachable on its own page. (This is per-feed; per-item dismissal is
     **Done** (dismiss), unchanged from newshacker.)
   - **Feed-health badge** when the poller parks a feed, with "retry now".

2. **Feed views (the lists)** — the chronological merge of subscription items,
   newest first, with newshacker's rules applied verbatim:
   - **`/` (Home)** — all non-muted subscriptions merged. A drawer *Home*
     picker can swap `/` to a chosen folder, persisted per-device (mirrors
     `useHomeFeed`). URL stays `/`.
   - **No-feeds coach** — when the account has **zero subscriptions**, Home
     shows a first-run coach ("No feeds yet" + an *Add a feed* button linking to
     Settings) instead of the "You're all caught up." empty state, which implies
     the user had items and read them. An account with only *muted* feeds still
     has subscriptions, so it gets the normal caught-up state, not the coach.
   - **`/folder/:name`** — a folder's merge. **`/feed/:feedId`** — one feed.
   - **Pinned prepended to the top** of every feed view, rendered once,
     oldest-pinned first; **pinning a body row keeps its position** (Sweep
     consolidates) — newshacker's exact *Story feeds* rule. (When grouping by
     feed — below — pinned items lead **their own feed's section** rather than a
     global top section.)
   - **Sort & grouping** (per-device — see *Settings → Sort order* and *Group by
     feed*; applied server-side so they hold across pages, not a client re-sort
     of loaded pages):
     - **Sort order** (`readmo:item-sort`, default **`newest`**) sets the body's
       chronological order — **newest-first** (default) or **oldest-first** —
       on Home, folders, and single feeds. Pinned ordering is unaffected (always
       oldest-pin first within its section). Toggleable from Settings **and**
       from the list **top toolbar** (the **Sort order** toggle, whose arrow
       reflects the current order — see *List toolbar*), which writes the same
       per-device preference.
     - **Group by feed** (`readmo:group-by-feed`, default **off**) sections Home
       and folder lists by feed instead of one merged river. Sections follow the
       user's **manual feed order** (the `subscriptions.sort` field, set by
       drag-to-reorder in Settings); within a section the chosen sort order
       applies, and that feed's pinned items sit at the top of the section. A
       feed-name header introduces each section. No effect on a single-feed view.
       Toggleable from Settings **and** from the multi-feed list **top toolbar**
       (the **Group by feed** toggle, whose flat-list / tree icon mirrors the
       current layout — see *List toolbar*), which writes the same per-device
       preference.
     - **Section header controls** (group-by-feed only). Each feed's header is a
       small control strip: the **chevron + feed name + unread/to-do count
       badge** form the collapse tap target (see below), and on the right sit two
       **44×44px** icon buttons, ≥8px apart — **Undo** and **Sweep this feed**
       (broom), in that left-to-right order to match the top toolbar's
       right-anchored cluster. The **count badge** shows that feed's unread/to-do total (from
       `getFeedUnreadCounts`; capped `99+`, hidden at 0), so a collapsed feed
       still shows how much it holds. **Sweep this feed** marks done that feed's
       **whole displayed section** — every unpinned row currently shown for the
       feed (its sticky window), not just the one or two that happen to be fully
       in the viewport. (This is a deliberate divergence from the **toolbar
       Sweep**, which stays viewport-scoped because it acts on every feed at
       once and must not dismiss sections the reader hasn't scrolled to; a
       header broom is a single, deliberate "clear this section" tap.) **Pinned
       rows are still shielded**, a **collapsed** section (no rows shown) has
       nothing to sweep, and the button disables when the feed has no sweepable
       row in its displayed section.
       **Undo** is the **same single-level global undo** as the toolbar (restore
       the last hide/swipe/sweep batch); it's enabled whenever there's something
       to undo, so the inline Undo next to a header's broom reverts the sweep you
       just did. (One swept feed's section drops out entirely once its rows are
       gone — unlike a *collapsed* feed, which keeps its header because its items
       still exist.)
     - **Collapse / expand sections** (group-by-feed only). The header's name
       area is a **tap target** that toggles its section collapsed (rows hidden, a
       chevron flips); the header stays visible. Per-device and **persisted**
       (`readmo:collapsed-feeds`, a JSON array of collapsed feed ids), so a
       section stays collapsed across reloads and between grouped views. The
       **top toolbar** gains **Collapse all** / **Expand all** controls (only
       while grouping with feeds in view) acting on the feeds currently loaded.
       They are **icon-only** buttons (`unfold_less` / `unfold_more`) with a
       long-press / hover **tooltip** and an `aria-label` for their names,
       matching the toolbar's Undo / Sweep icon buttons; each soft-disables
       (`aria-disabled`, so its tooltip still shows) when it would be a no-op
       (all already collapsed / nothing collapsed). A collapsed feed's hidden
       rows aren't navigable or swept.
     - **Per-section More + per-feed window** (group-by-feed only). Each section
       opens showing only its newest **`PER_FEED_WINDOW` (10)** listable rows, so
       a busy feed doesn't dump its whole freshness window into the river. A
       **"More"** at the **foot of each section** appends that feed's next page
       **inline** (another 10), independent of the other sections, until the feed
       is exhausted — its window ∪ floor ∪ pinned set, the same ceiling the
       single-feed page shows. The opening view is a **single read**: `feed_items`
       caps each section to `PER_FEED_WINDOW` rows (`p_per_feed_limit`) and returns
       every section in one page, so there's **no global bottom "More"** in this
       view (only Back-to-top remains). The per-section More re-reads that one
       feed via the **single-feed read** (`getFeedItems` with an offset), never
       refetching the others. A feed at or under its window (≤ `PER_FEED_WINDOW`)
       shows **no More**: the opening read **overfetches one row per feed**
       (`PER_FEED_WINDOW + 1`) purely as a has-more probe — the client renders
       only the window and shows a section "More" only when that extra row
       survived, so an exactly-full feed gets no dead button (and no wasted
       empty fetch). Because
       the read is bounded by `feeds × PER_FEED_WINDOW`, a **planned per-account
       feed cap** (`TODO(feed-cap)`) keeps it under PostgREST's 1000-row response
       cap; until that cap lands, a very large account could clip sections past
       the row cap. (Drilling into a single feed's own page is the flat pager.)
       Expanded extra pages get the same live item-state overlay as base rows
       (locally Done/Hidden are filtered, pin/opened read from the store); the
       one known staleness is a server-side change to a row *past* the opening
       window that the local store hasn't learned (e.g. a cross-device Done) —
       base rows self-heal on the next refetch, but a cached extra row can
       linger until that feed's window changes or the view remounts.
       - **Sticky displayed window per section.** Each section's displayed set
         is anchored from its first read (the opening `PER_FEED_WINDOW` rows)
         and extended only by tapping "More". Refetches that bring fresh
         server-newer rows into the top of `items` — post-Sweep refills,
         cross-device drift, RSS items polled in — leave those rows in the
         cache but **do not paint them**: the section stays anchored on what
         the reader is already viewing. Concretely this means **Sweep does not
         auto-refill** (sweeping unpinned rows clears the section to its
         pinned rows; tap "More" to pull the next full page); and **pinning
         an "extra" row does not shrink the section** (the pinned id is in
         the sticky set so promoting it into the base window is a no-op for
         the displayed list). When a swept section has no pins to anchor it,
         the section header + "More" still render as a **phantom row** so the
         reader can pull the next page without remounting; the empty state
         only appears once every section is genuinely exhausted. Pull-to-
         refresh resets the sticky set, so the reader can always opt in to
         the newest top items.
   - **Done and Hidden filtered out**; **Opened** items render with the faded
     title.
   - **Initial paint one page (30 items)** in the flat river; the grouped view
     instead loads each feed's first **`PER_FEED_WINDOW` (10)** in one windowed
     read and grows per section. Further flat pages only via an explicit **More**
     button (no infinite scroll). Same pagination discipline.
   - **Background refresh status strip** at the foot ("Checking for new
     items…" / "Couldn't refresh." + Retry), appearing only when rows are
     already on screen. Verbatim mirror.
   - **Scroll position holds across a background refresh.** A pin/dismiss
     invalidates the feed query, and React Query refetches the loaded pages
     *sequentially*, so the rendered list briefly shrinks mid-refetch. The list
     body's height is frozen for the duration of the refresh so the document
     can't get shorter than the current scroll offset and bounce the reader to
     the top — most visible with collapsed feed sections, which leave the
     document short to begin with. The lock releases once the refresh settles.
     **Sweep** is the sharper case: it drops its rows the instant the refetch
     starts (in the same commit), so it grabs the pre-sweep height itself —
     before the rows leave the DOM — rather than waiting for the refresh edge to
     measure an already-shrunken list. Matters most when a whole grouped section
     is swept at once.
   - **Pin-to-download promo bar** above the first row ("Pin an article to
     download it"), explaining that pinning warms the offline cache (see
     *Prefetch on Pin/Favorite*). Shown only once rows exist; dismissable via a
     single 44×44 close button, persisted per-device
     (`readmo:promo-dismissed:pin-to-download`).
   - **`/offline`** — items cached on this device.

3. **Item row** — see *Item row layout*. Right-side button = **Pin/Unpin** on
   feed views; the view-contextual inverse on library views.

4. **Library views** — `/pinned`, `/favorites`, `/done`, `/opened`,
   reusing the feed row with the right-side button swapped to the view's
   inverse action (filled, accent-colored). Per-view "Forget all" toolbar on
   `/done` and `/opened`; none on `/favorites`/`/pinned`. No `/hidden` route —
   swipe-right and sweep both set Done directly.

5. **Reader view** — `/item/:id` — the article, with the action bar. No
   comments. See *Reader view*.

6. **List toolbar** — sticky below the header: right-aligned **Undo** +
   **Sweep unpinned** (Mark all done), and a left-aligned cluster of view
   toggles in this order: **Group by feed**, **Collapse all / Expand all**,
   **Sort order**. The **Group by feed** toggle (a flat-list / tree icon
   that mirrors the current layout, with a
   long-press / hover tooltip and `aria-pressed` for its on/off state) is a
   one-tap shortcut for the `readmo:group-by-feed` reading preference, so the
   reader can switch between the merged river and per-feed sections without a
   trip to Settings; it shows only on **multi-feed views** (Home, folders) and
   is omitted on single-feed views, where grouping is a no-op. The **Collapse
   all** / **Expand all** icon buttons (`unfold_less` / `unfold_more`, with
   long-press / hover tooltips — see *Feed views → Collapse / expand sections*)
   appear only in the **group-by-feed** view. The **Sort order** toggle
   flips the `readmo:item-sort` preference between **newest-** and
   **oldest-first**; its arrow reflects the **current** order (down =
   newest-first / descending, up = oldest-first / ascending) and its tooltip /
   accessible name names that order, and it rides **every** feed view — Home,
   folders, and single feeds — since sort applies even where grouping doesn't. Sweep marks done only
   the unpinned rows that
   are **fully visible right now** — not the whole loaded list — so scrolling
   past content and tapping the broom can't dismiss rows off-screen. A row
   counts as visible iff its bounding box sits entirely inside the viewport
   minus the sticky chrome (header + toolbar), tracked by an
   IntersectionObserver whose `rootMargin` shrinks the top by that inset; the
   button disables when nothing unpinned is fully visible. Undo restores the
   last done / swipe / sweep batch. Same component/behavior as newshacker.
   - **Animation.** Every swept row plays a single **200ms slide-right + fade
     to zero** together (matches the swipe-right-to-hide direction and the
     `useSwipeToDismiss` exit, so the broom feels like every row swiped itself
     away at once); the actual `hideMany` is deferred until the first matching
     `animationend` bubbles up from a swept `<li>`, with a 2× fallback timer
     in case the event never fires (background-tab throttling, jsdom, etc.).
     A pending sweep also commits synchronously on unmount so a navigation
     mid-animation doesn't drop the tap. Under
     `prefers-reduced-motion: reduce` the animation and the deferral are both
     skipped — the hide is immediate.
   - **Debounce.** A second sweep tap is ignored while a sweep is already
     playing out **and** for a short cooldown (~400ms) after it commits. In
     grouped mode a section refills with the feed's next items the instant the
     swept rows hide, so without the cooldown a quick second tap (e.g. a feed's
     broom followed by the toolbar Sweep) would immediately clear the
     freshly-surfaced rows — reading as "it swept the feed twice". A deliberate
     later sweep still goes through.
   - **Auto-hide on scroll** (opt-in, `readmo:hide-on-scroll`, off by default —
     see *Settings → Reading*): when on, each unpinned row is marked **Done the
     moment it scrolls fully off the top** of the viewport (you scrolled past it
     without pinning it). This is **not** the Sweep button: there's **no timer
     and no accumulation** — dismissal is immediate and per-row, driven directly
     by the sweep IntersectionObserver firing as a row leaves the top edge after
     having been fully visible. It reuses Sweep's `hideMany` and the same pin
     shield (pinned rows are never auto-hidden), and rows still below the fold
     are never auto-hidden — only ones you've actually scrolled past. Rows that
     are already Done/Hidden are skipped, so a re-delivered id can't clobber the
     undo baseline. **Undo restores the whole scroll burst, not just the last
     row:** dismissals within a rolling **2s window** of each other extend a
     single undo batch (mirrors newshacker's dismiss-batch window), so one tap of
     the toolbar Undo brings back the run you just scrolled past; a gap longer
     than the window starts a fresh batch, so Undo only ever reaches back to the
     burst you were just looking at.

7. **Bottom action bar** — Back-to-top + More + Undo + Sweep on feed footers;
   Back-to-top only on library footers. Same slot order. **More lives in the
   bottom toolbar itself** (not a separate control above it): it stretches the
   middle slot between Back-to-top and the Undo/Sweep group. It appears once
   the feed is **populated** (not during the loading skeletons, the error/retry
   state, or an empty result — those would otherwise flash a misleading
   exhausted message).
   - **Position is configurable** (`readmo:bottom-bar`, per-device — see
     *Settings → Bottom toolbar*). The **default is `list`**: a **relative
     footer at the end of the list** that you scroll down to, matching
     newshacker and never overlapping rows. The opt-in **`screen`** **pins the
     bar to the viewport foot** so the actions stay in reach without scrolling
     to the end. Only the bottom bar is repositioned; the top toolbar always
     sticks below the header.
   - **In the default `list` (relative) position, More just fetches** the next
     page (and scrolls its first row up) — the reader only reaches the bar at
     the foot of the list, so it tracks `hasMore` and never needs a page-down
     tap. It settles into a disabled **"No more items"** at the true end.
   - **In the `screen` (pinned) position, More is a pager, not just a page-fetch
     button** — the bar is always on screen, so it can't claim exhaustion while
     loaded rows still sit below the fold:
     - **While the foot of the loaded list is below the fold**, tapping More
       **scrolls one page down** to bring more already-loaded rows into view.
     - **Once the list end is in view and another page is fetchable**, tapping
       More **loads the next page** and scrolls its **first row to just below
       the sticky top chrome** (header + top toolbar) once it renders.
     - **Only when the end is reached *and* nothing more can be fetched** does
       it settle into a disabled **"No more items"**.
   - When the bar is `screen`-pinned it overlaps content, so the **Sweep
     IntersectionObserver shrinks its root's bottom edge** by the bar's
     intrusion (a row tucked behind it isn't "fully visible"); in the default
     `list` position the footer sits below the fold, so that inset is 0.

8. **Pull-to-refresh** — re-runs the view's fetch **and** force-checks for a
   newer bundle. Identical to newshacker.

9. **Search** — `/search` over feed + item titles (Postgres `ILIKE`/`tsvector`
   on titles for MVP; body search deferred). Search-glass in the header
   right-actions group, suppressed on `/search`. Same placement.

10. **Settings** — `/settings`: subscriptions/folders, OPML in/out,
    **Reading**, **Sort order**, **Bottom toolbar**, palette (Ink/Grape), theme
    (light/dark/system), text size (Small/Medium/Large), account/sign-out.
    Theme, palette, and text size are also accessible directly in the drawer's
    **Appearance** section. A gear icon sits at the right end of the header's
    inner row (after Search) so settings is one tap away from any page.
    - **Subscriptions** — the feed list is **drag-to-reorder**: each row stays
      within the **3-tap-zone cap** as drag handle (left), a non-interactive
      row body (title + URL), and a right-side **overflow (⋯) button** that
      opens a per-row menu with **Rename / Mute / Unsubscribe**. The drag
      handle is both pointer-draggable (mouse + touch) and keyboard-operable
      (focus it, then ArrowUp/ArrowDown), so reordering isn't mouse-only. The
      order persists to `subscriptions.sort` (via `reorderSubscriptions`) and
      drives both the drawer/Settings list order and the *Group by feed*
      section order. Rename uses an inline input that replaces the title slot:
      **Enter** commits, **Esc** cancels, **blur** commits, and **leaving the
      input empty clears the override** so the row falls back to the
      publisher's title. Rename writes `subscriptions.title_override` and is
      per-user; an unchanged value is a no-op. The overflow menu dismisses via
      the shared dropdown contract (`usePopoverDismiss`): Escape or an outside
      press closes it, and **the first press outside only dismisses** — its
      trailing click is swallowed, so dismissing the menu doesn't also activate
      a neighboring row or control.
    - **Reading** — per-device toggles: **Hide articles as you scroll past**
      (`readmo:hide-on-scroll`, **off by default**), wiring the auto-hide
      behavior in *List toolbar → Auto-hide on scroll*; and **Group by feed**
      (`readmo:group-by-feed`, **off by default**), sectioning Home/folder lists
      by feed (see *Feed views → Sort & grouping*).
    - **Sort order** — a two-option per-device picker (`readmo:item-sort`)
      choosing the feed body's chronological order: **Newest first** (the
      default) or **Oldest first**. See *Feed views → Sort & grouping*.
    - **Bottom toolbar** — a two-option per-device picker (`readmo:bottom-bar`)
      choosing where the bottom action bar sits: **Bottom of list** (the
      default — the relative end-of-list footer) or **Bottom of screen** (pinned
      to the viewport foot). See *Bottom action bar*.

11. **Keyboard shortcuts** — same letter scheme (see below).

12. **Account UI** — header chip (see *Auth*).

---

## Item row layout

Identical to newshacker's *Story row layout*; only the meta content differs
(source feed instead of HN domain; no points/comments).

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   Article title goes here, wrapping to two lines         │
│   if needed.                                            │   📌
│   ◐ The Verge · 3h · Jane Doe                            │
│                                                          │
└──────────────────────────────────────────────────────────┘
   ^                                                          ^
  Row tap → reader (/item/:id)                               Pin toggle:
  (title + meta share one stretched link)                   pin / unpin
```

- **Row body** — title + meta share one stretched `<Link to="/item/:id">`. Tap
  opens the reader (marks **Opened**).
- **Right-side icon button** — real icon button, 44×44+, ≥12px gap. On **feed
  views** it's **Pin/Unpin** (`push_pin` outline→filled). On **library views**
  it's the view's inverse: `/pinned` → Unpin, `/favorites` → Unfavorite
  (`favorite` filled), `/done` → Unmark done (`check_circle` filled),
  `/opened` → Mark unread —
  filled, accent-colored. Same table as newshacker's *Library views*.
- **Reserved middle slot** — on **narrow viewports** stays unused (mobile keeps
  the two-tap-zone shape). On **wide viewports (≥960px) feed rows**, fills with
  a **Done** icon button (`check`) sitting immediately to the left of Pin —
  same toggle semantics as the reader's Done action (untoggled → marks done
  and records an undo point; toggled → unmarks). Library views keep the slot
  empty (their right-side button already names the row's intent). Same high
  bar for any further use.

Display-only meta (plain text inside the row link): **source** (feed/site
name, favicon, trimmed to the registrable domain the way newshacker trims
domains — `old.reddit.com` → `reddit.com`); **age**; **author** when present.
**Opened** titles render `--rm-read`. Not rendered: rank numbers, inline
source/date links, external-link chevron (the reader's "Open original" owns
that). (No points/comments/Hot flag/"N new" — those are HN-specific.)

Sizing: 6px vertical padding, 48px+ row (the 44×44 tap floor lives on the row
body, so the row stays compact), 44×44 hit areas, ≥8px gaps, pressed-state on
every zone. Matches newshacker's `.story-row` density.

### Swipe gestures (same as newshacker)

- **Swipe-right → Done** (reveals `Done`).
- **Swipe-left → Pin** (reveals `Pin`).
- **Shields rubber-band:** pinned rows show `Pinned` on both edges and snap
  back. Same mechanism + "every swipe names its outcome" rule.
- **Undo** (toolbar) restores the last swipe/menu-done/sweep — one level, not
  persisted.

---

## Reader view (`/item/:id`)

Replaces newshacker's *Thread* page. No comments, no votes — the rest of the
page's discipline is unchanged.

- **Header:** source feed (favicon + name, links to `/feed/:feedId`), title
  (links to the original, `target="_blank"`, marks Opened), author, date.
- **Loading state:** the blank centered **"Loading…"** (with the tip
  **"Tip: 📌 pin an article to make it load faster"** — using the same
  inline `PushPinOutline` glyph as the row pin button (decorative,
  `aria-hidden`) — on a separate line below it) appears **only when there's
  nothing cached to paint yet**: a cold first open, or while the offline cache
  is still restoring. In the usual case — you tapped the item from a list you'd
  already loaded — its **feed body paints immediately** from the list cache
  (`lib/offlineItem.ts:findCachedFeedItem`) while the per-item `getItem`
  refetches in the background, so there's no blank gap; a **pinned** article
  whose extracted body is cached opens straight into the **reading view** (see
  *Full-text reading mode*). The blank "Loading…" is the cold-cache exception,
  not the norm — and the tip still nudges readers toward pinning, which keeps
  both bodies cached for an instant open on later visits.
- **Body:** the sanitized `content_html`; images lazy-load (proxied — see
  *Privacy*); relative URLs already absolutized. Enclosures render
  appropriately (`<audio>` for podcasts, image/figure, else a download link).
  **Standalone images** — direct children of the body or wrapped in `<figure>`
  or `<picture>` — are full-bleed (edge-to-edge on mobile, full feed-column
  width on desktop). On mobile they fill the column even when the source is
  narrower (e.g. a Reddit preview thumbnail served small) — a tiny inline-size
  image reads as broken when the column is the whole viewport. On the **desktop
  wide layout (≥960px)**, where the column is framed by whitespace and upscaling
  a small source looks worst, they are instead capped at the source's intrinsic
  resolution: an image smaller than the column renders at its natural pixel size
  rather than being upscaled and blurred. Inline images inside `<p>`, `<li>`,
  etc. keep their natural size. `<figcaption>` text is inset 16px to align with body copy.
  Direct-child `<table>` elements (Reddit and similar feeds embed a thumbnail
  in a layout table) are reflowed as a block stack so the image leads
  full-bleed above the text summary. For **Reddit image posts**, the feed body's
  `<img>` is a small, server-cropped thumbnail (top/sides cut off) while the
  full uncropped image is only linked as the post's "[link]"; the sanitizer
  swaps the thumbnail's `src` for that full image at poll/refresh time (see
  *Feed fetching & parsing* → `_shared/redditImages.ts`) so the reader shows the
  whole picture rather than Reddit's crop. **Body copy is 1rem (16px at the default
  text size) / line-height 1.4** — a deliberate step up from newshacker's 15px
  reading text (long-form articles warrant a slightly larger, denser measure
  than HN comment threads). It is sized in `rem`, so it scales with the
  Settings "Text size" choice along with the rest of the UI type.
- **Full-text reading mode (default):** many feeds publish only a truncated
  stub as `content_html`. When the feed body looks truncated (no body, or under
  ~600 chars of visible text — see `src/lib/fullText.ts:looksTruncated`) the
  reader fetches the full article from its source via the `fulltext` Edge
  Function **in the background while showing the feed body immediately**, so the
  reader always has something to read on the first tap. The fetched article does
  **not** auto-swap in (that would reflow the page mid-read): a **"Keep
  reading"** button appears once it's ready and reveals it on demand. An
  already-cached full body (a pinned or previously-read item) skips the button
  and opens straight into the reading view. The function fetches through the
  SSRF-hardened helper, extracts the
  article with Readability, **sanitizes the extracted HTML** (same path as the
  feed body — guardrail #6; never stores/serves raw publisher HTML), and caches
  the result on the shared item (`items.full_content_html`) so later opens — on
  any device, for any subscriber to the same item — are served from cache.
  - **Tidies the extracted body** (`cleanArticleHtml` in
    `supabase/functions/_shared/fulltext.ts`) before it is measured and
    returned: **(a)** strips site navigation — every `<nav>` /
    `role="navigation"` element and any link-dense list (≥3 links, ≥75% of its
    text inside those links, and short menu-label links — average link text ≤40
    chars, so a link roundup whose entries are article titles is kept) — since
    Readability otherwise leaks menu bars
    on hub/homepage URLs (e.g. the BBC homepage's "Home / News / Sport /
    Weather" lists); and **(b)** drops the body's leading heading when it just
    repeats the headline the reader already renders above the body (the feed
    item title is passed into extraction; match is case/punctuation-
    insensitive). Genuine content lists (few/no links) and section headings are
    kept; a page that was mostly chrome now falls under the minimum article
    length and reports `empty`.
  - The feed body shows first; once the background fetch lands, **"Keep
    reading"** reveals the full article (no auto-swap). Once both bodies exist
    the swap *back* to the feed body lives in the reader's overflow (⋮) menu
    as **"Show feed version"** — keeping the mode bar quiet on the happy path
    (most readers stay in the extracted reading view) without losing the
    escape hatch. An already-cached full body defaults to the reading view.
    Feeds whose body is already complete are not auto-fetched but offer a
    **"Get full article"** control. While the background fetch is in flight
    the mode bar shows a **"Loading full article…"** note alongside an **"Open
    original"** button (in the same slot as "Keep reading"), so the reader can
    jump to the source without waiting for extraction.
  - **Outcomes** (the function returns `{ status, contentHtml }`): `ok`,
    `empty` (nothing article-like found), `auth` (publisher gated the page even
    via the Jina fallback → the reader keeps the feed body and shows "needs
    sign-in — open the original"), `unreachable` (fetch failed → feed body kept,
    with a **Try again** and **Open original**). On `empty` the reader stays
    **silent** — no error note — and just keeps the feed body plus the **Open
    original** button. This covers both a link aggregator like Reddit whose entry
    already *is* the whole story and a paywall/teaser the backend couldn't
    expand; a short complete entry and a short teaser are indistinguishable by
    length, so the reader doesn't try to tell them apart and relies on **Open
    original** as the escape hatch in both. In every non-`ok` outcome the mode
    bar keeps an **Open original** button so the source is always one tap away.
    Login-gated/paywalled articles
    cannot be rendered by any reading mode (the user's session lives only in
    their own browser at the publisher's origin); **Open original** stays the
    tool for those.
  - **Cost & reliability (guardrail #5):** the only outbound call is the
    publisher fetch (same class as the poller) plus the existing `r.jina.ai`
    403-fallback (already documented) — **no new paid service; cost negligible.**
    Latency is +1–3 s on the first open of a truncated item, then cache-instant.
    Works on most normal article sites; SPA/JS-rendered pages and paywalls fall
    back to the feed body + Open original.
- **Reading affordances:** comfortable measure, paper surface, light/dark,
  `prefers-reduced-motion`.

### Reader action bar (mirrors newshacker's Thread action bar shape)

Single row, single-row invariant at ≥320px, pointer-vs-touch sizing, top **and**
bottom bars. The **top bar is sticky** (pinned under the header) and carries
every action throughout the read; the **bottom bar is a relative end-of-article
footer** you scroll down to — matching newshacker, rather than floating over the
last lines of text. Left→right:

**Open original** (primary; icon-only with a soft accent-tinted fill — the
tooltip and aria-label carry the name; marks Opened, fades to neutral once
opened) → **Done** (✓) → **Pin/Unpin** (📌) → **More ⋮**. On wide viewports (≥960px)
**Share** and **Favorite** (♥) surface inline between Open original and Done
(in that order — Share sits next to Open original); below 960px they live in
the overflow. The overflow ⋮ → Pin → Done cluster at the right matches the
other toolbars in the app. (No Upvote — RSS has no votes.)

- **Done** also unpins and **navigates back** (the "I'm finished, move on"
  gesture); **Unmark done** does not navigate. Same as newshacker.
- Bottom bar swaps the primary slot to **Back to top** (neutral, stretched) so
  Done/Pin/⋮ land at the same x-position — handy right where you finish reading,
  since this bar is the relative footer at the article's end.
- **More ⋮** overflow: Favorite/Share (when not inline), **Open feed**, **Copy
  link**, **Mute feed**. This is the **shared `ItemRowMenu`** component (the same
  one the feed list rows use, and the mirror of newshacker's thread ⋮) — lifted
  to the reader page so the top and bottom bars drive one instance. Anchored
  dropdown next to the ⋮ button (sheet fallback when no anchor), 44px touch /
  dense pointer. Dismisses on click-outside or Escape; **the first tap outside an
  open menu only dismisses it** — that gesture's trailing click is swallowed, so
  it never also activates whatever sits underneath (an item row's stretched link,
  a neighboring row, a toolbar button); a second tap is needed to act.
- **Share** shares the **original article URL** (publishers want canonical-page
  traffic; there's no on-site discussion page to prefer — the one place Readmo
  differs from newshacker, which shared its own `/item/:id`). Web Share API +
  clipboard fallback + "Link copied" toast.

---

## Routes

| Path | View |
|---|---|
| `/` | aggregate feed of all non-muted subscriptions (drawer Home picker can swap to a folder; URL stays `/`) |
| `/folder/:name` | folder aggregate |
| `/feed/:feedId` | single feed |
| `/pinned` | pinned items (active reading list) |
| `/favorites` | favorite items (permanent) |
| `/done` | completed items (30-day history) |
| `/opened` | recently opened (30-day history) |
| `/offline` | items cached on this device |
| `/item/:id` | reader view |
| `/search` | search over feed + item titles |
| `/settings` | subscriptions, folders, OPML, theme, account |
| `/signin` | OAuth sign-in (unauthenticated landing) |
| `/debug` | build/runtime/config diagnostics; no auth gate, public/presence info only (no secrets). Headline is `<branch-leaf> <commit-count> (<short-sha>)`, e.g. `main 100 (abcdef)`; the Committed/Built rows use the verbose `2 days ago` age format. Linked from Settings → About, which shows the build sequence number and age (e.g. `Build 100 · 2 days ago`) — no SHA — next to the Debug link. |

---

## Accessibility

- Semantic HTML, visible focus, `prefers-reduced-motion` honored.
- Body contrast ≥4.5:1 (ink accent clears it on white/dark — verify final
  hex).
- Every icon-only button has an accessible name; the long-press tooltip is
  visual-only.
- Disabled icon buttons (e.g. Sweep/Undo when there's nothing to act on) go
  inert via `aria-disabled`, not the native `disabled` attribute, so they still
  surface their tooltip on hover/long-press — a `disabled` `<button>` fires no
  pointer events, which would silence the tooltip.

### Keyboard shortcuts (same scheme as newshacker)

List pages (`/`, `/folder/:name`, `/feed/:feedId`, library views):

| Key | Action |
|-----|--------|
| `j` / `↓` | Focus next row (first press focuses the first row) |
| `k` / `↑` | Focus previous row |
| `Enter` | Open the focused row's reader |
| `Space` | Open the row's actions menu |
| `o` | Open the focused row's original article in a new tab |
| `p` | Toggle Pin on the focused row |
| `d` | Mark done (dismiss) the focused row |
| `?` | Help overlay · `Esc` close |

Reader page (`/item/:id`):

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll to next/previous section heading (or page top/bottom) |
| `o` | Open original · `p` Pin · `f` Favorite · `d` Done (navigates back) |
| `?` / `Esc` | Help / close |

Same bail-out conditions as newshacker (skip in inputs, open dialog/menu,
modifier held, pre-defaulted). No auto-focus on load.

---

## PWA & Offline

Installable; offline reading of already-synced and explicitly pinned/favorited
content. Closest mirror of newshacker.

### Install identity

- Manifest (via `vite-plugin-pwa`): name "Readmo", theme `#faf9f5`, background
  `#faf9f5`, `display: standalone`, `start_url: /`.
- Icon set into `public/`: `icon-192/512`, `icon-512-maskable`,
  `apple-touch-icon` (180), `favicon.svg`, `favicon-maskable.svg`,
  `favicon-32.png`. Maskable full-bleed, glyph in the 80% safe zone.
- `index.html` declares manifest + apple-touch-icon + `apple-mobile-web-app-*`.

### Service worker

- `registerType: 'autoUpdate'` — background download, silent activate on next
  navigation, no prompt. Same rationale.
- **PTR force-checks for updates** (`registration.update()`, reload on
  `controllerchange`) since the browser only re-checks `/sw.js` on full
  navigation and our PTR overrides native swipe-to-reload. `src/lib/swUpdate.ts`.
- **Passive surfaces** (`src/components/AppUpdateWatcher.tsx`, mounted at the
  app root): `controllerchange` → sticky "New version available · Reload" toast;
  `visibilitychange`-after-≥30s passive `registration.update()` ping
  (`pingServiceWorkerForUpdate` in `src/lib/swUpdate.ts`). A first-ever-install
  guard keyed on `readmo:sw:installed` suppresses the spurious toast on the
  initial SW activation but still surfaces it after hard-reloads /
  session-restore / iOS PWA relaunches (transient null controller despite a
  prior install); it fails open when storage is unavailable. A **periodic**
  `registration.update()` ping (every 30 min, only while the tab is *visible* —
  the interval is torn down while hidden) bounds how long a tab that's left open
  and in view but never navigated/PTR'd (an installed PWA, or a parked desktop
  tab) can sit on a stale build; any update found surfaces through the same
  `controllerchange` toast. Negligible bandwidth — one conditional GET against
  the tiny `/sw.js` per interval, paused entirely when backgrounded.
- A lazy route chunk that 404s after a deploy (stale client referencing a gone
  hash) auto-reloads once via `LazyRouteBoundary` (`src/components/`), guarded by
  a one-shot `readmo:chunk-reload` session flag against a reload loop.
- Disabled in `npm run dev`.

### Caching strategy

Client reads through Supabase rather than newshacker's `/api/*` proxies, so the
keys differ; the strategies map one-to-one:

- **App shell** — precached; navigation falls back to `index.html`.
- **Data reads (Supabase REST/RPC)** — **NetworkFirst** (~6s timeout, short
  TTL, bounded), cache fallback offline. (Same NetworkFirst-over-SWR reasoning.)
- **Pinned/Favorite item content** — **no expiration** (the exemption
  newshacker grants pinned/favorited items); bounded only by per-origin quota.
- **Article images** (via the proxy below) — **CacheFirst**, capped. The
  proxied bytes are content-addressed (the `?url=` fully determines them) and
  served `immutable`, so a cache hit must not re-hit the network; SWR's
  background revalidation would multiply proxy requests on image-heavy articles
  for no benefit. The `maxAgeSeconds` cap still bounds staleness.
- **Favicons** — CacheFirst, long TTL, capped.

### Persisted query cache (client mirror)

- React Query cache persisted to **IndexedDB** (larger payloads than
  newshacker's localStorage — article bodies + image metadata — avoid
  `QuotaExceededError`).
- `networkMode: 'offlineFirst'` globally (true cache miss rejects fast → offline
  UI, not a hung skeleton). Same rationale.
- **Bounded Supabase requests.** `offlineFirst` only governs React Query's own
  retry pausing; it does not bound the underlying request. On a cache *miss* the
  service worker's NetworkFirst awaits the network (its ~6s timeout only falls
  back on a cache *hit*), so a lie-fi connection could leave a read pending
  indefinitely — and because `SupabaseDataSource` memoizes the in-flight
  `item_state` hydration, one hung request wedged the whole feed on its loading
  skeletons. The Supabase client therefore wraps `global.fetch` in `supabaseFetch`,
  which caps **reads** at 8s (just past the SW's ~6s cache-fallback window): GET
  requests on `/rest/v1/` (what the SW mediates, since Workbox runtime caching is
  GET-only) *plus* the `feed_items` read RPC (a POST, but the primary
  home/folder/feed read, so it must be bounded too). A hung read aborts → the read
  rejects → React Query shows the offline/retry UI and resumes on reconnect, and
  the memoized hydration clears so the next read retries. The cap is scoped to
  reads only; deliberately left uncapped: **write RPCs/table writes** (POST
  `rpc/set_item_state`, `rpc/subscribe_to_feed`, DELETE/PATCH on `subscriptions`)
  — aborting
  a slow-but-committing write would make the item-state outbox retry on a stale
  base version (permanent conflict / dropped edit) or surface a spurious error,
  so the outbox's own retry/durability is the right bound; **Edge Functions**
  (`/functions/v1/` — refresh, discover, fulltext), which legitimately run longer
  than a read; and **auth** (`/auth/v1/`), where a capped token-refresh timeout
  would surface as a failed `getSession()` → the user is nulled →
  `useUserCacheScope` treats it as a sign-out and purges the offline cache,
  turning a transient blip into a spurious sign-out. Every request still flows
  through `trackedFetch`, so a real network failure flips the Offline pill.
- **A read *timeout* is not treated as proof of offline.** A self-imposed 8s
  read cap is ambiguous: the device may be offline, or the backend may just be
  slow (e.g. the DB overloaded and `feed_items` not answering in time). Flipping
  the Offline pill on the timeout alone mislabels a server-side slowdown as a
  device-connectivity problem. Instead, a timeout triggers a lightweight
  reachability probe (`GET /auth/v1/health` — GoTrue's in-process liveness
  check, which does **not** query Postgres, so it stays responsive under DB
  load). **Any** HTTP response → the backend is reachable and the device is
  online, so the pill stays off and the feed view surfaces its own "Couldn't
  load — Retry" state. Only if the probe **also** fails (network error / its own
  timeout) do we flip to Offline. The probe is coalesced (one in flight at a
  time) and skipped when no project URL is configured (mock mode falls back to
  treating a timeout as offline). Cost/reliability: same Supabase project (no new
  third party), fires only on the rare timeout path, ~5s budget — negligible.
  Hard network errors (`TypeError`/`NetworkError` — DNS, unreachable host,
  dropped connection) still flip the **fetch** signal immediately (they fail
  fast), but a failed fetch is **not** assumed to mean the *device* is offline —
  a cross-origin backend behind a CDN/gateway surfaces an overload as a
  CORS-less 5xx or a dropped connection, which `fetch` reports as a `TypeError`
  indistinguishable from a genuine disconnect. So the *label* keys off
  `navigator.onLine`: a failed fetch while the device still reports a connection
  is shown as **"Down"** (backend unreachable), not "Offline" — see *Offline UX*.
- `CACHE_BUSTER` wipes the persisted blob on schema change; the outbox and
  Supabase data are unaffected (server is canonical).
- **All client caches are scoped to the signed-in user and purged on account
  change.** Because Readmo supports sign-out and renders private/tokenized
  content, a shared cache on a shared device could let user B rehydrate user
  A's data before the network corrects it. Key the IndexedDB store **and** every
  Workbox runtime cache by `auth.uid()`, and on any auth transition (sign-out,
  or sign-in as a different subject) purge the previous user's IndexedDB store +
  named Cache Storage buckets before the new session paints (treated like a
  `CACHE_BUSTER` bump). The outbox is per-user, flushed-or-discarded on
  sign-out. The one place Readmo must be stricter than newshacker, which never
  had multiple identities or private content on a device.
- **On-device storage surfaces.** Until the IndexedDB move lands, the client
  keys these `localStorage` surfaces by the signed-in user id — the real
  `auth.uid()` when Supabase is configured, the mock uid otherwise — falling
  back to the unscoped base key when signed out:
  - `readmo:rq-cache:<uid>` — persisted React Query blob.
  - `readmo:item-state:<uid>` — per-item triage state (pinned/favorite/…).
  - `readmo:last-uid` — the uid that last booted (sentinel; `''` when signed
    out), used to detect an account switch that happened via a full-page reload.
  - `readmo:cache-migrated` — one-shot flag marking that the pre-scoping global
    keys were migrated into the signed-in user's scoped keys (so an upgrade
    preserves pins/favorites instead of wiping them).
  - `readmo:collapsed-feeds` — collapsed feed sections (group-by-feed view). Not
    uid-*keyed* (a single per-device key), but **subscription-derived**, so it's
    in the `clearUserCaches` purge list and wiped on every account change — a
    shared device must not carry one user's collapsed feed ids into the next. The
    pure-UI per-device prefs (`readmo:item-sort`, `readmo:group-by-feed`,
    `readmo:hide-on-scroll`, `readmo:bottom-bar`, `readmo:fontSize`, theme) carry
    no user data and stay global.
  - `readmo:chunk-reload` — the **one** `sessionStorage` (not `localStorage`)
    surface: a transient, per-tab one-shot flag set by `LazyRouteBoundary` when
    it auto-reloads to recover a stale/failed lazy route chunk, so a genuinely
    missing chunk can't reload-loop. Carries no user data, is not user-scoped,
    and clears itself when the tab session ends — so it's neither migrated nor
    in the `clearUserCaches` purge list.

  On any auth transition the departing **user's** scoped keys are purged and the
  app reloads (re-keying the singletons); the anonymous scope is preserved so an
  upgrade-while-signed-out can migrate its legacy data on the next sign-in. The
  Workbox runtime caches (`readmo-data`/`readmo-images`/`readmo-favicons`) are
  **purged** on transition/boot in PR1 but not yet per-user *prefixed* — true
  per-user keying (and the IndexedDB move) lands with real auth in PR2, when the
  NetworkFirst data cache actually holds Supabase responses (PR1 has none).

### Prefetch on Pin/Favorite (mirrors newshacker's pin/favorite prefetch)

- **Pinning** calls `prefetchPinnedStory` — stores the item's full
  `content_html` + referenced images in the persisted cache at pin time, so
  `/pinned` works offline.
- **Favoriting** calls `prefetchFavoriteStory` — same for `/favorites`.
- **Offline reader cache (`useOfflineCacheLock`).** Mounted once at the app root,
  it tracks the offline buckets (**pinned OR favorited**, matching `/offline`)
  via the shared item-state store and, while an item is bucketed, holds its
  reader queries — `['item', id]` (detail + sanitized feed body) and, for
  truncated feeds, `['fulltext', id]` (the extracted reading body) — in the
  persisted cache so the item reads offline. An idle (`enabled:false`)
  `QueryObserver` per query blocks GC while bucketed and re-locks from hydrated
  state on mount (so a reload doesn't drop them); an entry is evicted only once
  the item is in NO bucket (so unpinning an item that's still favorited keeps its
  cache). It reacts to every pin/favorite path centrally. `/offline` assembles
  its list **purely from the persisted query cache — it never issues a fetch**,
  so it doesn't depend on connectivity detection having flipped us offline yet
  (a hung or mislabeled read would otherwise leave the saved set looking empty):
  for each saved (pinned-or-favorited) id it reads the warmed `['item', id]`
  detail, falling back to any copy of the item still in a cached feed/library
  list (`findCachedFeedItem`) for an item loaded into a list but not yet warmed.
  The list re-derives on cache mutations (a just-warmed pin appears live) and is
  guarded by `useIsRestoring` so it doesn't flash the empty copy mid-hydration.
  (The library views `/pinned` and `/favorites` keep the online-first-with-cache-
  fallback read, since they legitimately want fresh server data when online.)
  **Standalone images and cross-device sync are not yet wired** — see *Open
  questions*.
- Pinned/Favorite cache entries lock at `gcTime: Infinity` while the state
  holds and re-lock on cross-tab change / rehydrate / late image fetch (the
  `subscribeToPinnedCacheLocking` pattern). Never evicted while pinned/favorited.

### Offline UX (mirrors newshacker)

- **Connectivity pill** in the header, linking to `/offline`. Its label
  distinguishes *the device has no network* from *our backend isn't answering*,
  so a server problem never reads as the user being offline:
  - **"Offline"** — the device reports no network (`navigator.onLine === false`).
    The user's problem (find a connection).
  - **"Down"** — the device has a connection but our backend isn't responding
    (overloaded / erroring / a CORS-less gateway 5xx that surfaces as a
    `TypeError`). Readmo's problem, not theirs. `title` reads "Readmo's server
    isn't responding right now"; the feed/reader views echo this in their error
    copy instead of a blanket "couldn't load".
  - No pill when fully online.
- **Detection** (`networkStatus.ts`): two signals — `browserOnline`
  (`navigator.onLine` + online/offline events) and `fetchOnline` (`trackedFetch`
  flips it on `TypeError`/`NetworkError` or any response; `AbortError` ignored).
  A three-way status derives from them: `online` (both up), `offline`
  (`!browserOnline` — the device signal wins), else `backend-unreachable`. The
  legacy boolean `online === (status === 'online')` is kept for callers that
  only gate on connected-or-not, and React Query's `onlineManager` is held in
  sync with it. `useOnlineStatus` returns the boolean; `useConnectivityStatus`
  returns the three-way status. `navigator.onLine` lags on mobile, so a *single*
  failed fetch with the OS still claiming online reads as "Down" — we don't
  mislabel a one-off server blip as the user being offline. But we don't wait out
  `navigator.onLine` forever: the recovery probe targets the always-up
  `/auth/v1/health` endpoint, so **two consecutive probe failures**
  (`OFFLINE_AFTER_PROBE_FAILURES`) — no HTTP response at all, i.e. we can't reach
  the network — flip the status to **"Offline"** on their own, without the
  `offline` event ever landing. A genuinely-down but *reachable* backend answers
  the probe with a 4xx/5xx (counted as success), so it stays "Down" and never
  trips the offline path. This is what stopped the pill from sitting on "Down"
  (or flapping "Down" ↔ "online", never showing "Offline") when the device is
  genuinely offline but `navigator.onLine` is stuck `true`.
- **"Down" self-heals.** Going `backend-unreachable` pauses React Query
  (`onlineManager.setOnline(false)`), so no app read fires to notice the backend
  recover — left alone the "Down" pill would stick on screen indefinitely (worse
  for a user reading cached content, who issues no reads at all). So
  `networkStatus.ts` re-probes the SW-bypassing liveness endpoint
  (`confirmBackendReachable`, `/auth/v1/health`) every 30s, and immediately on
  regained window focus / tab visibility, until liveness is re-confirmed. The
  probe's lifecycle keys on a liveness flag (`awaitingLiveness`), **not** on the
  connectivity status. That same flag stops the flap: **while awaiting liveness
  confirmation (and a probe is configured), a Workbox cache hit
  (`reportFetchSuccess(false)`) can no longer flip us back to `online`** — a
  cache-served GET proves nothing about reachability. The doubt is set on any
  `goOffline` (so suppression takes effect the instant we go down — no window
  before the first probe) and cleared only by a **cache-bypassing** success — a
  probe, or a non-GET request the backend accepted (Workbox runtime caching is
  GET-only, so a POST/PATCH/DELETE always reached the origin; a GET might be a
  cache hit). So the pill settles on "Down" immediately, then "Offline" after two
  *recovery-timer* failures, instead of bouncing on every cache hit. Only the
  serial recovery-timer probe advances the offline counter — opportunistic probes
  (focus/visibility/empty-read confirmations, which can overlap on one tab return)
  adjudicate the status but don't count, so a single instant can't trip "Offline".
  **Cost:** negligible — one in-process GoTrue GET (no Postgres) every 30s, only
  while liveness is in doubt.
- **Reader body from the list cache (instant open + offline fallback):** the
  reader paints this item's body from a list page already on the device the
  moment it opens — list payloads carry `content_html` (only `full_content_html`
  is stripped; see migration 0011), recovered via
  `lib/offlineItem.ts:findCachedFeedItem`. One path serves two cases: the
  **normal online open**, where the feed body shows immediately while the
  per-item `getItem` refetches in the background (no "Loading…" gap), and an
  **unpinned** article whose detail read can't reach the network (offline),
  which stays readable on its **RSS body**. A **pinned** article additionally
  layers its cached extracted body on top (the `['fulltext', id]` query, warmed
  at pin time), opening straight into the reading view. A settled `null` from
  `getItem` — the item isn't visible (e.g. after unsubscribing, RLS hides it) —
  stays authoritative and overrides the cached body, even offline. The
  full-article fetch is skipped offline. Only an article that was **never loaded
  into any list** falls through to the miss state, whose copy is a function of
  BOTH the connectivity
  status AND the actual read error (not status alone): *offline* → "This article
  isn't saved offline. Pin it while online to keep a copy." (no retry button);
  *backend-unreachable* → "Readmo's server isn't responding right now — it may be
  busy."; *online with an error* (the server responded, with an error) →
  "Unexpected response fetching this article." plus the underlying message behind
  a "Details" disclosure; *online with no error* → "Couldn't load this article."
- **An empty feed view never claims "all caught up" unless online.** The
  caught-up empty state (e.g. Home's "You're all caught up.") implies the server
  confirmed there's nothing unread. A feed view shows it only when the device is
  online and the empty result is genuine. If the view is empty while *offline* or
  *backend-unreachable* — whether the read failed, or a stale cache / fresh-enough
  persisted-empty page returned empty without ever reaching the server — the view
  shows the same miss-state copy + Retry as a failed load (*offline* → "You're
  offline. Reconnect to load items."; *backend-unreachable* → "Readmo's server
  isn't responding right now — it may be busy."; *online with an error* → it
  names the action, "Unexpected response fetching the feed list.", with the
  underlying message behind a "Details" disclosure — never the "isn't responding"
  line, since the server *did* respond) rather than a reassuring-but-unconfirmed
  "caught up". On the offline→online transition the feed forces a
  confirming refetch (it ignores `staleTime`, so a just-cached empty page can't
  short-circuit it) and holds a loading state until it settles; an already
  in-flight read (e.g. the user's Retry) is adopted as that confirming fetch
  rather than duplicated.
- **An empty feed is confirmed against a live server, not the SW cache, before
  claiming caught up.** `status === 'online'` alone isn't proof the *server*
  answered: the `readmo-data` route is Workbox `NetworkFirst` with a 6s cache
  fallback, and `trackedFetch` counts any resolved response — including a SW
  cache hit — as success, so a backend-down/lie-fi read can be served a stale
  empty page while the device still reports online. So when a feed read's *first
  page* comes back empty, `SupabaseDataSource.feedView` issues a live reachability
  probe (`confirmBackendReachable`, hitting `/auth/v1/health` — outside the
  cached `/rest/v1/` route, so the SW never mediates it) before trusting the
  result; if the backend doesn't answer, the read throws and the view shows the
  down/offline miss-state instead of "all caught up". Non-empty reads skip the
  probe (there's no caught-up claim to confirm); unconfigured/mock mode skips it
  too (no remote backend to be down). **Cost/reliability:** one extra GoTrue
  `/auth/v1/health` GET per *empty* feed read — in-process (no Postgres),
  negligible, and off the happy path for any populated feed; on failure it only
  swaps a false "caught up" for the existing miss-state.
- **Load failures are reported accurately and consistently.** Every load-failure
  surface (feed views, the reader, library views, and error toasts) renders the
  same shared panel (`components/LoadError`, copy from `lib/loadErrorCopy`): a
  friendly headline that **names the failed action and never blames the
  connection when the server actually responded with an error**, plus the
  underlying message behind an expandable **"Details"** disclosure so the cause
  is reachable on mobile (where the console isn't). The full error object also
  goes to `console.error` for desktop debugging. The on-screen detail is the
  *same* text that's logged — the rule is "anything safe to log is safe to show";
  a response too sensitive to display is too sensitive to return to the client at
  all and must be withheld server-side, not hidden in the UI. The client also
  guards the `feed_items` RPC shape (`{ item: … }` per row) and, on a mismatch,
  fails with "the database function may be out of date." rather than a cryptic
  `undefined` access.
- **Writes queue offline** (the outbox) — pin/favorite/done/hide/open reflect
  immediately and flush on reconnect; hard failures roll back + toast.

### Pull-to-refresh

- Feed + library views: PTR re-runs the view's Supabase fetches **and**
  force-checks for a newer bundle. Gesture shape identical (arm at
  `scrollTop===0` on a downward-dominant drag, 0.5× rubber-band, cap 96px, fire
  past 64px, spinner ≥400ms; `overscroll-behavior-y: contain`).

---

## Performance targets

- FCP < 1.5s on a 4G mobile profile · initial JS < 150KB gzipped · list render
  < 100ms after data arrives.

## Error handling

- Network/DB errors: inline retry + the background-refresh strip.
- Parked feed: feed-health badge + "retry now", never a silent stall.
- Missing/blank content: "No content — open the original".
- Offline write failures roll back + toast.

## Testing (inherited expectations)

- **Vitest + RTL + jsdom**; MSW for network mocking. **Always add tests**;
  **always run** `npm test` / `lint` / `typecheck` (and `build` when touching
  build/routing/deploy) before done; 80% coverage floor for `src/lib/` + server
  handlers.
- Server feed-parser tests over RSS 2.0 / Atom / RDF / JSON Feed fixtures,
  malformed feeds, missing GUIDs, relative-URL absolutization, and sanitization
  (no script survives). SSRF helper test (rejects loopback/link-local/private/
  metadata + redirects to them).
- Avoid racy tests — gate async resolution explicitly (newshacker's `gateFetchOn`).

## Deployment

- Frontend on Vercel (`main` → prod, branches → preview).
- Supabase project (Postgres + Auth + scheduled functions); migrations in-repo
  (Supabase CLI). Secrets: Supabase URL/anon key client-side; service role +
  OAuth client secrets server-side only — never ship the service role key to
  the client.
- **Image proxy (offline + reliability — *not* privacy).** Article images load
  through a same-origin `/api/img?url=…` endpoint rather than directly from the
  publisher. The driver is **user experience, not hiding the reader**:
  - **Offline.** Same-origin bytes are cleanly cacheable by the service worker
    (verifiable 200s, byte-accurate quota). A cross-origin `<img>` would cache
    only as an *opaque* response (~7 MB of quota padding each, success
    indistinguishable from an error page), so the proxy is what makes `/pinned`
    and `/favorites` images actually work offline.
  - **Not getting blocked.** A server-side fetch can set a `Referer` to defeat
    hotlink protection that a browser embed cannot (the embed's `Referer` is
    *our* origin, which reads as third-party hotlinking) and can normalize the
    User-Agent. (Header hardening is a planned follow-up; see the `img` function.)

  Privacy (the publisher sees the proxy IP, not the reader's) is an *incidental*
  side effect, **not a goal** — and it cuts both ways: funneling every reader's
  image loads through a few server IPs **concentrates** traffic and risks the
  publisher rate-limiting or banning the proxy IP. There is **no server-side byte
  cache today** (Vercel edge-caches only on `s-maxage`/`CDN-Cache-Control`, which
  `/api/img` does not set; a bare `max-age` is browser-only), so a popular
  article fetches the same image from the publisher once per *cold client*.
  Closing that is the main reliability follow-up — see *Shared image cache* under
  *Open questions*.

  The sanitizer rewrites `<img src>` / `srcset` to the proxy and **collapses a
  responsive `srcset` to a single width** — the candidate closest to ~1600px CSS
  (720/860px reader column × ~2× DPR, erring large for retina) — dropping
  `srcset`/`sizes` so each image is one fetch + one cache entry instead of one
  per advertised width. `<picture><source>` art-direction is preserved (media
  queries kept; each source likewise collapsed to one width).

  **Security (retained regardless of the above):** every fetch goes through the
  SSRF-hardened helper (guardrail #6 — this is a security control, independent of
  the privacy framing); only raster image types are served — `image/svg+xml` is
  **refused** (a same-origin SVG can run inline script as a top-level document) —
  with `X-Content-Type-Options: nosniff` plus a `default-src 'none'; sandbox` CSP
  on the bytes as defense in depth. Tracking-pixel stripping falls out of this
  for free but, again, isn't the point.

## Analytics

- Cookieless web analytics at the app root (basic audience metrics), fail-open,
  same posture as newshacker.

## Open questions

- **Shared image cache — direction: Cloudflare.** Today `/api/img` has no
  server-side byte cache, so each cold client re-fetches the same image from the
  publisher through one of a few server IPs — the concentration that risks a
  publisher ban (see *Image proxy*). Cloudflare already fronts the API for rate
  limiting (`infra/cf-gateway/`), so it's the chosen layer for the image cache
  too — one layer, both goals, free tier. A **Cache Rule** on the image route
  (cache-everything, key on the full `?url=` query string, cache 200s only — the
  shim now sends `Cache-Control: no-store` on every error so a transient 403/5xx
  can't stick for the long image TTL). Exact Cloudflare settings live in SETUP.md
  *Shared image cache via Cloudflare*. Cost/reliability (guardrail #5):
  **negligible** — caching + the rate-limit rule are free, and a HIT never
  reaches Vercel or Supabase. Drops publisher hits from once-per-cold-client to
  ~once-per-POP free (→ ~once-per-region with free Tiered Cache; ~once globally
  only with paid Argo Smart Routing, ~$5/mo — off by default).
  Considered and rejected: **Vercel Edge Cache** (`s-maxage`) — works but is
  Vercel-only and doesn't also give rate limiting; **Supabase Storage** —
  strongest (one global fetch per image) but adds egress cost + an eviction
  policy, not worth it once Cloudflare is in the path. Pair with **`Referer`/
  User-Agent hardening** on the `img` fetch to cut hotlink 403s, sequenced behind
  reading the real upstream-status mix in the new `img` failure logs.
- **Item retention / GC** — items per feed; exact pin-against-GC rule for
  Pinned/Favorite/Done. Start generous (e.g. 90 days or 200 items/feed,
  whichever is larger; never GC Pinned/Favorite/Done); revisit with data.
- **TTLs, window & floor** — the 30-day Done/Opened retention, the 3-day feed
  freshness window, and the 10-item per-feed floor (`TTL_MS` / `HOME_WINDOW_MS`
  / `FEED_FLOOR`) are first-cut values; revisit with usage data. Consider
  whether the window/floor should be user-configurable or per-feed rather than
  single constants.
- **Realtime sync** — ship in MVP or rely on refetch-on-focus + PTR? (Leaning
  defer.)
- **Full-text fetch — shipped (lazy on open + cached on pin).** Readability
  extraction for truncated feeds is the reader default (see *Reader view →
  Full-text reading mode*), keyed off a per-item truncation heuristic rather than
  a per-feed opt-in. It fetches when the reader is opened, and **pinning or
  favoriting caches the item detail + reading body for offline** and evicts when
  the item leaves both buckets (`useOfflineCacheLock`; see *Prefetch on
  Pin/Favorite*). Deferred follow-ups:
  - **Image bytes cached via SW.** After warming the item detail and full-text,
    `useOfflineCacheLock` fires background `fetch()` calls for every `/api/img`
    URL found in the HTML so the service worker's `CacheFirst` handler populates
    the `readmo-images` cache entry for offline reading.
  - **TODO — sync the readable version across a user's devices.** The extracted
    body is cached on the shared `items` row server-side, so any device that
    *re-reads* the item gets it; the offline/IndexedDB copy is currently
    per-device. Fold full-text into the offline/sync milestone so a pin on one
    device makes the readable body available offline on the others.
  - **TODO — invalidate cached full text when the source article changes.** The
    poller/refresh upserts on `(feed_id, guid)` and can update `content_html`
    without clearing `full_content_html` (the `fulltext` function is its only
    writer), so an edited article keeps serving stale reading-mode text. Proper
    fix depends on real edit detection — `content_hash` is currently just the
    guid, not a body hash — so wire that up first, then clear/refresh
    `full_content_html` when the body hash changes.
  - Smaller: per-feed override (force on/off), poller pre-fetch for known
    truncating feeds, and caching `empty`/`auth` outcomes (vs. only terminal
    React-Query caching client-side today) to avoid re-fetching hopeless pages.
- **Push notifications / Periodic Background Sync** — deferred; the poller is
  the natural trigger.

---

## Appendix: agent guardrails (carry these into the build)

The load-bearing rules from newshacker's AGENTS.md, applied unchanged:

1. **Always add tests; always run them** before reporting done. Fix a red
   baseline first, on its own commit.
2. **Fewer, larger tap targets.** ≤3 zones per row (two shipped); 44×44 touch
   floor; ≥8px gaps. Flag anything that adds a fourth tappable or fills the
   reserved slot.
3. **US English everywhere.**
4. **Keep this SPEC in sync with reality** — update it in the same commit as
   any reversed/extended decision or new user-visible behavior, tap target,
   storage surface, route, or layout reorder.
5. **Call out cost and reliability up front** for any new infra or external
   call (free-tier vs. paid, rough $/mo, failure modes, rate limits, latency).
   Say "negligible" explicitly rather than omitting.
6. **Sanitize all publisher HTML server-side** and **route every server-side
   fetch through the SSRF-hardened helper.** Feed content and user-supplied
   URLs are Readmo's untrusted input.
7. **RLS is the per-user boundary** — every per-user table gated on
   `auth.uid()`; client never gets the service-role key; fail closed.
   `feeds`/`items` are shared but **not** world-readable (subscription- or
   permanent-state-scoped); keep secret/tokenized feed URLs server-only.
8. **Scope client caches by `auth.uid()` and purge on account change** — never
   leak one user's cached content to the next on a shared device.
9. **Match newshacker's UX by default.** When in doubt about an interaction,
   do what newshacker does; only diverge for the documented RSS-specific
   reasons (no comments/votes, server-side data, accounts/sync).
10. **Branching:** one topic per `claude/<short-topic>` branch off `main`; one
    commit per logical surviving change; PRs ready for review.
