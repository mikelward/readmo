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
  first; pinning a body row keeps its position; consolidation to the top block
  lands on the next re-materialization of the set (a load/return past the 6h
  freshness TTL, or a pull-to-refresh), not on the local action or a
  cross-device sync.
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
  inner (brand mark + wordmark, Offline pill, Search) tracks the
  article column max-width — 720px, widening toward 860px on roomy screens
  (from ≥960px, the same breakpoint that widens `.app-main`) — so it aligns
  with the list below. Because the inner shares the row with the
  absolutely-positioned edge controls, the desktop widen is clamped to
  reserve ~100px of gutter per side (so the signed-out "Sign in" chip never
  overlaps the Search target); the inner reaches the full column-aligned
  860px once the viewport clears ~1060px. Safe-area
  insets reserve space for landscape-iPhone notches on the edge controls.
- **Navigation drawer sections:** Home (link to `/`), Library (Pinned / Favorites / Done / Opened / Offline), Feeds (subscription list, with an **edit pencil** beside the heading linking to the Feeds management page at `/feeds`), Appearance (the **Dark/Light mode** and **Text size** pickers — kept here because they're the most-changed settings and the drawer is one tap from anywhere), App (Settings, About). The remaining appearance controls (Color Theme, Font) live in Settings; Debug is reached from the About page (not the drawer). Feeds and Settings are also reachable from the **account menu** (top-right avatar); the menu also shows a **FAMILY** chip beside the signed-in email when the user is on the trusted-user allowlist, and an **Admin** link to `/admin` for admin users (both hidden otherwise — see *Admin* and *Full-text reading mode*). **Not yet in the drawer (TODO):** the Home feed picker (All subscriptions / per-folder) and a Folders nav section were dropped pending a proper design; `/` still renders the All-subscriptions river by default (`useHomeFeed`). The Dark/Light mode and Text size pickers are shared components (`ThemeModeControl`, `TextSizeControl`), so the drawer and Settings render the identical controls.
- **Dark mode:** full light/dark/system via tokens.
- **Palette:** two color families selectable in Settings, orthogonal to the
  light/dark/**mode** axis — **Ink** (default, the monochrome ink-on-paper above)
  and **Grape** (a vivid violet: grape accent
  `--rm-accent: #6d2c91` light / `#cba6ed` dark on faintly grape-tinted paper);
  both clear 4.5:1. Mode drives
  the `data-theme` attribute, palette drives `data-palette`; each palette ships
  its own light and dark variants. The brand mark's tile follows the palette
  (near-black ink tile by default, deep grape under Grape) via the
  `--rm-brand-tile` / `--rm-brand-fg` tokens; the non-ink palette freezes the
  tile to its deep accent across both modes for recognizability.
  In Settings the **Color Theme** picker renders each option as a two-tone
  color **swatch** (paper background + accent, split on the diagonal), with the
  active palette's swatch ringed.
- **Text size:** a third orthogonal appearance axis with six steps — Extra
  Small (14px), Small (15px), Medium (16px, default), Large (17px), Extra Large
  (18px), Huge (19px). Selectable in Settings
  ("Text size" section) as a segmented row of capital-**A** glyphs of
  increasing size (accessible name from each button's label). The choice drives the `data-font-size`
  attribute on
  `<html>` (Medium = 16px owns the bare `:root`, no attribute), which maps to
  the `--rm-font-size` token; the token sets the **root** (`html`) font-size so
  the `rem`-based type throughout the UI — including the reader article body —
  scales with it. In the navigation drawer's quick **Appearance** section the
  same picker uses a fixed 3-column grid (`text-size--grid`) so the six sizes
  render as two even rows of three in the narrow panel.
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
  exclusive). Done items are filtered out of every feed — **except a pinned
  row**: Pin and Done are mutually exclusive by construction, but if a
  cross-device / offline last-write-wins race ever leaves a row *both* pinned
  and Done, the **pin wins** and the row stays visible in the feed (never
  dismissed, never grayed), matching the server, whose feed read returns a
  pinned row regardless of Done/Hidden. The `/done`
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
- **Dismissal swipes hold off-screen until the row unmounts.** Marking a row
  Done flips the store, and the client-side `visibleItems` filter drops it on
  the next React commit (a tick later) — so the swipe-right exit animation keeps
  the row translated off-screen + opacity 0 after `handleHide` fires instead of
  resetting to rest, covering that brief window. Otherwise the row would visibly
  snap back into place before it unmounts. Swipe-left Pin still snaps back (the
  row stays mounted and reflows to the top).
- **The feed view filters Done/Hidden client-side; that overlay IS the removal.**
  A local mutation (single-row swipe, Sweep) no longer refetches the active view
  (mutations mark the feed stale but reconcile lazily — see *Feed views → A
  dismiss never refetches*), so the client-side overlay is what drops the row,
  not a refetch. The DataSource still returns clean pages on the next genuine
  fetch, but until then the store overlay is authoritative. Without it the
  dismissed row's `<li>` would keep its 56px in the flow while only its
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
(`HOME_WINDOW_MS`), OR among **its feed's newest 10 items by date**
(`FEED_FLOOR`), with Done/Hidden then filtered from the body. The window
declutters a busy feed to "recent only"; the floor keeps an
**infrequently-updated feed from going blank** when nothing it published is
recent — you always see at least its latest handful. Both are knobs
(`HOME_WINDOW_MS` / `FEED_FLOOR`); the server `feed_items` RPC applies the same
3-day interval and a `row_number()`-per-feed floor in its body branch.

- **Pinned items are exempt** from both — a pin keeps an item regardless of age.
- The floor ranks the feed's items **by date, irrespective of read/done state**:
  a Done item still occupies its recency slot, so dismissing a recent item
  **shrinks** the feed (and counts the badge down) rather than pulling an older
  item up to refill the floor. If a feed's newest 10 are all Done, it shows
  nothing more (pins and in-window items aside) — "don't serve more". (This
  reverses an earlier decision where the floor ranked only non-dismissed items
  and so topped a feed back up to 10 unread as you read it.)
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

### Mirror dismissals and pins to newshacker (companion app)

Dismissing (**Done**) or **pinning** a **Hacker News** story in Readmo can also
update the matching list on **newshacker** (the sibling HN reader), so the two
apps stay in step for HN feeds. One-way today (Readmo → newshacker); opt-in per
account.

- **Why it's possible.** Readmo already derives the numeric HN item id from an
  HN-feed item (`src/lib/newshacker.ts`, used by *Open on newshacker*). newshacker
  already syncs per-user `done` **and** `pinned` lists. This feature bridges them.
- **Auth model (B2).** newshacker mints an **app token** (its Settings →
  *Connected apps*); the user pastes it into Readmo's Settings → *newshacker*
  once. The token is a bearer credential newshacker accepts on its `/api/sync`.
  We use a **server-to-server** call (not a browser cross-site fetch) precisely
  so third-party-cookie blocking (Safari/Firefox/Brave defaults, hardened
  profiles) can't break it — it works uniformly on every browser/PWA. A future
  **B3** (OAuth-style one-tap linking) would replace the paste, reusing the same
  token; tracked as a TODO.
- **Token storage.** `newshacker_link (user_id PK, token, created_at)` (0050),
  **RLS deny-all** — reachable only via `SECURITY DEFINER` RPCs
  (`set_newshacker_token` / `clear_newshacker_link` / `newshacker_link_status`,
  scoped to `auth.uid()`, never returning the token) and the service_role. The
  client never reads the token (guardrail #7). *TODO(security): encrypt at rest
  with Vault; plaintext in the RLS-locked table is acceptable for now since the
  token only grants the user's own Done-list sync and is revocable from either
  side.*
- **Mirror path.** `useNewshackerSync` (mounted in `App`, active only when
  linked) listens to the item-state store's **mutation** events — **user-driven
  only** (set/hide/sweep/undo), never hydration/cross-device sync, so a pin/Done
  arriving *from* another device is never echoed back out (mirror on the local
  event, not on every sync). It coalesces a burst (~1.5 s), resolves the ids to
  HN item ids (`buildMirrorPayload`; non-HN items drop out), and calls the
  **`newshacker-sync` Edge Function**, which reads the caller's token
  (service_role) and `POST`s `{ done: [...], pinned: [...] }` to newshacker's
  `/api/sync` with `Authorization: Bearer`. A `false` value (un-dismiss / unpin)
  sends a tombstone. The target host is a compile-time constant
  (`NEWSHACKER_ORIGIN`), so there's no user-controlled URL / SSRF surface — this
  deliberately bypasses the generic SSRF helper, which would strip the credential
  we intend to forward. **Wire back-compat:** the Done list rides the legacy
  `entries` key (pins under a new `pinned` key), so an older, not-yet-redeployed
  function still mirrors dismissals; pins start once it's redeployed.
- **Tombstone resolution.** An un-dismiss / unpin can clear the *last* permanent
  state (`pinned`/`favorite`/`done`) that kept an unsubscribed feed's item
  RLS-visible (`items_select`, 0002), so a post-mutation `getItemsByIds` would
  return nothing and the tombstone would be lost. To avoid that, every HN-feed
  row **and the reader** remember their numeric id while on screen
  (`newshackerItemIds.ts`), and the mirror resolves from that render cache first,
  fetching only ids it hasn't seen.
- **Not mirrored: the open-on-newshacker handoff.** Opening an item *on
  newshacker* (open-on-newshacker mode) with *Mark done when opening* marks it
  Done in Readmo, but that Done is a **handoff, not a dismissal** — mirroring it
  would sweep the item to Done on newshacker at the moment you arrive to read it
  there (and it'd fight the planned reverse sync below). So the row's open
  handler registers a one-shot suppression (`newshackerMirrorSuppress.ts`) that
  the hook consumes and skips. Opening the **original source** with mark-done, or
  any explicit dismissal (swipe/Sweep/menu) or scroll-away Done, still mirrors.
  This is also the only same-tab-unload dismissal path, so excluding it means the
  remaining dismissals all happen with the app open (no unload race).
- **Stretch goal (TODO, not built): reverse sync** — pull newshacker's own
  `done`/`pinned` (a `GET /api/sync`) and apply it to Readmo `item_state`, mapping
  each HN id back to a Readmo item the user has. This is why the open-on-newshacker
  Done isn't pushed forward: once you hand off, newshacker should own that item's
  Done and sync it back. (Pushing pins Readmo → newshacker — the former stretch
  goal — now ships above.)
- **Best-effort.** Every failure (signed out, function not deployed, unlinked,
  newshacker down) is swallowed; the local Done/Pinned state stays authoritative.
  The whole feature feature-detects: a backend without the 0050 RPC just reports
  "not linked" and the Settings section hides.
- **Cost/reliability (guardrail #5).** No new third-party account — reuses the
  Supabase Edge Function runtime and one small first-party call to newshacker per
  debounced batch of HN Done/Pinned changes. **Negligible.** Failure mode: the
  mirror no-ops; Readmo is unaffected. **Manual deploy:** `make migrate` (0050) +
  `make deploy` (the `newshacker-sync` function) — and newshacker's app-token
  endpoint must be live first.

### Schema (sketch)

```
users         (id, oauth_subject, email, created_at, …)               -- Supabase auth
feeds         (id, url UNIQUE, secret_url, site_url, title, favicon_url, etag,
               last_modified, last_fetched_at, next_fetch_at,
               fetch_interval_s, error_count, last_error)             -- shared across users
items         (id, feed_id FK, guid, url, comments_url, title, author,
               published_at, content_html, summary, full_content_html,
               full_content_fetched_at, full_content_via_fallback,
               enclosures, content_hash, created_at,
               sort_at = coalesce(published_at, created_at))          -- shared; UNIQUE(feed_id, guid), UNIQUE(feed_id, url) WHERE url IS NOT NULL
subscriptions (user_id FK, feed_id FK, folder, title_override,
               muted bool, open_original bool, open_newshacker bool,
               mark_done_on_open bool, list_layout, sort, created_at)  -- user ↔ feed
               -- list_layout: per-feed card-style override; NULL = app-wide setting
item_state    (user_id FK, item_id FK,
               pinned bool, pinned_at, favorite bool, favorite_at,
               done bool, done_at, hidden bool, hidden_at,
               opened bool, opened_at)                               -- PK(user_id,item_id)
               -- each *_at is the field's last-change time = its LWW clock
folders       (user_id FK, name, sort)
newshacker_link (user_id PK/FK, token, created_at)                    -- companion-app token; RLS deny-all, server-only (0050)
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
  feed's newest 10 by date (Done/Hidden occupy a floor slot but are filtered
  afterward, so a dismissed recent item isn't backfilled by an older one). To
  keep that **index-bounded** (never rank a feed's full archive), `feed_items`
  assembles the body from three candidate sets — a freshness range scan, a
  per-feed top-10 `LATERAL … ORDER BY sort_at DESC LIMIT 10`, and the pinned
  partial index — each riding
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
  `{ guid, url, commentsUrl, title, author, publishedAt, contentHtml, summary,
  enclosures }` (maintained parser, e.g. `fast-xml-parser` + a normalizer).
  `commentsUrl` is the item's discussion page — RSS 2.0 `<comments>` or Atom
  `<link rel="replies">` (RFC 4685), absolutized, strict (never the article
  link); null when absent. Stored on `items.comments_url`; distinct from `url`
  (the article) so aggregator feeds (Hacker News, lobste.rs) keep the thread
  link separately.
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
- **Canonicalize the article `url` before it's stored/de-duped** so the
  `(feed_id, url)` key catches re-issues that differ only cosmetically. The
  same `(feed_id, url)` key only collapses re-issues whose URL is
  byte-identical, but publishers (notably the BBC) re-issue the same story with
  a rotating campaign query tag (`?at_medium=RSS&at_campaign=…`), so the raw
  URLs differ and the same headline lands two or three times in one feed. The
  parser (`canonicalizeItemUrl`) strips known tracking/campaign params (UTM,
  BBC `at_*`, click ids) — keeping load-bearing params, the path, **and the
  fragment** (fragments are load-bearing: SPA routes `#/…`, liveblog/update
  anchors `#block-123`/`#124`; the BBC version counter rides on the `<guid>`,
  not the `<link>`) — so every stored `url` is canonical and campaign-tagged
  re-issues collapse to one row. Both writers (poll + refresh) build rows from
  the parser, so both inherit it. Migration `0048` canonicalizes the
  already-stored backlog, collapses the resulting dupes (SQL twin
  `canonicalize_item_url()`), and installs an `items_canonicalize_url`
  `BEFORE INSERT OR UPDATE OF url` trigger so the DB canonicalizes every write
  regardless of which (possibly not-yet-redeployed) caller performs it.
- Cross-feed dedup — same URL appearing in two distinct subscribed feeds — is
  out of scope here; tracked in `TODO.md`.

### Feed discovery

- **The Feeds route is code-split.** It carries the curated popular-feeds
  catalog (`src/lib/popularFeeds.ts`, the app's largest static data blob) and is
  visited rarely, so `/feeds` is lazy-loaded as its own chunk on navigation
  rather than baked into the initial bundle; the service worker precaches the
  chunk, so it stays available offline after the first load. If that chunk fails
  to load — a stale content-hashed asset after a deploy, or a network failure
  before precache — `LazyRouteBoundary` reloads the page once to recover, and if
  that still fails it shows a centered recovery state: the message "This page
  couldn't be loaded." above a **Reload** button (≥44px touch target) that
  re-attempts a full reload.
- The Feeds page's **Add a feed** input shows a filtered autocomplete dropdown as
  the user types. Suggestions come from a curated list of popular feeds
  (`src/lib/popularFeeds.ts`); each entry carries a display name, direct feed
  URL, and category. Matching is case-insensitive substring on the name, the
  feed URL (so a country code like `au`/`uk` finds `.com.au` / `.co.uk`
  outlets), or the category (so a topic like `science` or `sports` surfaces
  that section); matches are also made by **acronym/initialism** — the typed
  letters as a subsequence of the name's word-initials, so `wsj` finds "Wall
  Street Journal", `nyt` finds "New York Times" (a leading "The" is skipped for
  free), and `scmp` finds "South China Morning Post" (the matcher lives in
  `src/lib/feedSearch.ts`; substring hits rank above acronym-only hits, and
  acronym matching needs a 2+ char query). Up to 8 suggestions are shown. While
  the box is **empty**, focusing it shows a short curated set of recommended
  starter feeds (`RECOMMENDED_FEEDS` in `src/lib/popularFeeds.ts` — five
  broadly-appealing, freely-readable feeds with no paywall/login) as the top
  suggestions, so a new account with nothing subscribed has a starting point;
  typing replaces them with the fuzzy matches above. The input's placeholder
  and `aria-label` are "Feed name or URL". A line of helper text under the
  input ("Type a site, a topic, or a country code to see suggestions.") points
  first-time users at the typed-search path. Because the field accepts a feed
  **name**, submitting resolves a typed name to its catalog feed and subscribes
  via the curated path (`resolveFeedByName`), but only when the query *is* a
  feed's identifier — an **exact name** (so dotted names like `Inc.` or `The
  A.V. Club` resolve) or an **exact, unique acronym** (`wsj` → "Wall Street
  Journal", `fcc` → "freeCodeCamp"). Never a substring, URL, category, or
  partial: real URLs/hosts (`openai.com`), partial names (`guardian`), and broad
  topic/country-code words the helper invites (`programming`, `health`, `ai`,
  `au`) are never a feed's exact name/acronym, so they resolve to nothing and
  are picked from the dropdown instead of auto-subscribing an off-screen hit. So
  typing `wsj` or `Wall Street Journal` and pressing **Add** works without
  picking; known shorthands (`r/sub`, `youtube/<handle>`), real URLs and hosts
  fall through to discovery. Selecting a suggestion fills
  the feed URL directly into the input and bypasses the HTML-discovery step —
  the known feed URL is submitted straight to `subscribe()`. This also avoids
  bot-blocking issues for popular sites whose homepages reject programmatic
  requests (the RSS endpoint itself is almost always accessible). **The one
  exception is a suggestion (or resolved name) that belongs to a publisher we
  carry a curated section list for** (see *Curated section feeds* below): that
  opens the section picker instead of subscribing to the single picked feed. The dropdown
  is keyboard-navigable: ArrowDown/Up move focus, Enter selects, Escape closes.
  When the user subscribes via a curated suggestion, the client always sets the
  subscription's `title_override` to the curated display name — the brand the
  user picked beats whatever the publisher's `<channel>` happens to say (e.g.
  The Economist's `/latest/rss.xml` is literally titled "Latest Updates"). The
  override is per-user and editable from the Feeds page → Subscriptions (see below),
  so users can revert to the publisher's title or pick their own. The curated
  name is captured at the moment the user submits the form, not later, so a
  concurrent autocomplete interaction can't corrupt the override.

- `POST /api/discover { url }` accepts a site or feed URL; for an HTML page,
  parse `<link rel="alternate" type="application/rss+xml|atom+xml|json">` and
  common fallbacks (`/feed`, `/rss`, `/atom.xml`, `/feed.json`); validate by
  fetching+parsing each candidate before offering it.
- **Google News feeds (`news.google.com/rss/…`) are gated on the trusted-user
  allowlist** (the DB `allowlist` table — the same list as full-text reading
  mode, managed from */admin*; see *Full-text reading mode*), because they are a
  Google-ToS gray area. The check is enforced **server-side in `discover`**, with
  two behaviors by intent: an **explicit paste** of a `news.google.com` feed by a
  non-listed caller is rejected with a `blocked` add-feed error (clear message —
  they asked for it), while a **discovered or synthesized** Google News candidate
  (an advertised `<link rel="alternate">`, a redirect target, or the *last-resort
  Google News fallback* below) is **silently dropped** for non-listed callers —
  offer the other candidates, or fall through to "no feed found" — since the user
  never asked for Google News and a block there would confuse. Either way a
  non-listed caller can't end up subscribed to a Google News feed.
  The normal UI paths that skip discover are closed too: the **curated catalog
  carries no Google News feed** (a curated pick goes straight to `subscribe()`),
  and **OPML import routes any Google News URL through `discover`** rather than a
  direct `subscribe_to_feed`. A **hand-crafted direct `subscribe_to_feed` RPC
  call** with a Google News URL is the one remaining bypass; closing it correctly
  needs real `new URL()`/IDNA canonicalization (which a SQL gate can't replicate),
  so it's **deferred to a follow-up** that does the check in an Edge layer
  (tracked in `TODO.md`). It's low-risk: `discover` (the authoritative gate) still
  covers every normal path, and an empty allowlist → open to all, so none of this
  bites until the operator seeds the table.
- **When discovery returns more than one feed**, the Feeds page's **Add a feed**
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
- **Curated section feeds.** Big news orgs publish many per-section feeds
  (World, Business, Sport, …) but often advertise *none* of them where a crawler
  can see — BBC's feeds live on a separate host and are only listed on a help
  page, so live discovery of `bbc.com` finds nothing and would fall through to
  the Google News last resort. So for a small, hand-curated set of major
  publishers (`src/lib/feedSections.ts` — BBC, The Guardian, NPR, CBC at first,
  extensible), the **same multi-select picker** is populated from a stored list
  of that publisher's section feeds (**main feed first**, capped at ~10) the
  moment the user adds the site — no fetch, no discovery round-trip. It fires
  when the user adds a curated publisher **by name** (a dropdown pick or a
  resolved catalog name) **or by its site URL** (`bbc.com`, `bbc.co.uk`).
  Pasting a *specific feed* URL — even on that publisher's host (e.g.
  `theguardian.com/world/rss`) — still subscribes to just that feed (the user
  "meant that feed"); the distinction is a feed-shape check on the pasted URL.
  Each chosen section's curated label is pinned as the per-user `title_override`
  (so rows read "BBC World", not a generic channel title), per-user and editable
  like any curated pick. This is purely additive: any publisher *not* in the
  list keeps today's behavior (live discovery → its advertised feed(s) → the
  allowlist-gated Google News fallback). The list follows the
  `popularFeeds.ts` convention — URLs match each publisher's documented feed
  scheme but aren't live-verified in the sandbox; `npm run feeds:check` covers
  them.
- **Deep-link fallback: pasting an article URL still finds the site's feed.** A
  pasted article (e.g. a Sky Sports match report deep in `/football/news/…`)
  usually doesn't advertise the site's feed in its own `<head>`, so when the
  submitted page advertises **no feed of its own**, discovery re-probes the
  **site home page** (the origin root) — which almost always does carry the
  `<link rel="alternate">` tags — before reporting failure. Skipped when the
  submitted URL is already the root, and skipped when the page *did* advertise a
  feed that's merely gated/dead/unreachable (that specific reason is surfaced
  instead — see below — rather than masked by the site's generic home feed).
  This is one extra fetch only on the otherwise-empty path.
- **Last-resort fallback: a Google News feed when the publisher advertises
  none.** If neither the pasted page nor the site home page yields a real feed,
  discovery offers a **Google News `site:<domain>` RSS search** — a
  continuously-updated feed of that publisher's recent articles, assembled by
  Google rather than the publisher — so the reader still gets *something* rather
  than "no feed found". The publisher's own feed always wins when one exists;
  this fires only when the page advertises **no feed at all** and only when the
  search actually returns recent items for the domain. When a page *does*
  advertise a feed that's gated/dead/unreachable, that specific reason
  (`auth`/`not-found`/`unreachable`, below) is surfaced instead — Google News
  does not override it. **Gated by the trusted-user allowlist** (see *Google News
  feeds … gated* above): when the `allowlist` table is non-empty, this fallback
  is offered only to listed callers; a non-listed caller skips it and just gets
  "no feed found". (Cost/reliability: see *External services* in CLAUDE.md — free,
  no API key, unofficial endpoint.)
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
  parse, upsert new items, schedule `next_fetch_at`. The ≥1-subscriber predicate
  is enforced in SQL by `feeds_due_for_poll()` (migration 0044), so a feed with
  no subscribers is never polled — including one the reaper preserved because a
  pin/favorite/done keeps its items alive (we keep the items but stop fetching).
- **Reap feeds with no subscribers.** Each run first calls `reap_orphan_feeds()`
  (a service-role SQL function, migration 0042), which deletes every feed that
  has **no `subscriptions` row AND no permanent (pinned/favorite/done)
  `item_state`** on any of its items — cascading its items and their sparse
  per-user rows away. This is the GC for feeds abandoned by unsubscribe, account
  deletion, or an admin deleting a user (all cascade `subscriptions` away),
  so the poller stops fetching them and we stop retaining content no one can
  read. The permanent-state exemption **mirrors the `feeds_select` RLS test
  (branch (b))** so a feed kept alive solely by someone's pin/favorite/done is
  preserved and their kept items are never GC'd out from under them; once the
  last such flag is cleared and the feed still has no subscribers, the next run
  reaps it. Cost: one set-based `DELETE` per run — negligible at reader scale.
  `subscribe_to_feed` takes a `FOR KEY SHARE` lock on the feed row it resolves
  (migration 0043) so a concurrent reap can't delete a just-abandoned feed out
  from under an in-flight re-subscribe (which would FK-fail the "Add feed").
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
  connection-pool starvation (PostgREST pool timeouts) and slow/storming query
  rate (`pg_stat_statements_*`, covering all backends incl. PostgREST, plus
  `http_status_codes_total` for the gateway view), and DB-unreachable (a failed
  scrape). The Metrics API exposes **no per-`queryid` series** (only aggregate
  `pg_stat_statements_total_*`) and no query-duration histogram — so these
  alerts say *the DB is starving / flooded*, and the per-query/per-`queryid` truth across all
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
  deterministic, offline, zero requests); tap → popover with name, **Feeds**,
  **Settings**, and **About** links, and "Sign out". Dismissal is the shared dropdown
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
  outbox keyed by `item_id` recording the changed fields and the action's
  timestamp; on reconnect it flushes to Postgres, coalesced and serialized per
  item. The UI reflects it immediately, rolling back only on a non-transient
  server rejection (lost item visibility — never a sync conflict).
- **Conflict resolution is per-field last-write-wins on the action timestamp.**
  Each field carries the wall-clock time of the action that set it (`<f>_at`,
  which doubles as the field's ordering/TTL key, read only while the flag is
  true). `set_item_state` keeps, per field, whichever write has the newer `at`.
  So two devices touching independent booleans never conflict, and a stale
  offline replay loses to a newer change instead of clobbering it — it is simply
  superseded, with no version numbers, base tracking, conflict rejection, or
  hold-for-hydration machinery (this is the same model newshacker uses, and
  replaced an earlier server-assigned-`version` scheme whose conflict/reconcile
  apparatus was far heavier than per-item boolean flags warrant). Pin/done/hidden
  **exclusivity is maintained by the client**: every triage write the client
  sends to the server is exclusivity-closed (a Pin carries Done=false +
  Hidden=false, a Done/Hide carries Pinned=false, all stamped with the same `at`)
  — and the closure is *unconditional*, emitted even when the local mirror already
  shows the cleared field false (it may be stale relative to the server), so a
  stale mirror can't leave an invalid pinned+done row. Per-field LWW then lands on
  a consistent state without the server re-deriving it. The trade vs. a server clock: a device with a badly
  wrong wall-clock can mis-order its own writes — accepted (single-writer client,
  two-user app), the same trade newshacker makes.
- **Refetch-on-focus.** Boot hydration of `item_state` is memoized and never
  re-runs on its own, so a backgrounded tab would keep showing the pins it
  loaded at boot. `DataSource.resyncState()` re-pulls the caller's `item_state`
  rows; `useStateSync` (mounted app-wide) fires it when the tab regains focus or
  visibility, or the device comes back online, so a pin / favorite / done made
  on another device syncs in without a manual pull-to-refresh. Overlapping calls
  coalesce (one tab return can fire both `focus` and `visibilitychange`). The
  hydrate reconciles **per field by last-write-wins** on each field's `<f>At`
  clock — the same rule the server's `set_item_state` applies: an un-synced or
  just-made local change carries a newer clock than the (possibly pre-write)
  server snapshot and survives, while a field another device changed more
  recently has a newer server clock and is adopted. This is why the client store
  keeps `<f>At` populated **even when a flag is false** (matching the server) and
  stamps every field a mutation touches — the action field *and* the
  exclusivity-cleared ones — with the same action time, so the newest action's
  fields all win together and a merge of two consistent rows stays consistent (no
  invalid pinned+done). The canonical race it dissolves is unpin-then-sweep
  during a resync: the read carries a still-pinned snapshot, but the local
  unpin/sweep clocks are newer, so LWW keeps them. On top of the clock compare,
  the hydrate **overlays the un-acknowledged changed fields** (keeping the local
  value): a write the server read can't reflect yet must not be reverted by a
  millisecond-`at` tie (the server resolves the same tie its way via `>=`) or by
  a `null` clock an older client persisted on a cleared false field. The overlay
  never overrides a **strictly newer** server clock, though: that is a
  cross-device write the pending one will lose to (the server's `>=`) when it
  lands — or one that already superseded a drained-and-won write before the
  read executed, an ordering no loss re-pull covers — so the server value is
  adopted. The overlay
  set is the union of the outbox's still-pending fields **and** any write that
  enqueued and drained entirely *within* the read window (tracked as a
  during-read note) — the latter included because its server-accepted tie leaves
  nothing pending and no re-pull, so only the overlay can hold it. A field that
  genuinely **lost** server-side is excluded: the drain drops it from the
  during-read note (a later write to the same field re-adds it, so
  lose→toggle→win keeps the re-won value), and the loss re-pull
  (`lwwLossPending` / `onPermanentReject`) reads the winner, whose newer clock
  wins the same LWW. A local row the read omits is kept only while it still has a
  **pending** write (a brand-new row that hasn't reached the server, or raced the
  read), else
  dropped as gone. The store emits on change → the feed-invalidation hook
  refetches the **unread-count** badges (a number, never a reflow) while the
  published feed set stays **frozen** and reflects the change in place through
  the store overlay (see *Feed views → A stable set of articles*); the library
  pages re-read.
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
  - **Offline writes replay from the persisted outbox**, each carrying its own
    action timestamp. An edit made before the first online read needs no
    concurrency base to resolve first — it flushes on reconnect and per-field
    last-write-wins settles it against any change another device made in the
    meantime. So there is no hold-for-hydration window, no base seeding, and no
    version normalization: the write simply goes out and the newer `at` wins.
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
  reconnect. Each changed field carries its action timestamp; `set_item_state`
  (`0023_item_state_lww.sql`) keeps, per field, whichever write has the newer
  `at`, so a stale replay is superseded rather than rejected. A transitional
  compat shim (`0024_set_item_state_compat.sql`) re-adds a trailing,
  accepted-and-ignored `p_base_version` param and treats a missing `p_<f>_at` as
  `now()`, so a pre-0023 service-worker-cached client's write still resolves and
  applies during the deploy window instead of 404ing and retrying forever (its
  item_state *read* still degrades until it reloads — `feed_items` is unaffected);
  drop the shim once no pre-0023 client remains. The hydrate path
  overlays only still-pending fields onto server truth and clears genuinely-stale
  rows. Add-feed / OPML import / parked-feed retry go through the
  `subscribe_to_feed` RPC and the `refresh` function. `main.tsx` selects the live
  source when `isSupabaseConfigured()` (else the mock seed), so a configured
  deployment boots on real RLS-scoped data. Conflict resolution is per-field, so
  two devices editing the same item never cross-conflict on independent flags;
  same-field edits resolve to the later action time. Still deferred: an
  **authenticated OPML-export RPC** — the client can't emit real feed fetch URLs
  (`feeds_public` exposes `site_url`, never the fetch URLs `url`/`secret_url`), so live
  `exportOpml` carries homepage URLs until a server-side export exists.
- **At-least-once delivery, no exactly-once needed.** The outbox can re-send a
  write that committed but whose ack was lost to a crash. Under per-field LWW a
  replay is idempotent in effect: re-applying the same field with the same (or an
  equal) `at` lands on the same value, so there's nothing to dedup and no
  follow-up to strand. (The old `version` scheme needed idempotency keys here
  precisely because a replay would `40001`-conflict; LWW removes that hazard.)

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
   - **Open original / Open on newshacker** — the per-feed **open mode**: a
     single mutually-exclusive choice of where that feed's article rows open on
     tap.
     - **Open here** (default) — the in-app reader.
     - **Open original** — the original article on the source website directly
       (new tab) instead of the in-app reader. Falls back to the reader for any
       item without a safe http(s) URL.
     - **Open on newshacker** — offered for **Hacker News feeds only** (the feed
       host is `news.ycombinator.com` or `hnrss.org`): the item's Hacker News
       discussion on **newshacker.app** (`newshacker.app/item/<hn-id>`). Unlike an
       untrusted source URL (which opens in a new tab with
       `rel="noopener noreferrer"`), newshacker is our own sibling app, so it
       opens in the **same tab** with no such hardening — that makes Readmo the
       browser's previous entry, so newshacker's own Done/back returns the reader
       here rather than stranding them in a separate tab.
       The HN id is derived client-side from the item's HN comments link — the
       structured `commentsUrl` first (the parsed `<comments>` link, carried on
       list rows), then its `guid` (hnrss feeds), then its `url` (Ask/Show HN),
       then the stored description HTML (`contentHtml`) as a backfill: the
       official `news.ycombinator.com/rss` feed carries the discussion link only
       in the item `<description>`, and a backend predating the `comments_url`
       column (0033) omits the structured field. (`ITEM_COLS` reads
       — library/search/reader — now select `comments_url`, stepping down to the
       pre-0033 column set if the backend lacks it.)
       Falls back to the reader for any item with no derivable HN id. **$0** — a
       plain deep link, no API call (see *External services*: none added).

     In any non-reader mode, tapping the row body marks the item opened (same as
     the reader; done/pin state behaves exactly as in reader mode), and the row
     gains a dedicated **Open in reader** button to the **left** of the Pin/Done
     cluster — an `Article` glyph, the same in both external modes — that
     navigates to the in-app reader and marks the item opened. Because the row
     body already opens the source/newshacker target, this button is the row's
     one remaining path to the reader, so an external-open feed still reaches the
     reader's pin/favorite/summary/full-text surface in one tap. (It replaces an
     earlier redundant button that merely re-opened the same external target the
     row body already did.) Pin and the wide-viewport Done button are unchanged. Per-user, synced (stored on the subscription, like
     Mute/Rename); reader by default. Stored as two independent booleans
     (`open_original`, `open_newshacker`) written **atomically** (one update, via
     `setOpenMode`) so they're never both true from a current client, yet stored
     separately so an older client that only knows `open_original` still works (it
     reads the reader for a feed the newer client set to newshacker mode). If both
     are ever set, ***open original* wins** — the only way to reach that state is a
     legacy `open_original`-only client writing `open_original=true`, which is an
     explicit "open original" choice, so honoring it as such (rather than letting
     the stale `open_newshacker` flag override) preserves that client's intent.
   - **Mark done when opening** — a per-feed toggle (checkbox in the same overflow
     menu, independent of the open mode above) that, when on, **marks an item Done
     the moment it's opened on its original source or newshacker discussion** — the
     `open-original`/`newshacker` row-body tap, the row's `o` shortcut, and the
     reader's **Open original** button (which then also closes the reader via the
     same Back-button ladder as Done — back to wherever the reader came from, else
     close the tab, else the home list; see *Reader keyboard shortcuts → `b`* —
     the same completion flow as Done). Deliberately **does not** fire for an in-app
     **reader** (article view) open — the setting is scoped to the outbound open
     actions, letting a "read the source and I'm done" feed clear items without a
     second tap. Marking Done clears Pinned (the usual exclusivity). Per-user,
     synced (stored on the subscription as `mark_done_on_open`, 0037, like
     Mute/Rename); off by default. Feature-detected: hidden against a backend that
     predates the column (guardrail #11).
   - **Feed-health badge** when the poller parks a feed, with "retry now".

2. **Feed views (the lists)** — the chronological merge of subscription items,
   newest first, with newshacker's rules applied verbatim:
   - **`/` (Home)** — all non-muted subscriptions merged. The per-device
     `useHomeFeed` preference can swap `/` to a chosen folder (URL stays `/`),
     but the drawer *Home* picker that set it is **not currently shown** (TODO:
     restore — see *Navigation drawer sections*); `/` defaults to the
     All-subscriptions river.
   - **No-feeds coach** — when the account has **zero subscriptions**, Home
     shows a first-run coach ("No feeds yet" + an *Add a feed* button linking to
     the Feeds page) instead of the "You're all caught up." empty state, which implies
     the user had items and read them. An account with only *muted* feeds still
     has subscriptions, so it gets the normal caught-up state, not the coach.
   - **`/folder/:name`** — a folder's merge. **`/feed/:feedId`** — one feed.
   - **Pinned prepended to the top** of every feed view, rendered once,
     oldest-pinned first; **pinning a body row keeps its position** — the click
     marks it pinned but doesn't yank it into the top block under the reader's
     eye, so they don't lose their place. Consolidation re-groups in-body pins
     into the top block, and — because pinned-first ordering is applied
     server-side — it lands on the next **refetch**: a **pull-to-refresh**, a
     **tab-focus** refresh, or a **fresh load**. A **Sweep** releases the
     in-session hold, but since a mutation no longer refetches the view (see
     *Feed views → A dismiss never refetches*) the actual re-group waits for one
     of those refetches rather than snapping on the Sweep itself. (newshacker
     consolidated on Sweep because Sweep refetched; readmo defers it so nothing
     reorders under the reader on a local action.) (When grouping by feed —
     below — pinned items lead **their own feed's section** rather than a global
     top section.)
   - **Sort & grouping** (per-device — see *Settings → Sort order* and *Group by
     feed*; applied server-side so they hold across pages, not a client re-sort
     of loaded pages):
     - **Sort order** (`readmo:item-sort`, default **`newest`**) sets the body's
       chronological order — **newest-first** (default) or **oldest-first** —
       on Home, folders, and single feeds. Pinned ordering is unaffected (always
       oldest-pin first within its section). Toggleable from Settings **and**
       from the list **top toolbar** (the **Sort order** toggle, whose glyph
       reflects the current order — see *List toolbar*), which writes the same
       per-device preference.
     - **Group by feed** (`readmo:group-by-feed`, default **off**) sections Home
       and folder lists by feed instead of one merged river. Sections follow the
       user's **manual feed order** (the `subscriptions.sort` field, set by
       drag-to-reorder on the Feeds page); within a section the chosen sort order
       applies, and that feed's pinned items sit at the top of the section. A
       feed-name header introduces each section, and **stays pinned** (sticky)
       just below the top chrome (app header + top toolbar) while the reader
       scrolls through a section taller than the viewport, so the feed a row
       belongs to — and its header controls — stay on screen instead of
       scrolling off with the section's first rows. Each header is **bounded to
       its own feed section** (each section is its own container), so only the
       current feed's header is ever pinned — the section's end pushes it back
       out as the next header arrives, rather than earlier headers piling up
       stuck behind the visible one. The pin offset tracks the live chrome height
       (the toolbar wraps to two rows on ultra-narrow phones). The header is a
       **single line** — a long feed name truncates with an ellipsis rather than
       wrapping — so the pinned band stays a constant height. No effect on a
       single-feed view.
       Toggleable from Settings **and** from the multi-feed list **top toolbar**
       (the **Group by feed** toggle, whose flat-list / tree icon mirrors the
       current layout — see *List toolbar*), which writes the same per-device
       preference.
     - **Section header controls** (group-by-feed only). Each feed's header is a
       small control strip. On the far left, a **44px chevron** button is the
       collapse control; next to it the **site favicon + feed name + unread/to-do
       count badge** link to that feed's own view (`/feed/:feedId`) — the count
       tracks the feed name's baseline, lifted a hair so it optically centers
       against the name's caps. A phantom swept section's header keeps its
       feed's favicon — emptying a section never changes its icon. When any
       header in the list carries a favicon, a header that lacks one (feed not
       yet resolved) reserves a matching 16px placeholder in the icon slot, so
       every feed name in the list starts at the same left edge instead of
       snapping flush to the chevron. A favicon that *fails to load* (a 404'd `/favicon.ico` guess, or a
       bot-blocked host like ft.com whose icon won't render in the browser) keeps
       its blank 16px box (hidden via `visibility`, not removed via `display`) so
       the name stays aligned rather than snapping left — the broken-image glyph
       is still suppressed. Then the **empty space** up to the actions
       is a second, pointer-only collapse region — so tapping *anywhere on the row
       except the feed name/icon/count and the Undo/Sweep buttons* toggles the
       section (see below). On the right sit two
       **44×44px** icon buttons, ≥8px apart — **Undo** and **Sweep this feed**
       (broom), in that left-to-right order to match the top toolbar's
       right-anchored cluster. This puts **four** focusable tap zones on a header
       (chevron collapse, name link, Undo, Sweep — the blank-space collapse
       region is `aria-hidden` and out of the tab order, redundant with the
       chevron) — a **deliberate exception** to guardrail #2's three-per-*row*
       cap: a section header is a control strip, not an article row (it already
       carried three — collapse, Undo, Sweep — before feed navigation was
       added), and each zone still meets the 44×44px floor with ≥8px gaps. The **count badge** shows that feed's unread/to-do total (from
       `getFeedUnreadCounts`; capped `99+`, hidden at 0), so a collapsed feed
       still shows how much it holds — and a **phantom (swept-empty) section
       keeps its badge** too: sweeping the visible rows must not blank the
       count while the feed still holds unread articles behind its "More". **Sweep this feed** marks done only that
       feed's **fully-visible, unpinned** rows — the same shielding as the
       toolbar Sweep (off-screen and pinned rows untouched), scoped to the one
       feed — and disables when that feed has nothing sweepable on screen. A
       **collapsed** section (no rows shown) has nothing to sweep.
       **Undo** is the **same single-level global undo** as the toolbar (restore
       the last hide/swipe/sweep batch); it's enabled whenever there's something
       to undo, so the inline Undo next to a header's broom reverts the sweep you
       just did. (One swept feed's section drops out entirely once its rows are
       gone — unlike a *collapsed* feed, which keeps its header because its items
       still exist.)
     - **Collapse / expand sections** (group-by-feed only). Everything on the
       header's name row **except the feed name/icon/count** is a **tap target**
       that toggles its section collapsed (rows hidden, a chevron flips); the
       header stays visible. (Tapping the **feed name, icon, or count** instead
       opens that feed's own view — see *Section header controls*.) Per-device and
       **persisted**
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
       opens showing **all of its pinned rows** plus its newest
       **`PER_FEED_WINDOW` (10)** listable body rows, so a busy feed doesn't
       dump its whole set into the view at once — and pins never crowd
       articles out: after any refresh a section is its full pinned block *and*
       the first 10 articles, however many pins there are. A
       **"More"** at the **foot of each section** reveals that feed's next batch
       **inline** (another 10), independent of the other sections, until the feed
       is exhausted — its window ∪ floor ∪ pinned set, the same ceiling the
       single-feed page shows. The opening view is a **single batched read that
       fetches and accepts everything the server returns** for every section —
       **the server decides any fetch cap, never the client** (today it returns
       each feed's full listable set; a future cap is a server-side decision
       deployable without a client change). The per-feed window is purely a
       client-side **display** window over that response, so every section
       lands in one page and there's **no global bottom "More"** in this view
       (only Back-to-top remains). A section "More" **reveals the next 10
       already-fetched rows instantly — no request, and it works offline**
       since the whole response lands in the cache. The fetched run IS the
       feed: once its rows are all revealed (or it fit inside the opening
       window) the section shows **no More** — no dead button, no wasted
       fetch — and there is no per-section server paging at all. If an
       account's grouped read overflows the server's response row cap
       (PostgREST's 1000), the read pages by cursor via a bottom "More" so
       later sections aren't dropped; a **planned per-account feed cap**
       (`TODO(feed-cap)`) will keep normal accounts under it. (Drilling into a
       single feed's own page is the flat pager.)
       Revealed rows get the same live item-state overlay as window rows
       (locally Done/Hidden are filtered, pin/opened read from the store), and
       the whole fetched set self-heals together on the next refetch.
       - **Sticky displayed window per section.** Each section's displayed set
         is anchored from its first read (the opening pinned block +
         `PER_FEED_WINDOW` body rows)
         and extended only by tapping "More" — *within* a frozen set. (A dismiss
         or Sweep never refetches — see *A dismiss never refetches* — so nothing
         refills a section behind the reader's back.) Concretely this means
         **Sweep does not auto-refill** (sweeping unpinned rows clears the section
         to its pinned rows; tap "More" to reveal the next batch); and **pinning
         a revealed row does not shrink the section** (the pinned id is in
         the sticky set so promoting it into the base window is a no-op for
         the displayed list). When a swept section has no pins to anchor it,
         the section header + "More" still render as a **phantom row** so the
         reader can reveal the next batch without remounting; the empty state
         only appears once every section is genuinely exhausted. When the set
         **re-materializes** — an app open, a load/return or window focus past
         the 6h freshness TTL, a reconnect, or a pull-to-refresh (*A stable set
         of articles*) — the sticky set **resets with it**: each section repaints
         as its pinned block plus the fresh window (an expansion collapses back
         to the opening window, an in-session pin consolidates to the top,
         exactly as pull-to-refresh always did). It must never stay anchored to
         the previous read's ids across a re-materialization — a long-lived
         grouped view whose displayed rows had all been read would otherwise
         strand on those dead ids, hide every fresh article behind the gate,
         and (on quiet feeds with nothing left unshown) collapse to a false
         "all caught up". Undo's reconcile refetch is the exception that stays
         anchored: it restores rows into the view the reader is looking at. A
         section's "More" **stays a stable, tappable
         "More" through a background refetch** — it is never flickered to a
         disabled "Loading…" by a refresh the reader didn't trigger — and a
         tap that lands mid-refresh is never run against the stale list: if
         the refresh preserved the window (Undo) the tap fires once it
         settles; if it re-materialized the section, the repaint supersedes
         the tap — the fresh window, with its own "More", is what the tap
         was after. Only a section whose tap was deferred by an in-flight
         refresh shows "Loading…".
   - **Done and Hidden filtered out**; **Opened** items render with the faded
     title.
   - **Initial paint one page (30 items)** in the flat river; the grouped view
     instead opens each feed at its pinned rows plus its first
     **`PER_FEED_WINDOW` (10)** articles — from one deep read that already
     carries everything the server returned for each feed — and grows per
     section. Further flat pages only via an explicit **More**
     button (no infinite scroll). Same pagination discipline.
   - **Refreshing state.** Any time a feed view is fetching a **fresh article
     list** — the first page from an empty cache, a re-materialization on
     mount/window-focus past the 6h freshness TTL, or a pull-to-refresh — the
     list is covered by a centered spinner with a visible **"Refreshing"** label
     (`role="status"`). Because a fresh fetch can reorder the list, this **blocks
     taps** so the reader can't act on a row that's about to move as the set
     re-materializes. With rows already on screen it's an overlay over the list
     (the top chrome stays usable); from an empty cache it's the inline state.
     It is **not** raised by **More** (a predictable append of older rows at the
     bottom, which keeps its own button spinner) or by **Undo** (an instant,
     local restore — below). Reduced-motion readers get the label without the
     spin. The library, search, and offline views keep the plain **"Loading…"**
     indicator (their lists don't re-materialize under the reader the same way).
   - **Refresh-failure strip** at the foot (**"Couldn't refresh." + Retry**),
     shown when a background refresh fails while rows are already on screen.
   - **A stable set of articles.** The published set a feed view shows — which
     articles, in which order — is held **frozen** between reads. New items the
     poller adds, and cross-device changes the overlay can't express, do **not**
     slide into the list under the reader. The set re-materializes — pulling new
     items in, consolidating a dismissal out, floating a server pin to the top
     block — only when the reader asks or enough time passes: **every app
     open** (a boot/reload always fetches fresh, painting the cached set
     underneath until the fetch lands — and keeping it untouched if the fetch
     fails or the device is offline), a **return or window focus past the 6h
     freshness TTL** (`FEED_STALE_MS`; the TTL gates the in-session paths —
     remount, window-focus, and the warm-on-open prefetch), or an explicit
     **pull-to-refresh**. **More** extends the set *downward* with older articles
     (an explicit, non-jumping addition at the bottom) but does **not** pull newer
     top rows in — it pages the existing cursor, so only PTR or the TTL bring the
     top current. This is the "quiet" contract: you can read the news a couple of
     times a day without the list churning every time the server changes, and
     nothing you didn't ask for moves the rows you're looking at. When the set
     *does* re-materialize from a fresh fetch (a load/return past the TTL, or a
     PTR), the reader sees the **Refreshing** state over the list, not a stale set
     silently reordering under a tap (above). Cross-device pin/done still
     propagate promptly — but *in place* (below), not by re-materializing the set.
   - **Dismissed in place — a cross-device dismiss grays only while on screen.**
     A dismiss (Done/Hidden) that arrives *from another device* for a row the
     reader is currently looking at leaves the row where it is, **dimmed with its
     title struck through**, rather than removing it and shifting everything below
     — the list never moves under the reader for something the reader didn't do.
     The grayed row stays tappable, and its right-side button becomes **Undo**
     (restore), since the reader may not want another device's dismissal. It's
     distinguished from the reader's *own* dismiss purely by channel: a local
     swipe/Sweep/auto-hide removes and collapses immediately (below); only a
     dismiss that arrives via resync — which never fires the local mutation
     channel — can gray. **Graying is only to avoid a visible jump, so it applies
     only to a row that is actually on screen.** A cross-device dismiss that lands
     on a row that is **off screen** — below the fold, scrolled above the top, or
     inside a collapsed section — **removes it immediately**, since nothing the
     reader can see shifts. Likewise a row that arrives **already** dismissed (an
     initial load, or a More page below the fold) is simply **filtered out**,
     never shown and never grayed. And a grayed row **commits (drops out) the
     moment it scrolls off screen** — you scroll past it and it's gone, no
     re-materialization needed. Any grayed rows still on screen **compact** on the
     next re-materialization that isn't under the reader: a pull-to-refresh, or a
     navigation that remounts the list (returning from an article). More
     deliberately does *not* compact on-screen rows — pulling rows out mid-page
     would shift what's below as the reader pages down.
   - **A dismiss never refetches — it settles locally.** Marking an item
     Done/Hidden, pinning, and Sweep update the rendered list **from the local
     store overlay alone**: `visibleItems` drops Done/Hidden rows and pins
     reorder, both synchronously, so the change shows on the next commit with no
     server round-trip. A *local* mutation does **not** refetch the active view,
     and it does **not** force the feed stale either — the set reconciles with the
     server only when it re-materializes: a mount or window-focus *past* the 6h
     freshness TTL, or an explicit pull-to-refresh (which always refetches).
     A **cross-device change** (a resync that changes local state) is reflected
     **in place** through the same overlay — a pin renders its badge where the row
     sits, a dismissal of an on-screen row grays it where it is (see *Dismissed in
     place* above) — and does **not** refetch or re-materialize the set; a change
     the overlay can't express (a pin of an article outside the loaded window)
     waits for the next re-materialization rather than repainting the list now. So returning to the feed right after acting on an article
     yourself does not refetch it; a full refetch under (or on the way back from)
     the reader would re-render the whole list a beat later and can reflow it (a
     section's "More"/refresh footer toggling above the fold, rows shifting) out
     from under the reader's scroll — and a back-navigation that refetched on
     every mount, regardless of how recently the feed loaded, spent a DB read for
     no visible change. A local mutation staying local is what makes "dismiss
     keeps your place" reliable. Three deliberate exceptions:
     (1) the **unread-count** query (`['feed','unread-counts',…]`) keeps
     refetching — it's a cheap number that never reflows the list, and suppressing
     it would let a grouped badge read a stale server count and jump back up after
     a sync; (2) **Undo forces a refetch** — it must *restore* rows, and if a
     focus/PTR refresh already reconciled a dismissed row out of `items[]`,
     restoring its state alone can't bring it back. On the live Supabase source
     the restoring write is delivered through the async outbox, so that immediate
     refetch can race ahead of it and read server truth that still marks the row
     dismissed; the store's `subscribeSynced` channel re-fetches once the outbox
     **drains**, and the pending-scroll request is held open (rather than dropped
     after the racing refetch) while `pendingItemIds()` still lists a restored id;
     (3) the **global "More" pager**, when any loaded row is locally dismissed,
     maps its next-page offset to the count of *distinct live (non-dismissed)
     rows* it has loaded — an absolute count, not a decrement of the server
     cursor, so it stays stable across successive taps — since the server's offset
     sequence has dropped the dismissed rows and a plain fetch would otherwise skip
     the rows that shifted up (the per-section "More" recomputes its cursor the
     same way).
   - **A dismiss or Sweep never moves the content above the removed rows.**
     Marking a row Done (tap, swipe, or `d`) or Sweeping the visible rows removes
     them immediately and closes the gap from below; whatever sits above stays
     exactly where it was on screen — the view never jumps to the top and pinned
     group headers never slide. Near the bottom, where the removed rows leave less
     below the reader than they'd scrolled past, the surviving content still holds
     its position and the space below is simply left blank, clearing as they scroll
     back up. (Honoring this against two browser reflexes — scroll-anchoring
     rewinds and a mobile dynamic-toolbar viewport glitch that would otherwise
     clamp the scroll — is mechanism; it lives in `ItemList.tsx`.)
   - **A background refresh never jumps the reader's position either** —
     pull-to-refresh, window-focus, and remount refetch in the background without
     moving where the reader is looking.
   - **Opening an article warms its feed's refresh.** When a stale feed's row
     opens the reader, that feed reconciles with the server *while the reader is
     up* (feed not on screen), so returning lands on an already-settled list
     instead of one that reflows a beat after Back — right as a tap is aimed at a
     new card. A feed still fresh within its TTL isn't re-read (opening it, or
     returning to it, costs nothing); only a genuinely stale one refreshes, and
     it does so early. This is the same freshness TTL as every other refresh path
     — just clocked from *open* rather than from *Back*.
   - **Pin-to-download promo bar** above the first row ("Pin an article to
     download it"), explaining that pinning warms the offline cache (see
     *Prefetch on Pin/Favorite*). Shown only once rows exist; dismissable via a
     single 44×44 close button, persisted per-device
     (`readmo:promo-dismissed:pin-to-download`).
   - **`/offline`** — everything readable without the network: saved
     (pinned/favorited) items first, then all other articles still cached from
     recent fetches.

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
   **oldest-first**; its glyph reflects the **current** order — a stacked digit
   column plus a direction arrow (9→0 + down arrow = newest-first / descending,
   0→9 + up arrow = oldest-first / ascending) — and its tooltip / accessible
   name names that order, and it rides **every** feed view — Home,
   folders, and single feeds — since sort applies even where grouping doesn't. Sweep marks done only
   the unpinned rows that
   are **fully visible right now** — not the whole loaded list — so scrolling
   past content and tapping the broom can't dismiss rows off-screen. A row
   counts as visible iff its bounding box sits entirely inside the viewport
   minus the sticky chrome (header + toolbar), tracked by an
   IntersectionObserver whose `rootMargin` shrinks the top by that inset; the
   button disables when nothing unpinned is fully visible. Undo restores the
   last done / swipe / sweep batch, and scrolls the list back up to the topmost
   restored row **when that row is off-screen above the fold** — so undoing a
   scroll-past burst returns you to where you were reading, while undoing a
   swipe/Sweep (whose rows are still on screen) never jerks the viewport. Same
   component/behavior as newshacker.
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
     see *Settings → Reading*): when on, each unpinned row you **scroll fully
     off the top** of the viewport is marked Done (you scrolled past it without
     pinning it). This is **not** the Sweep button: no tap and no selection —
     every scrolled-past row is dismissed on its own. It reuses Sweep's
     dismissal and the same pin shield (pinned rows are never auto-hidden), and
     rows still below the fold are never auto-hidden — only ones you've
     actually scrolled past, and a row scrolled back into view before its
     dismissal commits is spared. Rows that are already Done/Hidden are
     skipped, so a re-delivered id can't clobber the undo baseline.
     **Dismissals commit only once the scroll comes to rest** — never while a
     finger is still down or the viewport is still moving (a drag, a wheel
     burst, or the momentum glide after a flick). Removing rows mid-motion
     would shift the remaining content up under the reader, sweeping rows they
     can still see past the top — at the foot of a feed section that dismisses
     the section's last rows unread and yanks the next feed group into view.
     When the batch commits, the reader's scroll position is **actively held**:
     a row near the top of what they're looking at is restored to the same
     on-screen spot as the rows above it collapse — across the removal and the
     refetch that lands a beat later — until the reader next touches, wheels,
     or keys the viewport. (The browser's own scroll anchoring can't be relied
     on for either guarantee.) **Undo restores the whole scroll burst, not just the last
     row:** dismissals within a rolling **2s window** of each other extend a
     single undo batch (mirrors newshacker's dismiss-batch window), so one tap of
     the toolbar Undo brings back the run you just scrolled past; a gap longer
     than the window starts a fresh batch, so Undo only ever reaches back to the
     burst you were just looking at. Undo also **scrolls the list back up to the
     topmost restored row** (the earliest one you'd scrolled past) when it lands
     above the fold, so the rows it brought back are actually in view rather than
     left off-screen above you.

7. **Bottom action bar** — Back-to-top + More + Undo + Sweep on feed footers;
   Back-to-top only on library footers. Same slot order. **More lives in the
   bottom toolbar itself** (not a separate control above it): it stretches the
   middle slot between Back-to-top and the Undo/Sweep group. It appears once
   the feed is **populated** (not during the loading indicator, the error/retry
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

10. **Settings** — `/settings`: grouped into three purpose-named sections —
    **Reading** (how the list behaves), **Appearance** (how it looks/lays out),
    and **Smart features** (the AI-assisted extras) — plus **Account**/sign-out
    and an **About** link. The ordering puts the most-used behavioral settings up
    top and the minor/visual ones lower; the four theme pickers are folded under
    one **Appearance** heading (sub-labeled `settings__subheading`) rather than a
    section each. Reached from the **account menu** (top-right avatar → Settings).
    Feed management lives on the Feeds page, not here, but an **Edit feeds**
    button at the top of Settings links there (see below).
    - **Reading** — per-device toggles **Mark Done as you scroll**
      (`readmo:hide-on-scroll`, **off by default**), wiring the auto-hide
      behavior in *List toolbar → Auto-hide on scroll*; and **Group by feed**
      (`readmo:group-by-feed`, **off by default**), sectioning Home/folder lists
      by feed (see *Feed views → Sort & grouping*) — followed by the **Sort
      order** picker (`readmo:item-sort`): **Newest first** (default) or **Oldest
      first**.
    - **Appearance** — the **Color theme** (Ink/Grape swatches), **Dark/light
      mode** (light/dark/system icons), **Text size** (Extra Small–Huge
      A-glyphs), and **Font** pickers (all symbolic segmented controls), then the
      minor display settings placed further down: the **Bottom toolbar**
      picker (`readmo:bottom-bar`) — **Bottom of list** (default) or **Bottom of
      screen** (see *Bottom action bar*) — and, at the very bottom of the
      section, a **Feed icons** group with two toggles: **Show icons on groups**
      (`readmo:show-group-favicon`, **on by default** — the icon on each
      group-by-feed section header) and **Show icons on articles**
      (`readmo:show-row-favicon`, **off by default** — the icon on each article
      row in the non-grouped views).
    - **Smart features** — the **Hide sports spoilers** toggle
      (`readmo:hide-sports-spoilers`), shown only for allowlisted callers (same
      gate as the rewrite), and the **Auto generate summaries for pinned
      articles** toggle (`readmo:auto-summarize-pinned`, **on by default**),
      shown only for **family** users. The whole section is hidden — heading and
      all — when neither toggle applies (i.e. an off-list caller on an armed
      allowlist). When on, the summary for a pinned article is pre-warmed so it's
      ready before the reader opens it (see *AI article summaries* /
      `useSummaryPrewarm`); when a family user turns it off, no pin pre-warm
      fires from this device — the reader still generates on open, and the
      server-side pin trigger (which the toggle does not reach — it's a
      per-device control) still generates on pin. See *Spoiler-free sports
      headlines* and *AI article summaries*.

11. **Feeds** — `/feeds`: feed management, reached from the drawer's **Feeds**
    section edit pencil (also linked from the account menu).
    Holds **Add a feed** (autocomplete + multi-feed picker — see *Feed
    discovery*), **Subscriptions**, and **OPML** import/export. Code-split as its
    own chunk (it carries the popular-feeds catalog — see *Feed discovery*).
    - **Subscriptions** — the feed list is **drag-to-reorder**: each row stays
      within the **3-tap-zone cap** as drag handle (left), a non-interactive
      row body (title + URL), and a right-side **overflow (⋯) button** that
      opens a per-row menu with **Rename / Mute / open mode (an **Open on…**
      drill row) / Mark done when opening / Card style / Unsubscribe**. The menu drops below the ⋯ button,
      but **flips above it** for a row near the bottom of the viewport so the
      menu is never clipped off-screen. The drag
      handle is both pointer-draggable (mouse + touch) and keyboard-operable
      (focus it, then ArrowUp/ArrowDown), so reordering isn't mouse-only. The
      order persists to `subscriptions.sort` (via `reorderSubscriptions`) and
      drives both the drawer/Feeds list order and the *Group by feed*
      section order. Rename uses an inline input that replaces the title slot:
      **Enter** commits, **Esc** cancels, **blur** commits, and **leaving the
      input empty clears the override** so the row falls back to the
      publisher's title. Rename writes `subscriptions.title_override` and is
      per-user; an unchanged value is a no-op. The **open mode** is a
      **two-level control** offered on every feed (whenever the backend has the
      `open_original` column): the top menu shows a single **Open on…** row (with
      a `›` chevron, `aria-haspopup="menu"`) that drills into a submenu — a **‹
      Back** row plus a `menuitemradio` group — writing `open_original` /
      `open_newshacker` mutually exclusively (per-user, synced). The options are
      **Open here** (the in-app reader, the default) and **Open original**, plus
      **Open on newshacker** *only when applicable* — i.e. only for a **Hacker
      News feed** and only when the `open_newshacker` column exists (0034). The
      submenu **replaces the whole menu panel** (it's never taller than the top
      level it swapped out, so the flip-above placement stays valid), and the
      drill level resets whenever the menu is reopened. When *open original* is
      on, the feed's rows link straight to the source website; when *open on
      newshacker* is on, they link to the item's Hacker News discussion on
      `newshacker.app`; both open in a new tab instead of the in-app reader. The
      whole open-mode control hides against a backend that predates the
      `open_original` column (0027); the writes degrade safely (a
      reader/original choice still persists `open_original` even where
      `open_newshacker` is absent). A separate **Mark done when opening**
      checkbox (writing `subscriptions.mark_done_on_open`, 0037, independent of the
      open mode) makes opening an item on its original source / newshacker target
      also mark it Done — see *Feeds page → Mark done when opening* above; it hides
      against a backend that predates the column. A **Card style** control sets
      this feed's per-feed article-row layout override; like the open-mode choice
      it's a **two-level control** — a single **Card style** row (with a `›`
      chevron) drills into a submenu of a **‹ Back** row plus a `menuitemradio`
      group (**Default / Title only / Small thumbnail / Large thumbnail /
      Excerpt**, writing `subscriptions.list_layout`, 0051). See *Article layout →
      Per-feed override* above; **Default** clears it (fall back to the app-wide
      setting), and the whole control hides against a backend that predates the
      column. Both submenus share the same drill machinery: the submenu replaces
      the whole menu panel, focus moves into it (its Back row) on drill-in and
      back onto the originating row on return, placement re-measures on the drill
      transition, and the drill level resets when the menu is reopened. The overflow menu dismisses via
      the shared dropdown contract (`usePopoverDismiss`): Escape or an outside
      press closes it, and **the first press outside only dismisses** — its
      trailing click is swallowed, so dismissing the menu doesn't also activate
      a neighboring row or control.

12. **Admin** — `/admin`: operator console **hub**, reached from the **account
    menu**'s Admin link (shown only to admins). It holds no controls of its own —
    just links (shared `settings__section` / `settings__btn` style) to the two
    management sub-pages: **Manage users** (`/admin/users`) and **Manage feeds**
    (`/admin/feeds`).

    - **Users** — `/admin/users`: user management, reached from the Admin hub's
      *Users* link. Two sections:
      - **Trusted-user allowlist** — lists the current allowlist (email, who
        added it, when) with a per-row **Remove**, and an **add-by-email** form
        (an email can be allowed before that person signs up).
      - **Registered users** — lists every account (`list_users()`, an
        admin-only read of `auth.users`) with **Admin**/**Family**/**Blocked**
        status pills and a single per-row **Manage** (⋯) menu — the row's only
        tap zone, per the tap-target rule (shared `ItemRowMenu`: anchored popover
        on pointer, bottom sheet on touch). The menu holds **Make family / Remove
        from family** (promote/demote by writing the allowlist — reuses the
        `add`/`remove_from_allowlist` RPCs); **Block / Unblock** (sets/clears
        `auth.users.banned_until` — keeps the account but stops sign-in); and
        **Delete** (confirm-gated; permanently removes the account, cascading its
        reader data and dropping it from the allowlist/admin list). Block and
        Delete are **omitted from the signed-in admin's own menu** — the server
        also refuses to block or delete the caller, so an operator can't lock
        themselves out. A section-level **Allow new sign-ups** switch closes
        registration globally (a BEFORE INSERT trigger on `auth.users` rejects
        new accounts while it's off; the read it uses fails *open*, so a glitch
        can't silently wall off signups). All of these are plain admin-gated SQL
        RPCs (migration `0030`) — the migration role owns the SECURITY DEFINER
        functions, so they touch `auth.users` directly without the service-role
        admin API or a new Edge function. Because the client auto-deploys ahead
        of migrations, the block/delete/sign-up controls are gated on a
        `canManageUsers` capability (a `can_manage_users` flag
        `get_capabilities()` only returns once `0030` is live): against a backend
        that still predates `0030` they're hidden, so the page never offers a
        button whose RPC would 404. The family promote/demote toggle (the `0028`
        allowlist RPCs) stays available. The menu also holds a **Feeds** item that
        drills down to that user's subscription list — see *Subscription
        drill-downs* below.

    - **Subscription drill-downs** — two admin cross-reads between users and
      feeds, each reached from a row menu:
      - **Feeds** (on a `/admin/users` row) → `/admin/users/:email/feeds`: the
        feeds that account subscribes to (title, folder, muted), headed by the
        email.
      - **Users** (on a `/admin/feeds` row) → `/admin/feeds/:feedId/users`: the
        accounts subscribed to that feed (email + Family/Blocked/Muted pills),
        headed by the feed title (passed via router state).

      `subscriptions` is RLS-gated on `auth.uid()`, so both go through
      admin-gated `SECURITY DEFINER` RPCs (`admin_list_user_feeds` /
      `admin_list_feed_subscribers`, migration `0047`) that return only
      display-safe columns (never `secret_url`) and fail closed (`42501`) for
      non-admins. Gated on a `canViewSubscriptions` capability (a
      `can_view_subscriptions` flag `get_capabilities()` only returns once `0047`
      is live): the *Feeds*/*Users* menu items are hidden against an older
      backend, so a direct URL hit is the only way to reach the un-deployed-RPC
      error state.

    A non-admin who reaches any admin route sees a short no-access message and
    nothing else — the gate is client convenience only; the server re-checks
    `is_admin()` on every admin RPC (`list_users`, `list/add/remove_allowlist`,
    `admin_delete_user`, `admin_set_user_blocked`, `get/set_signups_enabled`,
    `admin_list_feeds`, `admin_list_user_feeds`, `admin_list_feed_subscribers`)
    and fails closed (`42501`). Admin identity lives in the `admin_users` table
    (bootstrapped via SQL — there's no UI to grant admin); the allowlist itself
    gates full-text reading mode and Google News feeds (see *Full-text reading
    mode* and *Feed discovery*). Single-word menu label, no explanatory copy
    (guardrail #12).

    - **Feed status** — `/admin/feeds`: an operator console listing **every
      system feed** (not just the admin's own subscriptions), reached from the
      Admin hub's *Manage feeds* link. Each row shows the feed (favicon + title), its
      **subscriber count** (users subscribed, across all accounts — counted by
      the admin RPC, which sees every subscription), the sampled article's title,
      a single derived **status** pill, and a muted **server-response** line. As in the grouped list headers, a feed with no
      resolved favicon (or one whose icon fails to load) reserves a matching
      16px slot so every title lines up at the same left edge. Only display-safe feed metadata leaves the server
      — the `feeds.url` fetch URL (possibly subscriber-tokenized) is never
      returned to the browser. The
      status is derived in priority order: **Poll failed** (the feed's last poll
      errored — `error_count > 0`, with `last_error`) → **Not tried** (no
      reading-mode download has been attempted for any of the feed's articles) →
      then, for the feed's **most recent reading-mode download attempt**:
      **Downloaded** (full body cached), **Blocked** (publisher gated it 401/403,
      Jina couldn't help), **Unreachable** (fetch failed), or **Empty** (fetched
      but nothing extractable — paywall/teaser or robots-disallowed). The
      response line surfaces the publisher's HTTP code and the reason — including,
      for a robots block, the **denial reason and the exact matching directive**
      (e.g. "Publisher blocked the fetch (HTTP 403)"; "disallowed by robots.txt
      (User-agent: \*) — Disallow: /news/"). A segmented **All / Unhealthy**
      filter narrows to the active failures (Poll failed / Blocked / Unreachable),
      and a **Reload** button re-reads the list. Each row has an overflow (**⋯**)
      menu — the row's single tap zone (guardrail #2, shared `ItemRowMenu`:
      anchored popover on pointer, bottom sheet on touch) — whose first entry is
      **Refresh**: an on-demand server-side poll of that one feed (the `refresh`
      Edge Function, server-debounced 60 s), after which the list re-reads so the
      feed's status reflects the result. Distinct from the top **Reload**, which
      only re-reads. The `refresh` function is normally scoped to the caller's
      own subscriptions; because this console lists **every** system feed, it
      also lets an **admin** refresh one specifically-named feed they don't
      subscribe to (admin status resolved server-side via the existing
      `get_capabilities()` RPC — a SECURITY DEFINER function that checks
      `is_admin()` from the caller's JWT; a no-`feedId` call is never widened into
      an all-system poll). The menu also offers **Pause / Unpause** (the admin-only
      `admin_set_feed_paused` RPC + a `feeds.paused` flag, migration `0046`): while
      a feed is paused the **poller and refresh skip it** and **full-text and AI
      summaries are declined for its items** (each enforced in its own Edge
      Function — `feeds_due_for_poll()` excludes paused feeds from the cron batch,
      and refresh/fulltext/summary check the flag and no-op/`empty`), while
      already-stored articles
      stay readable — pause only halts NEW fetching/enrichment. A paused feed
      shows a **Paused** status pill (which overrides the health cascade, since
      nothing else runs) and its menu offers Unpause instead of Refresh + Pause.
      The menu also holds a **Users** item that drills down to the feed's
      subscriber list (see *Subscription drill-downs* above). Finally, **Delete**
      — a confirm-gated, irreversible system-wide hard delete of the shared feed
      (the admin-only `admin_delete_feed` RPC, migration `0040`): a single
      `delete from feeds` cascades to its items — and their `item_state` /
      `item_fulltext_status` — and to every user's subscription, via the existing
      ON DELETE CASCADE FKs.

      The sample is simply the feed's latest recorded attempt: a reading-mode
      attempt only ever runs for an **allowlisted** caller (the `fulltext` gate
      refuses everyone else before any fetch), so no pin/allowlist filter is
      needed here — any recorded row already reflects an entitled fetch.

      The "why the download failed" is **persisted**: the `fulltext` function
      records each terminal attempt (status, publisher HTTP code, reason, and the
      matching robots.txt rule) to the server-only **`item_fulltext_status`**
      table (one row per shared item, keyed on `item_id`), and the admin read
      takes the most recent row per feed. That table is RLS-locked with no
      `authenticated` grant — it never reaches a client read; the service role
      writes it and the admin-gated `admin_list_feeds` (SECURITY DEFINER) reads
      it. The record is **forward-only**: a feed whose articles were all last
      opened before this shipped shows *Not tried* until one is next opened.
      Backed by the admin-only `admin_list_feeds` RPC (migration `0039`), which
      fails closed (`42501`) for non-admins like every other admin RPC.

13. **Keyboard shortcuts** — same letter scheme (see below).

14. **Account UI** — header chip (see *Auth*).

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

### Article layout (card size)

The row above is the compact base. **Settings → Appearance → Article layout**
(`readmo:list-layout`, per-device localStorage, default `thumbnail-small`) lets
the reader trade density for a larger card — or drop the thumbnail entirely — in
four steps:

- **Title only** (`title`) — the compact row described above, with no thumbnail.
- **Small thumbnail** (`thumbnail-small`, default) — the **compact title-only
  row** (same padding, title size, and two-line clamp) with a **small
  right-floated thumbnail**; the title wraps beside the image and the meta line
  sits below. **No excerpt.** Same image source and spoiler handling as the large
  thumbnail (below). Absent key ⇒ this, so a fresh install shows the small
  thumbnail; an image-less feed under it looks exactly like *Title only*.
- **Large thumbnail** (`thumbnail`) — a larger title (up to three lines) with a
  **large right-floated thumbnail**; the title wraps beside the image and the
  meta line sits below. **No excerpt.** The image is sourced client-side from
  data already present — the first proxied image in the sanitized `contentHtml`,
  else the first `image/*` **enclosure** routed through the `/api/img` proxy
  (guardrail #6; never a direct publisher fetch). For **either** thumbnail size,
  a row with **no usable image**, or whose image fails to load, **shows just the
  title** — the row's card styling stays, the image slot is simply omitted (no
  excerpt fallback), never an empty box. When the headline is a **hidden sports
  spoiler** (the row shows the spoiler-free rewrite — see *Spoiler-free sports
  headlines*), the thumbnail is **blurred** and carries a centered
  `VisibilityOff` marker, since the article's own image can reveal the result (a
  scoreboard, a celebration); the row-body tap still opens the full article to
  reveal it.
- **Excerpt** (`excerpt`) — a larger title with a **two-line preview**
  of the feed body (`contentHtml` stripped to plain text, entities decoded; *not*
  the AI `summary`), no image. The preview sits a half-step below the headline
  in contrast — dark enough to read comfortably, muted enough that the title
  anchors the row — and fades to the read tone along with the title once the
  item is opened. When the headline itself is a **hidden sports
  spoiler** (the row shows the spoiler-free rewrite — see *Spoiler-free sports
  headlines*), the preview is replaced by a muted placeholder — **"Spoilers
  hidden. Tap to see article."** — since the feed body almost always repeats the
  result the headline just concealed; the row-body tap still opens the full
  article.

The thumbnail and excerpt both render **inside the row-body link**, so the row
keeps its **two tap zones** (body link + right-side button) — the image/excerpt
add no fourth tappable (guardrail #2). The **rendering** is client-only — it reads
existing item fields and the `/api/img` proxy (a Vercel function that ships with
the frontend), so an image-less row simply shows its title under either thumbnail
option (the image slot omitted); coverage depends on the feed.

**Per-feed override.** The app-wide Article layout is the default, but any feed
can override it — a photo-heavy feed can show large thumbnails while a text feed
stays title-only. The override is set from the **Feeds page → Subscriptions →
per-row ⋯ menu → "Card style"** — a two-level control: the **Card style** row
drills into a submenu of a mutually-exclusive radio group (**Default**, Title
only, Small thumbnail, Large thumbnail, Excerpt). It sits alongside the
existing per-feed choices (mute, rename, open mode, mark-done-on-open).
**"Default"** clears the override and follows the app-wide setting. Unlike the
app-wide setting (per-device `localStorage`), the per-feed override is **stored
on `subscriptions.list_layout`** so it **syncs across the user's devices** like
mute/rename/open-mode (NULL = "use the app-wide setting"; the four non-null
values mirror the app-wide choices). Every row resolves its layout as
*per-feed override ?? app-wide setting* — `ItemRows` reads the overrides from the
shared `['subscriptions']` query (`useListLayoutFeeds`, deduped with the open-mode
hooks) and passes each row its feed's layout; `ItemRow` falls back to the
app-wide `useListLayout` when no override is given. Because it adds a synced
column, this half is **not** client-only: it ships behind the `list_layout`
column (migration **0051**) and feature-detects a backend without it
(`supportsSubscriptionListLayout`) — the "Card style" control hides until the
column is deployed, and a stale-cache write to a pre-0051 backend no-ops rather
than erroring (guardrail #11). Requires a manual `make migrate`. Cost: one extra
nullable text column, **negligible** — no new fetch or external call.

Display-only meta (plain text inside the row link): **source** (feed/site
name, trimmed to the registrable domain the way newshacker trims
domains — `old.reddit.com` → `reddit.com`); **article domain** when it differs
from the feed's own site, shown right after the source name (so aggregator
feeds like Hacker News or Reddit surface where a row actually links —
`Hacker News · thedrive.com`; a normal blog feed that links to itself doesn't
repeat its own domain); **age**; **author** when present. The feed's **site
favicon** sits at the start of the meta line — but where it appears depends on
grouping. In **group-by-feed** view it's on the **section header** only (beside
the feed name), identifying a feed's run of rows once rather than repeating on
every article — gated on the **Show icons on groups** setting (Settings →
Appearance → Feed icons; `readmo:show-group-favicon`, **on by default**,
per-device). In **non-grouped** views (the flat river, library, search,
offline), where rows from different feeds interleave with no section header to
attribute them, each row *can* show its own feed's favicon just before the
source name — gated on the **Show icons on articles** setting (same Feed icons
group; `readmo:show-row-favicon`, **off by default**, per-device). The
**single feed page** (`/feed/:feedId`) also shows it once, left of the feed name
in the page-header title (sized up to 20px for the heading), independent of both
per-device settings. That
favicon comes from `feeds.favicon_url`, which
the poller resolves on each fetch: the feed-advertised icon when present (Atom
`<icon>`/`<logo>`, RSS `<image>`, JSON Feed `favicon`/`icon`, scheme-checked to
http(s), fragment-stripped, and rejected if it looks tokenized — embedded
credentials, a high-entropy/matrix path segment, or a query param that isn't a
known image-resize/cache key (`w`, `h`, `crop`, `q`, `dpr`, `v`, …) with a
short-integer value. Numeric image-resize queries are kept
(`?w=150&h=150&crop=1`), so real CDN icons from Vox / MIT Technology Review
aren't thrown away, while a credential-named param even with an integer value
(`?subscriber_id=1234`, `?token=1234`) or any non-integer value (token, base64,
string param, timestamp) is rejected — so no per-subscriber query leaks into
`feeds_public`. When the feed advertises no icon, the poller next tries to
**discover a real one from the site homepage's `<link rel="icon">`** (also
`shortcut icon`, `apple-touch-icon`, or `mask-icon`, in that preference order),
fetched once through the SSRF-hardened path and run through the same screen —
this rescues publishers whose feed names no icon *and* whose `/favicon.ico`
guess 404s (e.g. `ft.com`). When that direct homepage GET is **bot-blocked**
(an auth/bot-wall **401/403** — the same publishers, `ft.com` / `economist.com`,
that 403 a plain server-side fetch), discovery retries the homepage once through
**Jina Reader** (`r.jina.ai`, the same headless-browser fallback `/api/discover`
uses on 403) — sending only the **origin root**, and never for a `secret_url`
feed — so a real icon behind the bot wall is still found. Only 401/403 retry:
a 429 (publisher rate-limit) or 5xx (transient) falls back to the guess rather
than proxying around the throttle/outage and burning Jina quota, a thrown fetch
(SSRF-refused host / DNS / timeout) never reaches Jina, and a reachable homepage
that merely advertises no icon is *not* retried (the `/favicon.ico` guess is the
answer there, and ordinary sites never spend a Jina call). The
homepage fetch is a **one-shot cost per feed**:
discovery runs only on the first poll that finds no favicon stored yet, and
every later poll reuses the stored value — a discovered icon, or the
`/favicon.ico` guess it settled on — without re-fetching the page. Else, finally, the
site origin's `/favicon.ico`. It's decorative (`alt=""`). When the stored icon
is **missing or fails to load** — most often that guessed `/favicon.ico` for a
publisher that serves none there (ft.com, economist.com), whose real icon is only
on a bot-blocked homepage the poller can't reach — the client draws a
**deterministic initials-on-color badge** from the feed name instead of leaving
the row blank (`feedInitials.ts` for the letters, `avatarColorForString` for the
color — the same offline, zero-request approach as the account `UserAvatar` disc;
no favicon service, no third-party call). The badge fills the same fixed slot, so
a feed lacking an icon never snaps its name/meta left out of alignment with
siblings whose icons loaded; only when there's no name to draw does the slot fall
back to a blank reserved placeholder (or collapse). A
shared `FeedFavicon` component owns that box size across every surface (rows,
grouped headers, reader bar, feed page, admin) and the load-error fallback, so the
icon, its badge, and its placeholder can't drift apart. The stored URL is
display-safe metadata (like `title`/`site_url`), so `feeds_public` exposes it;
the client loads it directly (not via the image proxy). A handful of publishers
ship a **black-on-transparent** favicon (a dark monochrome mark) that vanishes
on the dark page background; those are inverted to white in dark mode. Inversion
is **opt-in per registrable domain** (a curated set in `faviconInvert.ts`, e.g.
`vox.com`) rather than applied to every favicon — blanket inversion would wreck
full-color logos.

On the **single feed page** the page-header title is followed by a **pencil**
(44×44 tap target) linking to the **Feeds page**, where this feed can be renamed,
muted, or unsubscribed (there's no per-feed unsubscribe on the feed view itself —
the management page owns those controls); the pencil sits immediately after the
title. When the feed is **parked** after repeated fetch failures a **"Feed has
errors · Retry now"** badge that un-parks and refetches it floats to the far
right, past the pencil. The pencil deep-links with `?feed=<id>`, so the Feeds
page **scrolls that feed's row into view and briefly highlights it** (an accent
ring that fades after ~2s, honoring `prefers-reduced-motion`) rather than
dropping the user at the top of the subscriptions list.
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

- **Header:** the title (links to the original, `target="_blank"`, marks
  Opened) followed by a **meta line** of author · date, plus the article's
  **domain** when it differs from the feed's own site (same rule as the item
  row — so an aggregator feed surfaces where the article lives) and the *via
  fallback* provenance tag when applicable. The **feed name is not repeated in
  the header** — it lives on the reader bars next to the leading button (see
  *Reader action bar*), so the header is just title + meta.
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
  whole picture rather than Reddit's crop. **Body copy matches the AI summary
  card's text size** (0.95rem, ~15px at the default text size; line-height 1.4)
  so the summary and the article read as one continuous piece. It is sized in
  `rem`, so it scales with the Settings "Text size" choice along with the rest
  of the UI type.
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
  - The feed body shows first; once the background fetch lands, **"Read
    more"** reveals the full article (no auto-swap). Once both bodies exist
    the swap *back* to the feed body lives in the reader's overflow (⋮) menu
    as **"Show feed version"** — keeping the mode bar quiet on the happy path
    (most readers stay in the extracted reading view) without losing the
    escape hatch. An already-cached full body defaults to the reading view.
    Feeds whose body is already complete are not auto-fetched but offer a
    **"Get full article"** control. While the background fetch is in flight
    the mode bar shows a **"Loading full article…"** note alongside an **"Open
    original"** button (in the same slot as "Read more"), so the reader can
    jump to the source without waiting for extraction.
  - **Provenance ("via fallback").** When the publisher bot-blocks the direct
    fetch (401/403) the function retries through the r.jina.ai fallback. A body
    obtained that way is flagged: the function records
    `items.full_content_via_fallback` on the shared row and returns an additive
    **`viaFallback: true`** on the `ok` envelope, and the reader shows a muted
    **"via fallback"** tag in the header meta line (after author · date · domain)
    while that body is on screen. The flag is additive (omitted = direct fetch) and rides
    **only** through the allowlist-gated `fulltext` function — the column is not
    in any client read (see the reading-mode allowlist below) — so fallback
    content, like all full content, reaches only allowlisted callers.
  - **Honors robots.txt.** Reading mode crawls the article's *own* page (beyond
    the syndicated feed body), so before fetching it consults the publisher's
    `<origin>/robots.txt` (`supabase/functions/_shared/robots.ts`) for our
    `Readmo` product token, falling back to the `*` group. A path our crawler is
    disallowed from is reported as the silent **`empty`** outcome (reader keeps
    the feed body + **Open original**, the same UX as a paywall/teaser) — no new
    wire status, so older clients are unaffected. Because the fetch follows
    redirects internally, the **final URL after redirects** is re-checked too
    (a short link / canonicalizer can land on a different origin or path than
    the item URL); a disallowed destination drops the body without extracting or
    caching it. The robots.txt fetch itself
    goes through the SSRF-hardened helper (guardrail #6). **Fail open:** a
    missing (404), unreachable, non-2xx, oversized, or unparseable robots.txt
    imposes no restriction (the robots convention — absence of rules means
    allowed — and a publisher's flaky robots.txt must never silently stop a
    legitimate fetch). The poller and discovery are *not* gated on robots.txt
    (the feed is published for syndication; discovery is a one-time, explicitly
    user-pasted URL). Parsing/matching is delegated to the `robots-parser`
    library (a mature, zero-dependency, spec-tested MIT package; pure JS over the
    `URL` global, so it runs unchanged under Deno via `npm:` and under vitest) —
    not a hand-rolled parser — so RFC 9309 group selection, Allow/Disallow
    precedence, `*`/`$` wildcards, and path normalization are handled by a vetted
    implementation. Cost/reliability (guardrail #5): negligible — an in-process
    pure-JS dependency, no new external call beyond the one robots.txt fetch.
  - **Every attempt is recorded** for operator visibility: on each terminal
    outcome the function upserts `{ status, http_status, error, robots_rule,
    attempted_at }` to the server-only `item_fulltext_status` table (keyed on
    `item_id`) — for a robots block, `robots_rule` holds the exact matching
    directive and `error` names the user-agent group,
    best-effort (a write failure is logged and never changes the caller's
    result). This is what powers the `/admin/feeds` download-status console (see
    *Admin*); it's operational metadata, kept off every client read (RLS-locked,
    no `authenticated` grant) and read only by the admin-gated `admin_list_feeds`.
  - **Outcomes** (the function returns `{ status, contentHtml, retryable?,
    viaFallback? }`): `ok`,
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
  - **Cost & reliability (guardrail #5):** the outbound calls are the publisher
    fetch (same class as the poller), one small `<origin>/robots.txt` fetch
    before it (capped at 512 KiB, 5 s timeout, fails open), and the existing
    `r.jina.ai` 403-fallback (already documented) — **no new paid service; cost
    negligible.** The robots.txt fetch adds one extra request and ~tens-of-ms to
    hundreds-of-ms on the first open of a truncated item (then cache-instant, as
    the extracted body is cached and re-opens skip the function entirely); it is
    not cached separately. Its only new failure mode is a slow/blocked
    robots.txt, bounded by the timeout and the fail-open default.
    Latency is +1–3 s on the first open of a truncated item, then cache-instant.
    Works on most normal article sites; SPA/JS-rendered pages and paywalls fall
    back to the feed body + Open original.
  - **Reading-mode allowlist (the `allowlist` table).** Reading mode is the app's
    highest copyright-exposure surface — unlike caching a feed's own syndicated
    body it fetches the article *beyond* the feed and stores the extracted body
    on the shared `items` row. The trusted-user **`allowlist` table** (emails,
    managed from */admin* — it also gates Google News feeds, see *Feed
    discovery*) lets the operator keep the feature to themselves and family while
    plain feed reading stays open to everyone. Enforced server-side in the
    `fulltext` function (which reads the table via `loadAllowlistFromDb`,
    `supabase/functions/_shared/allowlist.ts`), checked **before** the item lookup
    and cache-hit return so a non-listed caller never receives full content,
    cached or fresh. Matching is on the caller's verified account email
    (case-insensitive). **Empty table → open to all**, so deploying the gate is a
    no-op until the operator seeds the table; a DB read error **fails closed**
    (retryable `unreachable`, never serves). On the **client**, the reader and the
    offline warmer additionally read the caller's capabilities
    (`get_capabilities` via `useFullTextAllowed`) and **skip the `fulltext` call
    entirely** for an off-list user — so an off-list reader shows the feed stub
    with zero Edge calls and the warmer doesn't re-prefetch a bucketed item on
    every state-sync. The client gate is **conservative on an unknown state**:
    while a signed-in user's capabilities are still loading it holds off the call
    (rather than treating unknown as open), and the `getCapabilities` mapping
    only treats a *missing* RPC (PostgREST `PGRST202`, an old backend) as
    "no capabilities" — a transient error is rethrown so React Query retries
    instead of caching an open gate. It all re-warms automatically when
    membership flips to family. The server gate stays the boundary; the client
    check is an optimization. A blocked caller gets a silent **`empty`** outcome (feed body, no
    error, no mention of an allowlist) carrying an additive **`retryable: true`**
    flag: the reader keeps it stale (`fullTextStaleTime`) rather than terminal,
    so if the operator later adds the caller to the allowlist the next open
    re-checks the gate instead of staying stuck on a forever-cached denial, and
    the offline warmer leaves it unwarmed so a reconnect re-prefetches it. The
    flag is additive (not a new wire status) so a service-worker-cached older
    client still renders the plain silent `empty` (guardrail #11). A transient
    `auth.getUser()` failure likewise returns the retryable `unreachable`. For
    the gate to actually
    bind, the cached body **must only reach the client through this function**:
    the reader's `getItem` read deliberately **does not select
    `full_content_html`** (nor the `full_content_via_fallback` provenance flag) —
    it would otherwise hand any subscriber who can see the item the cached full
    article (fallback-sourced or not), bypassing the gate — so the reader always
    obtains the full body via `fetchFullText`, and `feed_items` scrubs both
    columns from list payloads (migration 0026). (A column-level `REVOKE` so a
    hand-crafted PostgREST read can't reach **either** column — `full_content_html`
    or `full_content_via_fallback` — is folded into the DB-backed allowlist
    follow-up; table-level `select on items` (0008) plus row-only RLS leaves a
    direct column read open until then. The provenance bit is strictly less
    sensitive than the body in the same row, so it adds nothing beyond that
    already-tracked gap.)
- **AI article summaries (allowlisted).** A short AI summary (a few
  sentences) of the article, shown **directly below the title/byline, above the
  reading-mode bar and article body** — for an **allowlisted user**. The
  **`allowlist` table is the only access boundary** (the same trusted-user list
  as reading mode / Google News — summaries are a generation-cost surface, one
  Gemini call per cache miss). Access is gated solely on the allowlist
  (`useFullTextAllowed`, the shared gate — it holds off while a signed-in user's
  capabilities are still loading, so an off-list user fires no Edge call), and the
  `summary` Edge Function re-checks the allowlist server-side regardless.
  - **Generation is not automatic on every open — pin before opening, or ask.**
    The reader's `useSummary` auto-generates only when the article was **pinned
    before it opened** (the "I'll read this" signal the pre-warm already acts on,
    passed to `ArticleSummary` as `autoGenerate`). For an **unpinned** open it
    offers a **"Generate summary" button** instead, so a casual glance doesn't
    spend a Gemini/Jina call — the user asks and the summary generates on click.
    Either way, a summary **already cached** (warmed by a pin, or generated on an
    earlier open) shows immediately: the gate is on *fetching*, not on
    *displaying*. Offline with nothing cached, there's no button (nothing to
    generate) — silent, like the rest of the card's soft states. A pin made while
    reading warms the summary via the pre-warm subscriber, so it appears without a
    button too.
  - **A pin triggers the work server-side the moment it syncs — full article
    first, then the summary.** The pin's server write fires the `summary`
    function **from the database** (the pin trigger), so a pinned article is
    made ready even when the app closes or loses the network right after the
    pin — the client pre-warm and pinned prefetch are best-effort (their
    in-flight calls die with the page), and this is the guarantee behind them.
    A pin made offline triggers when it syncs. The server-side work is:
    **(1) download + cache the full article** (the reading-mode extraction, via
    an internal call to `fulltext` — applied only when the feed body looks
    truncated, the same gate as the client's pinned prefetch, and subject to
    all of reading mode's usual checks: robots, SSRF hardening, sanitization,
    paused feeds), then **(2) generate the AI summary** if one still isn't
    cached — in that order, so the summary's fallback text is the full body
    rather than a feed stub. The trigger **requires the pinning user to be on
    the allowlist — an empty allowlist triggers for no one** (the same
    cost-guard convention as the poller's spoiler-title pass; client-initiated
    calls keep their "empty list = open" semantics), skips items that already
    have both artifacts cached, and is a no-op until the operator configures
    the Vault secrets (SETUP.md §9b). The per-device **Auto generate
    summaries** toggle governs only the device pre-warm below, not this
    server-side trigger.
  - **Pin is also a prefetch signal (incl. cross-device), generate-once.**
    `useSummaryPrewarm` pre-warms the summary for **every pinned item** — pinned
    on this device, synced from another device, or restored on boot — the summary
    sibling of `useOfflineCacheLock`, which already warms each pinned item's
    reader body + full text the same way. Pinning is the auto-generate signal
    on open, the server-side generation trigger above, and the prefetch signal
    that warms the device cache ahead of time.
    Both the pre-warm and the reader's on-open `useSummary` share the
    `['summary', id]` React Query key and the result caches on
    `items.ai_summary`, so whichever fires first generates and the rest are plain
    cache hits — **never a second Gemini call** on one client. Truly *simultaneous*
    misses across devices/users are collapsed on the server too (the generation
    lease below), so N concurrent first-opens of the same article still cost one
    Gemini call. So a pinned article is usually
    already summarized (no spinner) by the time it's opened, on whatever device.
    The pre-warm is also gated on the family-only **Auto generate summaries for
    pinned articles** setting (`readmo:auto-summarize-pinned`, on by default —
    see *Settings → Smart features*): a family user who turns it off warms
    nothing ahead of time, though the reader's on-open `useSummary` still
    generates the summary for whatever article is opened.
    **Cross-device warming is cheap because the summary is cached server-side**: a
    warm of an already-generated summary is a *server cache hit* (the `summary`
    Edge Function short-circuits on `items.ai_summary` — no Jina, no Gemini), and
    a never-summarized item generates exactly **once**, shared across every device
    and user. A warm is marked done only on a **settled** result, so a transient
    `unreachable`/`unavailable` retries on reconnect or once the allowlist gate
    resolves. The pre-warm subscriber warms only newly-pinned items, so an
    unrelated state change doesn't re-fetch unsettled summaries during an outage.
  - **Article text comes from Jina (like newshacker), by design.** The summary's
    input is fetched through **Jina Reader** (`r.jina.ai`), which returns clean
    **markdown** and transparently handles bot-blocked / paywalled / JS-rendered
    pages. This is a deliberate split from reading mode: the `fulltext` path
    **fetches, extracts, and serves** the article itself, so it stays a polite
    first-party citizen (our `User-Agent` via `safeFetch`; honoring robots is the
    intended posture there). The AI summary is a transient short gist that
    is **never stored or served verbatim**, so it routes through Jina — a
    third-party reader — rather than our own fetcher. **Tokenized / secret-bearing
    item URLs are screened out before forwarding to Jina** (guardrail #6 — the same
    `looksTokenized()` + `secret_url` guards the `fulltext` Jina fallback uses), so
    we never hand a subscriber token to a third party. When Jina is unconfigured,
    the URL is screened out, or the fetch fails, the function **falls back to the
    body we already store** (`full_content_html` ?? `content_html`, stripped to
    text), so summaries still work without a new fetch. There's no
    stored-content sequencing to race: the summary fetches its own text. When the
    only content available is a **truncated feed stub** (Jina unavailable/screened
    *and* no full body cached yet), the function **defers** — it returns a
    `retryable` `empty` **without spending a Gemini call**, so no low-quality
    teaser-summary is shown or cached and a later mount re-checks once Jina
    recovers or a full body is extracted. Only good content (Jina markdown, the
    extraction, or a non-truncated feed body) is summarized, and that result
    caches normally on `items.ai_summary`.
  - **Model:** Google **Gemini `gemini-2.5-flash-lite`** via the
    `generateContent` REST endpoint (fixed Google host; the article is in the
    request body, never a URL), `thinkingBudget: 0` to keep latency low. Needs
    the **`GOOGLE_API_KEY`** Supabase secret (and **`JINA_API_KEY`** for the
    article fetch — without it the function falls back to stored content); unset
    `GOOGLE_API_KEY` → the function reports `unavailable` and the reader shows no
    summary card. The prompt is a tl;dr ask ("Provide a tl;dr of the
    following article:", with the title passed along as context when known)
    with **two targeted instructions**: (1) an **anti-preamble** line ("Respond
    with only the summary itself: no preamble … no 'tl;dr' label, and no 'The
    article covers…' style lead-in"), and (2) a **Markdown-format** line asking
    for a short **bulleted list** (with `-` markers) when the article makes
    several distinct points, otherwise a short paragraph, with inline
    bold/italic/`code` welcome and headings disallowed. Length/register stay
    unsteered — in practice the bare ask yields shorter, more direct prose than
    added length/register instructions did. The Markdown steer just makes
    explicit (and renders deterministically) the formatting the model already
    reached for intermittently. The anti-preamble line exists because the tl;dr ask made
    the model echo that framing back as a preamble ("tl;dr:", "**TL;DR:**",
    "Here's a tl;dr of the article:", "The article covers…"). Because that's a
    negative instruction a flash-lite model may still ignore, the function also
    **strips a leading meta-framing preamble** from the output as a
    deterministic backstop (`stripSummaryPreamble` in `_shared/summary.ts`).
    The strip is conservative — it removes only a recognized label/lead-in at
    the very start and only when the "tl;dr" token is clearly a label (a
    separator, closing emphasis, or line break follows), so a summary that
    merely mentions "tl;dr" mid-text, or genuinely opens with "TLDR" as a
    proper noun (the tldr-pages project / TLDR newsletter), is untouched. The
    same strip runs on the **cache-hit path** too, cleaning (and rewriting
    once) any row cached before the strip existed so legacy preambles don't
    render forever. The response is rendered
    with the **`MarkdownText`** component **ported from newshacker**
    (guardrail #9) — inline `<strong>`/`<em>`/`<code>` plus flat **bullet lists**
    (`-`/`*`/`+` runs → `<ul>`), all emitted as React elements, never
    `dangerouslySetInnerHTML`, so there's no markdown-library dependency and no
    XSS surface (the model's text is React-escaped by construction). Other
    block-level Markdown (headings, ordered/nested lists, blockquotes, code
    fences) renders as literal text and the prompt steers the model away from it.
  - **Model:** Google **Gemini `gemini-2.5-flash-lite`** via the
    `generateContent` REST endpoint (fixed Google host; the article is in the
    request body, never a URL), `thinkingBudget: 0` to keep latency low. Needs
    the **`GOOGLE_API_KEY`** Supabase secret; unset → the function reports
    `unavailable` and the reader simply shows no summary card.
  - **Cached on the shared item** (`items.ai_summary`, 0035): one user's
    generation serves every later open (or pin pre-warm) of the same article, on
    any device and for any allowlisted reader. Like
    `full_content_html`, the column is **not** in any client item read
    (`SupabaseDataSource`'s `ITEM_COLUMNS` omits it) **and is nulled in the
    `feed_items` list RPC** (0035 recreates it to scrub `ai_summary` +
    `ai_summary_generated_at`, exactly as 0026 scrubs the full-text fields — so a
    home/folder/feed list never ships a summary to an off-allowlist co-subscriber),
    so the summary normally reaches the client **only** through the
    allowlist-gated `summary` function —
    and the client **display gate** (`useSummary`) drops a cached summary the
    moment the caller is no longer allowed (e.g. removed from a now-armed
    allowlist), mirroring how the reader ignores cached full-text when
    `allowFull` is false. It shares `full_content_html`'s **known direct-read
    gap**: the 0008 table-level `SELECT` grant plus row-only RLS means a
    hand-crafted PostgREST read by a caller who can already see the row could
    reach the column directly; a column-level `REVOKE` is a no-op under that
    grant, so the real fix is the column-grant restructuring tracked for
    `full_content_html`. Accepted on the same terms here — a short summary is
    strictly less sensitive than the full body that already carries the gap, and
    the allowlist still bounds the only costly part (generating a summary; reading
    a cached one is free). **Invalidated on content change:** the poller's
    `upsert_feed_items` (recreated in 0035) nulls `ai_summary` +
    `ai_summary_generated_at` when a re-published item's `content_html`/`title`
    changes (always on a same-url re-issue under a new guid), so an edited article
    is re-summarized rather than served a stale gist. (It compares the real body/
    title, **not** `content_hash` — the poller sets `content_hash` to the guid, so
    it never changes on a same-guid edit.)
  - **Concurrent requests are single-flighted (a generation lease).** The cache
    hit above only dedupes *sequential* callers; two misses for the same shared
    item that overlap (a device pre-warm racing a pin on another device, the same
    article open on phone + desktop, two family users pinning it at once) would
    each run the full Jina + Gemini pass. So the `summary` function leases the
    generation: `items.ai_summary_generated_at` set while `ai_summary` is still
    null **means "a generation is in flight."** The claim is a single atomic
    conditional `UPDATE` (stamp the lease iff the summary is still null AND no
    fresh lease exists) — exactly one concurrent caller wins and generates; the
    rest poll and return its result the instant it's cached, so the second caller
    is typically *faster* than generating itself (it only waits out the winner's
    remaining time). N concurrent misses → **one** Gemini call. It's a durable row
    marker, **not** a Postgres advisory lock: advisory locks are session/txn
    scoped and Supabase's pooled PostgREST connections would drop the lock the
    moment the claim statement commits, long before the Deno-side Jina/Gemini
    awaits finish. The lease has a **60 s TTL** (> the ~35 s worst-case Jina +
    Gemini) so a generator that dies can't wedge waiters — after the TTL the
    marker is stale and reclaimable; a generator that *fails* releases it at once
    (resets to null, restoring the "both null" state); and a waiter that hits its
    ~45 s overall cap self-generates without a lease, so a caller is never worse
    off than the no-lease behavior. Reuses the existing column (no migration): it
    already sits out of list reads (0035 scrub) and is already nulled by the
    poller on content change, so the lease neither leaks nor outlives an edit.
    Purely additive to the deployed backend — an old summary function running
    during the deploy window just ignores the lease (at most one redundant call).
    The coalescing logic (`coalesceSummaryGeneration`) is unit-tested in
    `_shared/summary.ts`.
  - **Outcomes** (the function returns `{ status, summary, retryable? }`): `ok`
    (the summary string), `empty` (nothing to summarize, or the silent
    allowlist denial — flagged `retryable` so a later allowlist change
    un-sticks it), `unavailable` (Gemini key unset — `retryable`), `unreachable`
    (a transient allowlist-read / auth / Gemini failure — `retryable`). In every
    non-`ok` outcome the reader stays **silent** (no card, no error), exactly
    like reading mode; `summaryStaleTime` caches `ok`/`empty` forever and keeps
    the retryable/transient ones stale. Additive `retryable` flag (not a new wire
    status) so a service-worker-cached older client still reads the plain status
    (guardrail #11).
  - **Cost & reliability (guardrail #5):** a cache miss makes **two** outbound
    calls — a Jina fetch (free tier 1M tokens/mo, ~10–100 K tokens per page) and a
    Gemini Flash-Lite call (~$0.10 / 1M input, ~$0.40 / 1M output). Each article is
    summarized **once** (shared cache), and generation only happens for a **pinned
    article** (pre-warmed, or auto-generated on open) or when an allowlisted user
    **taps "Generate summary"** on an unpinned one — so the miss volume is bounded
    by *distinct pinned/requested articles* across the allowlisted (family) set —
    **effectively $0**, well under both free tiers. A pin pre-warms the cache
    ahead of the open, so a pinned article is usually a hit; an unpinned article
    generates only on an explicit ask. The generation lease (above) also collapses
    truly-concurrent first-opens of the same article to a single Jina + Gemini
    pass, so even a burst of simultaneous requests can't multiply the per-article
    cost. Unlike the earlier
    stored-content design this adds a per-article publisher fetch (via Jina), which
    is the deliberate trade for newshacker-parity and clean bot-blocked/paywalled
    handling; the fetch is off our polite first-party path. Latency: Jina (~1–5 s) +
    Gemini (~1–2 s) on the first open (or pin pre-warm) of an article,
    cache-instant after. Failure
    modes are all soft (no card): Jina down/blocked → fall back to stored content;
    Gemini down/unconfigured → no card. The article and reading mode are
    unaffected.
- **Spoiler-free sports headlines (allowlisted).** A sports feed can spoil a
  result in the headline itself ("Man Utd beat Arsenal 3-1"). A "result" here is
  broad: not just who won or lost, but a finishing position or placing
  ("finished seventh", "on the podium") and any change to the championship or
  league standings the event produced ("extends lead", "goes top of the table").
  A multi-session event protects each session separately — an F1 qualifying or
  sprint result is a spoiler in its own right, not pre-game build-up to the race.
  The only exemption is genuinely pre-game content that reveals nothing from any
  already-run session; a "race preview" that leaks the qualifying result still
  spoils. A matchup or draw for a *later* round ("X will face Y in the
  semi-final") reveals who advanced and IS a spoiler — and because naming the
  teams would itself give that away, its rewrite is competition + round only
  (**"World Cup semi-final spoiler"**). Only a genuine pre-tournament fixture
  list or first-round draw, made before anyone has played, stays exempt.
  For allowlisted
  users, such a headline is replaced — in the list **and** the reader — with a
  spoiler-free rewrite that names only **which** event it is — the competition
  and the participants — and *never what happened*: **"EPL MNU v ARS spoiler"**,
  **"F1 British GP qualifying spoiler"**, **"World Cup AUS v EGY spoiler"**. The
  incident itself (a score, goal, card, crash, injury, or medical emergency)
  never appears in the rewrite, and the teams are pulled from the article body
  when the headline doesn't name them, keeping any qualifier that's part of a
  team's name (**"Football Epping v Lalor Reserves spoiler"** for a mid-match
  injury story). When the specific competition can't be identified,
  the rewrite leads with the **sport** instead so it's never left bare
  (**"Rugby AUS v IRE spoiler"**); it never invents a league it can't confirm
  from the text. Opening the article
  is unchanged (full content, spoilers and all). The **original headline always
  stays in `items.title`** and the rewrite in a separate column, so display is
  reversible and the choice is a pure client decision.
  - **Generated eagerly at poll time (Gemini), so the *list* is de-spoilered.**
    Unlike AI summaries (generated on open), the value here is *before* you open
    anything, so the poller generates it: after a poll, for each polled feed that
    has an **allowlisted subscriber**, it classifies+rewrites the feed's
    unprocessed headlines and caches the result on the shared item. The gate is
    the `feeds_with_allowlisted_subscriber` SQL function (subscriptions →
    `auth.users.email` → the `allowlist` table). **Cost-safety deviation:** unlike
    the app's usual "empty allowlist = open to all", an **empty allowlist here
    generates for no one** (feature off) — poll-time generation for every feed on
    an unseeded deploy would be an unbounded Gemini bill, so arming the allowlist
    is what turns it on.
  - **Title + stored RSS content only — no extra fetch.** The model sees the
    headline plus the body we **already stored** from the feed (`content_html` ??
    `summary`, stripped to text and clamped) to disambiguate league/teams. There
    is **no Jina / full-text fetch** on this path (the classification is cheap and
    adds nothing to the poll's outbound footprint).
  - **Explicit spoiler flag.** The prompt asks Gemini for a small JSON object
    `{ "spoiler": boolean, "headline": string }`. The rewrite is cached **only**
    when `spoiler` is true and a non-empty headline is returned; anything the
    model judges not a spoiler, or any unparseable reply → **keep the original**.
    So the "is this even a spoiler?" decision is the model's explicit flag, and a
    parse failure fails safe (never blanks a title). The classifier runs on one
    **delayed-replay principle**: assume the reader might watch the event later and
    hide anything that would spoil it — the **outcome** (who won/lost/drew,
    advanced, was eliminated, crowned champion; incl. implied framings like
    "Farewell X", "glory for X") **and any in-play moment** (a goal or the running
    score, a red/yellow card, a penalty, a sending-off, a crash/retirement, an
    injury *during play*, who's leading, a comeback). The **only** carve-out is
    **pre-game** content (previews, predictions, build-up, team news before it
    starts); a headline with no event to watch — a transfer, a fixture, non-sport
    news — simply has nothing to spoil. When unsure about a specific event, it
    hides. The rewrite always ends in **"spoiler"** (e.g. "EPL MNU v ARS
    spoiler", "F1 British GP spoiler").
  - **Model:** Google **Gemini `gemini-2.5-flash-lite`** (the same model + key,
    `GOOGLE_API_KEY`, as AI summaries), `thinkingBudget: 0`, JSON response mode.
    Unset key → the poller silently skips the pass. Fixed Google host (the
    headline is in the request body, never a URL → no SSRF surface).
  - **Cached on the shared item** (`items.spoiler_free_title` +
    `spoiler_free_title_generated_at`, 0045): one poll's generation serves every
    subscriber's list. `generated_at` non-null marks an item **processed** (rewrite
    or not), so "needs a pass" is `generated_at is null` — which bounds work to new
    /changed items, and re-queues an item when its title/body changes (the poller's
    `upsert_feed_items` nulls both, exactly like `ai_summary`). **Unlike
    `ai_summary`, it is deliberately NOT gated at the DB / scrubbed from the list
    RPC:** it's a list feature (the point is the river), and it's non-sensitive —
    it *hides* information and is derived from a title the caller can already see.
    So it rides the normal `feed_items` payload and the `ITEM_COLS` read; who
    *sees* the rewrite is gated **client-side** (below). The poller's
    "next unprocessed items" lookup is served by a **partial index**
    (`items_feed_unspoiled_idx (feed_id, sort_at desc) where
    spoiler_free_title_generated_at is null`), which shrinks as items are
    processed — so steady-state cron work scales with *unprocessed* items, not
    the feed's archive size.
  - **Bounded per poll.** The whole pass is capped at `SPOILER_MAX_ITEMS_PER_RUN`
    (40) classifications and a `SPOILER_BUDGET_MS` (60s) wall-clock budget across
    all feeds, so a batch full of allowlisted feeds — or a Gemini slowdown where
    each call hits its timeout — can't keep the Edge Function busy for minutes or
    overlap the next scheduled poll. Whatever's skipped stays `generated_at IS
    NULL` and is picked up next poll.
  - **Display gate (client).** The rewrite shows only when the caller is
    allowlisted (`canUseFullText(useCapabilities())`, the shared reading-mode gate)
    **and** the per-user **"Hide sports spoilers"** setting is on
    (`useHideSportsSpoilers`, a per-device preference, **default on**, in the
    Settings → Smart features section; the toggle is hidden for off-list users). Off-list,
    setting-off, or no rewrite cached → the original headline, untouched. The
    rewritten row/headline carries a **subtle, non-interactive marker**
    (`VisibilityOff` glyph, no tap zone — guardrail #2) whose native tooltip
    reveals the original. In the **Title + excerpt** layout the body preview is
    likewise replaced by a **"Spoilers hidden. Tap to see article."**
    placeholder, and in **Title + thumbnail** the image is **blurred** behind the
    same marker (the feed body/image would otherwise repeat or reveal the
    concealed result — see *Article layout*). **Share** (row and reader) sends the *displayed*
    headline too, so it never leaks the hidden scoreline into the share sheet.
    TODO: make it per-feed as well as per-user.
  - **Backwards compatible (guardrail #11).** The client ships first and safe:
    `mapItem` defaults `spoilerFreeTitle` to null, the `ITEM_COLS` read steps down
    past a missing column on a pre-0045 backend, and display falls back to the
    original — nothing shows until `make migrate` + `make deploy` land and the
    poller populates the column. Server changes are additive.
  - **Cost & reliability (guardrail #5):** one Gemini Flash-Lite call per **new
    item in an allowlisted-subscriber feed** — a headline + short RSS body in, a
    headline out — cached forever on the shared item, regenerated only on
    title/content change. Bounded by *new items in family feeds*; smaller input
    than a summary and **no Jina**, so **effectively $0**. All failure modes are
    soft: no key → pass skipped; a gate-read error → generate for no one (fail
    closed); a Gemini error/timeout → that item keeps its original headline and is
    retried next poll. Items are already stored before the pass runs, so it never
    fails or delays the poll.
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
opened) → **Comments** (💬, conditional — see below) → **Pin/Unpin** (📌) →
**Done** (✓) → **More ⋮**. On wide viewports (≥960px)
**Share** and **Favorite** (♥) surface inline between the conditional Comments
slot and Pin (in that order — Share sits next to Open original / Comments);
below 960px they live in the overflow. Done sits second from the right,
immediately left of the overflow ⋮. (No Upvote — RSS has no votes.)

- **Comments** (chat-bubble icon) is shown **only when the item has a
  discussion destination**, and is a **deep link out** to that discussion — not
  an in-app comment thread (guardrail "No comments, no votes" still holds: we
  don't render or store comments). A **newshacker** destination (our own sibling
  app) opens in the **same tab** (`location.assign`, no hardening) so newshacker's
  Done/back returns to this reader; any other (untrusted) comments URL opens in a
  new tab with `noopener,noreferrer`. The aria-label/tooltip reads "Comments on
  newshacker" when the destination is newshacker, "Comments" otherwise.
  Resolution:
  - On a **Hacker News feed** (`isHackerNewsFeed`) it opens the **newshacker**
    thread (`newshacker.app/item/<id>`), same as the row's "open on newshacker"
    mode. The HN id is derived from the comments URL / guid / item url / body
    (`lib/newshacker.ts`), so it resolves even for the official HN feed (whose
    discussion link lives only in the description) and when the reader's
    single-item read omits `comments_url` (a pre-0033 backend).
  - On **any other feed** it opens the item's structured comments URL (RSS
    `<comments>` / Atom `rel="replies"`, persisted as `items.comments_url`,
    which `ITEM_COLS` now selects — stepping down to the pre-0033 column set
    against a backend without it). If that comments URL *itself* points at an HN
    thread it is still routed to newshacker. The body/url/guid HN scan is **not**
    applied here, so a normal article that merely links to an HN thread in its
    body doesn't sprout a (mislabeled) newshacker button.

  The button is absent — not a fourth always-present action — when there's no
  discussion to open. On a **narrow** viewport, where a fifth 44px action would
  break the ≥320px single-row invariant, the Comments button takes the slot and
  **Pin moves into the ⋮ overflow menu** (like Share/Favorite already do on
  narrow); with no Comments button — or on a wide viewport — Pin stays inline.

- **Feed name** sits immediately right of the leading button (Back on the top
  bar, Back to top on the bottom bar), linking to `/feed/:feedId`. This is the
  **only** place the feed name appears (the header shows just title + meta), on
  both bars so "which feed is this?" stays answerable while reading (the top bar
  is sticky) and at the article's foot. The feed's **site favicon** sits between
  the leading button and the name — the same 16px `feeds.favicon_url` icon the
  rows use (decorative `alt=""`, hides itself on a load error, dark-monochrome
  inversion per `faviconInvert.ts`), omitted when the feed advertises none. It
  grows to fill the gap before the
  action cluster and **truncates with an ellipsis** so a long title can't push
  the actions off the bar; it's a full `--rm-tap` (44px) tap target with a
  pressed `:active` state. Not a new tap zone on the row — it's reader chrome,
  not the feed list.
- **Done** also unpins and **navigates back** (the "I'm finished, move on"
  gesture); **Unmark done** does not navigate. Same as newshacker.
- Bottom bar swaps the primary slot to **Back to top** (neutral, stretched) so
  Pin/Done/⋮ land at the same x-position — handy right where you finish reading,
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
| `/` | aggregate feed of all non-muted subscriptions (`useHomeFeed` can swap to a folder; URL stays `/`. The drawer Home picker is not currently shown — TODO to restore) |
| `/folder/:name` | folder aggregate |
| `/feed/:feedId` | single feed |
| `/pinned` | pinned items (active reading list) |
| `/favorites` | favorite items (permanent) |
| `/done` | completed items (30-day history) |
| `/opened` | recently opened (30-day history) |
| `/offline` | saved items + all articles cached on this device |
| `/item/:id` | reader view |
| `/search` | search over feed + item titles |
| `/settings` | reading, sort, bottom toolbar, theme/palette/text-size/font, account; reached from the account menu (top-right avatar) |
| `/feeds` | feed management: add a feed, subscriptions (reorder/rename/mute/unsubscribe), OPML in/out; reached via the drawer's Feeds edit pencil or the account menu. Code-split. |
| `/admin` | operator console **hub**: no controls of its own, just links (shared `settings__section`/`settings__btn` style) to **Manage users** (`/admin/users`) and **Manage feeds** (`/admin/feeds`); admin-only, reached from the account menu's **Admin** link. Non-admins get a short no-access message (the server re-checks on every RPC). See *Admin*. |
| `/admin/users` | user management: trusted-user allowlist (list / add / remove emails) **and** a registered-users list with a per-row **Manage** (⋯) menu — promote/demote-to-family, block/unblock, delete, view **Feeds** — plus a global allow-new-sign-ups switch; admin-only. See *Admin → Users*. |
| `/admin/users/:email/feeds` | admin drill-down: the feeds a given account subscribes to (`admin_list_user_feeds`, migration 0047); admin-only. See *Admin → Subscription drill-downs*. |
| `/admin/feeds` | feed-status console: every system feed with health, subscriber count, most-recent full-text download status, and per-row refresh / pause / delete / view **Users**; admin-only. See *Admin → Feed status*. |
| `/admin/feeds/:feedId/users` | admin drill-down: the accounts subscribed to a given feed (`admin_list_feed_subscribers`, migration 0047); admin-only. See *Admin → Subscription drill-downs*. |
| `/signin` | OAuth sign-in (unauthenticated landing) |
| `/about` | what Readmo is, credited to its author (mikelward.com); no auth gate, informational only (no user data). Shows the build sequence number and age (e.g. `Build 100 · 2 days ago`) — no SHA — with a link to Debug. Linked from Settings → About. |
| `/legal` | self-contained legal/DMCA page: third-party content, copyright/DMCA takedown + counter-notice, acceptable use, warranty disclaimer, limitation of liability, a privacy summary, and contact (mikel@mikelward.com). No auth gate, policy text only (no user data). Distinct from the standalone `docs/` legal hub (Privacy, Terms, and Copyright/DMCA pages), which Vercel's catch-all rewrite does not serve from readmo.app. Linked from the drawer (App section) and Settings → Legal. |
| `/debug` | build/runtime/config diagnostics; no auth gate, public/presence info only (no secrets). Headline is `<branch-leaf> <commit-count> (<short-sha>)`, e.g. `main 100 (abcdef)`; the Committed/Built rows use the verbose `2 days ago` age format. Runtime groups the badged status rows together — Network, Service worker, and Supabase each carry a glanceable green/red/gray status dot (the Supabase row probes `/auth/v1/health` for live reachability + latency, neutral when unconfigured) — followed by Last sync (relative time of the last server `item_state` pull), Last fetch (the most recent feed-list read's relative time and outcome, with the failure message inline — the phone-reachable answer to "did my refresh run, and what did the server say?"), and the informational rows. A **Diagnostics** section carries the **Scroll-jump diagnostics** toggle (`readmo:debug-scroll-jumps`, per-device, **off by default**) and a **Run feed probe** button: an on-demand grouped + flat home read run outside the query cache that lists rows returned by the backend, rows surviving feed-metadata resolution, the per-feed split, the flat first page, timing, and any error — followed by a snapshot of each live feed-list query's cache (rows held, data age, status, and any error), so an empty feed view can be localized (transit vs. resolution vs. the view's cache vs. rendering) from a device with no devtools. Read-only, own-subscription data only. Linked from the About page. |
| `/debug/scroll` | scroll-jump diagnostics timeline; no auth gate. The timeline is a **per-device, in-memory** buffer — recorded only on this device, only while the toggle is on, never persisted or sent to a server. Each entry is a scroll offset + delta (with the max scrollable offset, the viewport height, and the list-body lock state, for telling a document-shrink clamp from an anchor rewind — and, via `vh`, from a transient dynamic-toolbar viewport *spike* that slashes `maxScroll` and clamps the scroll for a frame; `vh` is on **every** scroll entry precisely because that spike reverts before the next done/resize/probe, so only the scroll event the clamp fires still sees it), a `resize` marker sampled when the document height changes *without* a scroll (catching a background collapse that sets up a later clamp), a Done marker carrying the dismissed item's id **and its headline** (the caller's *own* subscription content, so a copied report can name what was dismissed; never another user's data, and gated behind the off-by-default toggle), or a `probe` marker — one of a short animation-frame burst fired right after each Done to catch the momentary collapse a dismiss triggers (faster than the 150ms resize sampler). The Done/resize/probe markers also carry a **layout breakdown** — the list-body height vs. the whole-document height, the rendered row count, and the viewport height — so a collapse can be localized (body vs. surrounding chrome) and a reflow dip (row count unchanged) told apart from a real removal. When *Scroll-jump diagnostics* is on, the app records every window scroll position and every Done flip into the timeline and raises a sticky **Done — Report bug** toast on each dismiss; tapping **Report bug** freezes the timeline and opens this page, so a jump-to-top after a dismiss/done can be inspected on a device with no console. Shows a headline summary (biggest toward-top jump and whether it followed a Done) and the per-event timeline, with Done markers and big jumps highlighted, plus **Copy timeline** (headline + rows to the clipboard as plain text, for pasting into a bug report) and **Clear timeline** buttons. A no-op — nothing recorded or listened for — while the toggle is off. |

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
| `o` | Open original · `c` Comments (when present) · `p` Pin · `f` Favorite · `d` Done (navigates back) |
| `u` | Go up to this item's feed (`/feed/:id`). RSS articles have no comment tree, so the feed is the "parent" — the analog of newshacker's `u` (parent comment). |
| `b` | Leave the reader the way the Back button would (`closeArticleView`): **(1)** when `window.history.length > 1` the browser has another entry — an in-app feed/list or the external site the reader arrived from in the same tab (cross-origin included) — so `navigate(-1)` back to it; **(2)** otherwise (a lone entry — cold deep link / fresh tab, and unchanged through a `replace`-based sign-in redirect) `window.close()` the tab, dismissing a new tab / Android Custom Tab straight back into the app that opened us; **(3)** if the browser refuses to close it (notably iOS Safari, or a user-opened primary tab), fall back to the home list. We key off `history.length` rather than `location.key` (non-`default` after a `replace`) or the Navigation API's `canGoBack` (blind to cross-origin entries). Same action as the Back button and the Done navigation. |
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
  the tiny `/sw.js` per interval, paused entirely when backgrounded. Finally, a
  **startup** `registration.update()` ping fires once when the watcher mounts:
  the browser's own navigation-time check is throttled and a relaunched
  installed PWA can't rely on its timing, so without this a freshly-opened app
  could sit on a stale bundle until the 30 min periodic ping. The mount check
  re-checks `/sw.js` at the moment the user opens the app; any newer SW found
  surfaces through the same `controllerchange` toast (no forced reload). One
  conditional GET per launch — negligible bandwidth.
- **Stale-chunk auto-reload after a deploy.** Because `autoUpdate` activates a
  new worker (skipWaiting + clientsClaim + cleanupOutdatedCaches) while a tab may
  still hold a stale `index.html`, the first load after a deploy can reference a
  gone content-hashed asset — the entry `/assets/index-<oldhash>.js` or a lazy
  chunk. That asset 404s (the SPA rewrite excludes `/assets/`, so a miss is a real
  404, not the HTML shell served as JS), which without recovery paints an empty
  page until a manual refresh. Three surfaces auto-reload once to fetch the
  current `index.html` + hashes, split across two one-shot session guards keyed
  by what "resolved" means (so a reload can never loop):
  - An **inline boot guard** in `index.html` runs before the entry module — the
    only thing that can catch the *entry* itself failing — and spends the
    `readmo:entry-reload` budget, which `main.tsx` clears the moment it evaluates
    (a boot proves the entry loaded, so a second stale entry later in the same
    session re-arms; loop-safe because a permanently-broken entry never boots).
  - **`installGlobalChunkReloadGuard`** (`src/lib/chunkReload.ts`, wired in
    `main.tsx`, post-boot `vite:preloadError` / dynamic-import rejections /
    hashed-asset resource errors) and **`LazyRouteBoundary`** (`src/components/`,
    a lazy route chunk failing during React render) spend the
    `readmo:chunk-reload` budget, cleared only when a lazy route mounts
    successfully — not on boot, which would loop the reload for a still-failing
    lazy chunk.

  The shared logic (`isChunkLoadError`, `reloadOnceForChunkError`, the two
  clear helpers) lives in `src/lib/chunkReload.ts`.
- Disabled in `npm run dev`.

### Caching strategy

Client reads through Supabase rather than newshacker's `/api/*` proxies, so the
keys differ; the strategies map one-to-one. The runtime caches are
**partitioned per user** (guardrail #8 — see *On-device storage surfaces*): an
account only ever reads its own buckets, the data bucket is chosen by the
credential each request itself carries, and the image/favicon buckets by the
uid the page announces to the worker; the fonts cache alone stays shared.

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
  GET-only) *plus* the read RPCs (`feed_items` and `feed_unread_counts` — POSTs,
  but the primary home/folder/feed reads, so they must be bounded too). A hung read aborts → the read
  rejects → React Query shows the offline/retry UI and resumes on reconnect, and
  the memoized hydration clears so the next read retries. The cap is scoped to
  reads only; deliberately left uncapped: **write RPCs/table writes** (POST
  `rpc/set_item_state`, `rpc/subscribe_to_feed`, DELETE/PATCH on `subscriptions`)
  — aborting
  a slow-but-committing write would surface a spurious error and force a
  redundant outbox retry, so the outbox's own retry/durability (and per-field
  LWW, which makes a re-send idempotent) is the right bound; **Edge Functions**
  (`/functions/v1/` — refresh, discover, fulltext), which legitimately run longer
  than a read; and **auth** (`/auth/v1/`), where a capped token-refresh timeout
  would surface as a failed `getSession()` → the user is nulled → the app
  bounces to `/signin`, turning a transient blip into a spurious sign-out.
  (Even then the on-device caches survive — a dropped session is not a
  departure; see *All client caches…* below.) Every request still flows
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
  treating a timeout as offline). The same adjudication is **hedged**: a bounded
  read still unsettled after 3s (`HEDGE_PROBE_MS`) fires the probe in parallel
  with the still-hanging read (`reportFetchSlow`), so a genuine dead zone —
  lie-fi, where requests hang rather than fail fast — flips the pill in
  ~hedge+probe time instead of waiting out the full read cap first. A
  slow-but-working read is unaffected: the probe reaching the backend changes
  nothing, the read keeps its full cap, and any success landing meanwhile
  (including the SW cache answering the hedged read) suppresses the probe
  failure. Cost/reliability: same Supabase project (no new third party), fires
  only on the timeout/slow-read paths, ~5s budget, coalesced — negligible.
  Hard network errors (`TypeError`/`NetworkError` — DNS, unreachable host,
  dropped connection) flip the **fetch** signal immediately (they fail fast) and,
  because a throw is no response, read as **"Offline"** — we can't prove the
  device has a connection, so we don't blame our backend without evidence. The
  one failure that *is* evidence our backend is the problem is an HTTP **5xx**
  response (reachable but erroring), which shows **"Down"** — see *Offline UX*.
- **An OS connection change triggers an immediate probe (never a label).**
  `navigator.connection`'s `change` event (Network Information API — Android
  Chrome, exactly where `navigator.onLine` lags worst; absent on iOS Safari,
  where the listener is never registered) fires when the OS's view of the
  connection shifts — entering a tunnel, wifi↔cellular — often long before
  `navigator.onLine` flips, or when it never does. The event is treated only as
  a **trigger** for the same liveness probe, never as truth, so labeling stays
  evidence-based: a change that broke nothing is a no-op. This closes the
  no-traffic detection gap (with nothing in flight, a signal loss otherwise
  goes unnoticed until the user's next fetch eats the timeout+probe window at
  the worst moment) and speeds recovery when a change fires as signal returns.
  Coalesced to one probe in flight; skipped while the device reports offline,
  when unconfigured (mock mode), **and while "Down"** — a 5xx means the backend
  is already reachable, and clearing Down (which unpauses reads) is rate-owned
  by the backed-off 30s recovery probe and the focus probe, not by
  machine-chatty change events. Cost: one health-endpoint GET per OS network
  transition — negligible.
- `CACHE_BUSTER` wipes the persisted blob on schema change; the outbox and
  Supabase data are unaffected (server is canonical).
- **All client caches are scoped to the signed-in user and purged on account
  change.** Because Readmo supports sign-out and renders private/tokenized
  content, a shared cache on a shared device could let user B rehydrate user
  A's data before the network corrects it. Key the IndexedDB store **and** every
  Workbox runtime cache by `auth.uid()`, and on an **explicit sign-out or a
  sign-in as a different subject** purge the previous user's IndexedDB store +
  named Cache Storage buckets before the new session paints (treated like a
  `CACHE_BUSTER` bump). A session that merely **drops on its own** — supabase-js
  clears it when a token refresh fails, which happens routinely *offline* — is
  **not** a departure and purges nothing: the stores are uid-scoped so nothing
  can leak to another account, the same user's next sign-in finds their
  `/offline` cache and pins intact, and a *different* user signing in later is a
  uid mismatch that still purges (the boot sentinel keeps pointing at the
  departed user through signed-out boots). The outbox is per-user,
  flushed-or-discarded on
  sign-out. The one place Readmo must be stricter than newshacker, which never
  had multiple identities or private content on a device.
- **On-device storage surfaces.** The client keys these surfaces by the
  signed-in user id — the real `auth.uid()` when Supabase is configured, the mock
  uid otherwise — falling back to the unscoped base key when signed out:
  - `readmo:rq-cache:<uid>` — persisted React Query blob, stored in **IndexedDB**
    (`readmo-cache` DB, `keyval` store; see `lib/idbStorage.ts`). It holds the
    pinned/favorited article bodies warmed for `/offline`, which overflow
    localStorage's ~5 MB synchronous cap — a failed quota write there left
    *nothing* persisted, so a reload-while-offline showed an empty `/offline`.
    Purged on account change like the other scoped surfaces. An upgrading client's
    leftover localStorage copy under the same key is **dropped** (not migrated):
    receiving a new build requires being online, and `useOfflineCacheLock`
    re-warms every pinned/favorited item into IndexedDB on the next online open,
    so the cache repopulates itself. When IndexedDB is unusable (private/incognito
    mode, blocked site storage) offline caching can't work at all — `/offline`
    says so (`useOfflineStorageAvailable`, a usability probe) rather than showing a
    misleading "nothing saved" state.
  - `readmo:item-state:<uid>` — per-item triage state (pinned/favorite/…), in
    `localStorage` (small, synchronous).
  - `readmo:last-uid` — the uid that last booted (sentinel), used to detect an
    account switch that happened via a full-page reload. A signed-out boot
    leaves it pointing at the previous user (see the purge rules above), so
    only a different user's sign-in — or an explicit sign-out — triggers the
    purge.
  - `readmo:explicit-signout` — marker set when the reader taps Sign out,
    distinguishing an explicit sign-out (purge) from a session that dropped on
    its own (keep — see the purge rules above). Withdrawn immediately if the
    sign-out call fails without ending the session (the reader stayed signed
    in — no purge is owed). Three states tracking the episode's lifecycle:
    **pending** (no purge has completed yet) never expires — the sign-out is
    owed a purge however late the device next wakes — and every
    transition/boot that sees it purges; **purged** (a purge completed, no
    sign-in since) keeps signed-out paths re-purging in full through a short
    grace, covering late writes from the sign-out's surviving tabs;
    **reauthed** (a sign-in followed the purge) ends the episode for the
    user's own stores — a session drop in the remaining grace is the new
    session's routine token blip and must not purge — while sign-ins, reloads,
    and drops alike keep sweeping the Workbox runtime caches through the
    grace (belt-and-braces now that those caches are partitioned per user —
    chiefly against legacy unscoped buckets from a pre-partitioning worker).
    Past the grace the marker reads as absent, since a completed
    sign-out must not turn a much-later session drop into a spurious purge. No
    tab ever hard-clears an active marker (any tab could be the wrong one to
    settle it); markers die by the purge stamp + grace expiry, and dead
    leftovers are swept on signed-in boots. Carries no user data.
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
  **partitioned per user** — every account reads and writes only its own
  `<base>:<uid>` bucket (`:anon` when signed out; the fonts cache stays a
  single shared bucket, carrying no user signal). The data cache partitions by
  the credential **the request itself carries** (the JWT's subject), so even a
  departing session's in-flight read lands in its own bucket — no ambient
  "current user" race can cross the boundary; the uncredentialed image/favicon
  proxies partition by the uid the page announces to the worker at boot. A
  purge deletes the departing user's buckets (plus the legacy unscoped names a
  pre-partitioning worker used, which the new worker also deletes once on
  activation). The persisted-query-cache
  IndexedDB move has landed (see `readmo:rq-cache:<uid>` above).

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
  **Below the saved block it lists every other article still in the cache** —
  whatever the last successful fetches left in the persisted feed/library
  pages and warmed details, deduped, newest first, minus rows the reader
  dismissed (Done/Hidden) — so losing connectivity never costs the articles
  already pulled: the last fetch is offline reading material by default,
  pinning just makes it durable.
  The list re-derives on cache mutations (a just-warmed pin appears live) and is
  guarded by `useIsRestoring` so it doesn't flash the empty copy mid-hydration.
  Its empty state reflects what's actually true: if IndexedDB is unusable
  (private/incognito mode, blocked storage) it tells the user to exit incognito or
  grant database permission; with **no** pinned/favorited items it reads "Nothing
  saved offline yet"; with saved items present but **no** cached body for any of
  them on this device it says they "aren't on this device yet" (open one while
  online) — it never claims you saved nothing when you did.
  (The library views `/pinned` and `/favorites` keep the online-first-with-cache-
  fallback read, since they legitimately want fresh server data when online.)
  **Standalone images and cross-device sync are not yet wired** — see *Open
  questions*.
- Pinned/Favorite cache entries lock at `gcTime: Infinity` while the state
  holds and re-lock on cross-tab change / rehydrate / late image fetch (the
  `subscribeToPinnedCacheLocking` pattern). Never evicted while pinned/favorited.
- **The server prepares pinned articles too.** For an allowlisted user, a pin's
  sync write also triggers the full-article download and AI summary
  **server-side** (see *AI article summaries*), so the shared item carries both
  even if this device's prefetch dies with the page — the next warm (this
  device or another) is then a cheap cache hit.

### Offline UX (mirrors newshacker)

- **Connectivity pill** in the header, linking to `/offline`. Its label is
  **evidence-based** — it never *assumes* whose fault a failure is:
  - **"Offline"** — we can't reach our backend: the device reports no network
    (`navigator.onLine === false`), **or** a read threw with no response at all
    (DNS/unreachable/dropped/CORS-less gateway failure — a `TypeError`/
    `NetworkError`). A throw can't prove the device has a connection, so the
    honest, actionable label is "Offline" (find a connection). The user's problem.
  - **"Down"** — the backend *answered*, with a **5xx**: it's reachable and
    erroring (overloaded / failing). Readmo's problem, not theirs. `title` reads
    "Readmo's server isn't responding right now"; the feed/reader views echo this
    in their error copy instead of a blanket "couldn't load".
  - No pill when reads are succeeding.
- **Detection** (`networkStatus.ts`): three signals — `browserOnline`
  (`navigator.onLine` + online/offline events), `fetchOnline` (`trackedFetch`
  clears it on a `TypeError`/`NetworkError` throw; `AbortError` ignored), and
  `backendErroring` (the last read got an HTTP **5xx** — a response, so the SW
  can't have served it from a NetworkFirst cache). Status: `offline` if
  `!browserOnline` **or** a read threw; `backend-unreachable` if a 5xx was seen;
  else `online`. The boolean `online === (status === 'online')` is kept for
  callers that only gate on connected-or-not; `useOnlineStatus` returns it,
  `useConnectivityStatus` the three-way status. This is the fix for the old
  behavior, which *assumed* "Down" on any failed fetch and only fell back to
  "Offline" after two ~30s recovery-probe failures — so a genuinely-offline device
  whose `navigator.onLine` lags `true` sat on a wrong "Down" for up to a minute.
  Now a throw is "Offline" immediately and "Down" requires a 5xx we can actually
  see.
- **Both non-online states back off and self-heal.** Going not-online pauses
  React Query (`onlineManager.setOnline(false)`) — in the **"Down"** case that
  back-off is the point: a 5xx means the backend is struggling, so we stop firing
  reads at it rather than retry-storming. No app read then fires to notice
  recovery, so `networkStatus.ts` re-probes the SW-bypassing liveness endpoint
  (`confirmBackendReachable`, `/auth/v1/health`) every 30s, and immediately on
  regained window focus / tab visibility and on the browser `online` event —
  reconnect is the traffic-free recovery moment, and without an immediate probe
  a backend that recovered while the device was disconnected would keep the
  Down pill (reads paused) for up to a full interval after connectivity
  returned. Like focus, reconnect is rare and user-salient, so it may clear a
  latched Down; machine-chatty connection-change events still may not. A probe that **reaches** the backend
  clears the doubt and flips us online (a read re-evaluates — if it 5xxes again we
  go straight back to "Down", so the load stays capped at ~one read per interval);
  a probe that **can't** reach it leaves us "Offline". The probe's lifecycle keys
  on `awaitingLiveness` (set on any go-not-online, cleared by a **cache-bypassing**
  success — a probe or a non-GET the backend accepted), **not** on the status, so
  a Workbox cache hit (`reportFetchSuccess(false)`) can't flap us back online while
  the backend is still unreachable. **Cost:** negligible — one in-process GoTrue
  GET (no Postgres) every 30s, only while in doubt.
- **Reader body from the list cache (instant open + offline fallback):** the
  reader paints this item's body from a list page already on the device the
  moment it opens — list payloads carry `content_html` (the gated full-text
  fields `full_content_html` and `full_content_via_fallback` are stripped; see
  migrations 0011 and 0026), recovered via
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
  Every *offline* miss-state (reader and list views alike) also offers a
  **"View saved articles" link to `/offline`** — the one view that still works
  without a connection (`LoadError`'s `offlineLink`, decided by
  `loadFailureCopy`).
- **An empty feed view never claims "all caught up" unless online.** The
  caught-up empty state (e.g. Home's "You're all caught up.") implies the server
  confirmed there's nothing unread. A feed view shows it only when the device is
  online and the empty result is genuine. If the view is empty while *offline* or
  *backend-unreachable* — whether the read failed, or a stale cache / fresh-enough
  persisted-empty page returned empty without ever reaching the server — the view
  shows the same miss-state copy + Retry as a failed load (*offline* → "You're
  offline. Reconnect to load items." plus the "View saved articles" link to
  `/offline`; *backend-unreachable* → "Readmo's server
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
- The feed view's PTR also asks the server to re-poll the subscribed feeds
  first, but that poll is **best-effort**: if it fails (rate-limited, offline,
  function error), the pull still re-runs the view's fetch and repaints — a
  pull is never a silent no-op just because the on-demand poll was refused.

---

## Performance targets

- FCP < 1.5s on a 4G mobile profile · initial JS < 150KB gzipped · list render
  < 100ms after data arrives.

## Error handling

- Network/DB errors: inline retry + the background-refresh strip.
- Parked feed: feed-health badge + "retry now", never a silent stall.
- Missing/blank content: "No content — open the original".
- Offline write failures roll back + toast.
- **Runaway-client flood guard (retry discipline).** Retries are disciplined so
  a failing request can't become a flood: the React Query policy never retries a
  4xx/5xx/timeout/abort/server-coded error — only statusless network blips,
  bounded, with capped exponential backoff + jitter (`src/lib/queryRetry.ts`);
  mutations don't auto-retry (the item-state outbox owns write durability). This
  is the in-build complement to the server-side `x-readmo-build` shed (SCALING.md
  → *Shedding a runaway client*).
- **Runaway-client flood guard (circuit breaker).** The additive backstop behind
  the retry discipline: a **client-side request circuit breaker** in
  `supabaseFetch` (`src/lib/data/requestCircuitBreaker.ts`) sheds the
  **network-authoritative reads** — the read RPCs (`feed_items`,
  `feed_unread_counts`) and the NetworkOnly `item_state` hydration GET that
  precedes every feed read — after a burst of consecutive failures, so a *failing*
  loop fails fast instead of pinning the DB, then a single half-open probe recovers
  it. (Any non-2xx from those reads counts as a failure: a stale-backend
  PostgREST `404`/`400`/`422` is a real failed read, not a benign response.) It's
  failure-based, not rate-based — a legitimate bulk burst (e.g. an offline warmup)
  never trips it; volume shedding belongs at the edge. The scope is exactly the
  reads the service worker **never serves from cache**: the read RPCs are POSTs
  (its `NetworkFirst` cache is GET-only) and `item_state` is NetworkOnly, so the
  half-open probe's result always reflects real backend health. **Every other GET
  `/rest/v1/` read keeps the 8s read *timeout* but bypasses the breaker** — those
  are `NetworkFirst`-cached, so a cache fallback could answer a probe with a stale
  `200` the backend never saw and falsely close the circuit mid-outage (and a
  failing cacheable-GET loop is already bounded by the retry discipline + the cache
  fallback). **Writes** (outbox-owned), **auth** (`/auth/v1/`) and Edge Functions
  bypass it too — writes mustn't surface a spurious local failure, and auth must
  stay reachable to recover an expired token / sign out.

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

  Rows stored *before* this collapse shipped still carry the full multi-width
  `srcset`, so the client mirrors the same collapse on read: the reader runs
  `collapseProxiedSrcset` over stored HTML before injecting it, and the offline
  prefetch (`extractProxiedImageUrls`) picks the same ~1600px candidate. Both
  agree on one URL per image, so a stale row warms (and renders) one width
  instead of the whole ladder, and a pinned/favorited article's images stay in
  the service-worker cache offline rather than missing whenever the browser
  would have selected a different candidate.

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
