# Readmo — Contributor guide

Readmo is a mobile-first RSS/Atom/JSON-feed reader PWA (React + TypeScript +
Vite, Supabase backend). It reuses *newshacker*'s UX as-is; the only intended
differences are the data source (your subscriptions, not Hacker News) and the
plumbing that requires (server-side fetch/parse + accounts + sync). The
normative product spec is [`SPEC.md`](./SPEC.md). These are the load-bearing
guardrails — read them before opening a PR.

## Guardrails

1. **Always add tests; always run them before reporting done.** Run
   `npm test`, `npm run lint`, and `npm run typecheck` on every change, and
   `npm run build` when you touch build, routing, or deploy config. Fix a red
   baseline first, on its own commit. 80% coverage floor for `src/lib/` and
   server handlers — enforced in CI by `npm run test:coverage` (aggregate
   lines per area; the Deno-only Edge entry files and `ssrf.ts` are measured
   by the `edge` CI job instead, see vite.config.ts).

2. **Fewer, larger tap targets.** At most **3 tap zones per row, two shipped**
   (row-body stretched link + right-side icon button; the middle slot stays
   reserved). **44×44px** touch floor on every interactive control, **≥8px
   gaps**, pressed-state on every zone. Flag anything that adds a fourth
   tappable or fills the reserved slot.

3. **US English everywhere** — copy, identifiers, CSS class names, DB column
   names, comments, docs (*favorite*, *color*, not *favourite*/*colour*).

4. **Keep `SPEC.md` in sync with reality.** Update it in the *same commit* as
   any reversed/extended decision or any new user-visible behavior, tap
   target, storage surface, route, or layout reorder.

   **SPEC states product intent and user-visible decisions — not
   implementation mechanics.** SPEC captures what the product does and why
   (the contract): behaviors, tap targets, storage surfaces, routes, layouts,
   and the reasons for decisions. It does *not* capture how the code achieves
   it — data structures, function names, CSS properties, DOM APIs, event
   orderings, timing constants, browser-quirk workarounds, measurement
   formulas. Those live in code comments and tests, next to the code that can
   drift.

   *Rule of thumb:* if changing the implementation (without changing
   observable behavior) would force a SPEC edit, that text is in the wrong
   place — it's an implementation detail and belongs in a code comment. SPEC
   should only change when the decision or the observable behavior changes.

   When a SPEC section has accumulated mechanism (identifiers, APIs, formulas,
   frame counts, workaround narration), trim it back to the intent as a *net
   deletion*; don't keep expanding it per fix. Moving that detail into code
   comments is the fix, not adding more.

5. **Call out cost and reliability up front** for any new infra or external
   call — free-tier vs. paid, rough $/mo, failure modes, rate limits, latency.
   Say "negligible" explicitly rather than omitting it.

6. **Treat all publisher content and user-supplied URLs as untrusted.**
   - **Sanitize every piece of publisher HTML server-side** (strip
     scripts/handlers/disallowed tags, absolutize relative URLs, force
     `rel="noopener"`) before storing. Never store or serve raw publisher HTML.
   - **Route every server-side fetch through the SSRF-hardened helper**
     (`/api/discover`, the poller, the image proxy, any future full-text
     fetch): scheme allow-list (http/https only), resolved-IP denylist
     (loopback, link-local incl. `169.254.169.254`, RFC1918, ULA, reserved),
     re-validate every redirect, timeouts + size caps, no credential
     forwarding. A unit test asserts it rejects loopback/link-local/private/
     metadata targets and redirects to them.

7. **RLS is the per-user boundary.** Every per-user table
   (`subscriptions`, `item_state`, `folders`) is gated on `auth.uid()`; fail
   closed. The **client never receives the service-role key** (poller only).
   `feeds`/`items` are physically shared but **not world-readable** — a row is
   exposed only when the caller has a matching `subscriptions` row *or* a
   permanent (`pinned`/`favorite`/`done`) `item_state` row pointing at it.
   Keep secret/tokenized feed URLs (`secret_url`) server-only. **Sharing carve-out
   (capability, not RLS):** a hosted `/item/:id` link opens for any signed-in
   recipient via the `get_shared_item` `SECURITY DEFINER` read — keyed on the
   unguessable item uuid, returning display-safe columns only, and **only for a
   public feed** (no `secret_url` + non-tokenized `url`). It does **not** widen
   the row policies; full text/summary stay allowlist-gated. See SPEC *Sharing an
   article*.

8. **Scope client caches by `auth.uid()` and purge on account change.** Key the
   IndexedDB store and every Workbox runtime cache by the signed-in user; on
   any auth transition (sign-out, or sign-in as a different subject) purge the
   previous user's store + named caches before the new session paints. Never
   leak one user's cached/private content to the next on a shared device.

9. **Match newshacker's UX by default.** When in doubt about an interaction, do
   what newshacker does. Diverge only for the documented RSS-specific reasons:
   no comments/votes, server-side data, accounts/sync.

10. **Branching:** one topic per `<agent>/<short-topic>` branch off `main`; one
    commit per logical surviving change; PRs ready for review. See *Branching*
    below for the full rules.

11. **Ship a backwards-compatible client; flag manual deploys.** The frontend
    auto-deploys on merge, but the Supabase backend (Edge Functions +
    migrations) only goes live when a human runs `make deploy`/`make migrate` —
    so client and server roll out on different clocks. Never merge a client
    that *requires* an unshipped server change; tolerate the older backend it
    may actually hit, keep server changes additive so service-worker-cached old
    clients keep working, and call out any required manual backend deploy in the
    PR description and your end-of-turn summary. See *Deploying & client/server
    compatibility* below.

12. **Ask before adding wordy in-product copy.** Settings options, controls,
    and labels should speak for themselves. Don't ship "this is self-hosted
    so…", "we do this because…", or any other explanatory blurb/hint/aside
    next to a control without asking first — the control's label is the copy.
    If a control genuinely needs context, propose the wording and wait for a
    yes before merging it.

## Project layout

```
src/
  components/    shared UI components (rows, toolbars, action bars, chips)
  hooks/         React hooks (item state, swipe, online status, …)
  lib/           pure logic + utilities (theme, formatting, types)
  lib/data/      the data-access abstraction:
                   DataSource.ts     — the DataSource interface (the seam)
                   MockDataSource.ts — in-memory impl used today + in tests
                   context.tsx       — React context/provider for the source
                   seed.ts           — seed/fixture data for the mock
  pages/         route-level views (feed, library, reader, settings, signin)
  styles/        global.css with the --rm-* design tokens (e.g.
                 --rm-accent: #3a4ec4, --rm-bg, --rm-text, --rm-read) —
                 use the tokens; don't hard-code colors
  types/         ambient/build type declarations
public/          PWA icons + manifest assets (generated; see below)
scripts/         dev one-shots (generate-icons.mjs)
supabase/        Postgres migrations + Edge Functions (poller, discover,
                 SSRF helper, feed parser, sanitizer) and their fixtures
```

The data layer is abstracted behind **`src/lib/data/DataSource.ts`**.
`SupabaseDataSource` is the live implementation whenever Supabase is configured
(real RLS-scoped subscriptions + item state, written through to the server via
the async outbox); `MockDataSource` is the backend-less local/demo fallback
(`main.tsx` picks between them). Both satisfy the same interface — build features
against `DataSource`, not a concrete source, and remember that on the live source
a mutation's server write lands **asynchronously** (the outbox drains after the
optimistic local update), so anything that reads server truth right after a write
must tolerate the lag.

## External services

Per guardrail #5, cost and reliability are documented here for every
third-party call the app makes.

| Service | Purpose | Cost | Rate limits | Latency | Failure mode |
|---|---|---|---|---|---|
| **Jina Reader** (`r.jina.ai`) | (1) Fallback HTML fetch for bot-blocked discovery (403 responses) and reading mode; (1b) **bot-blocked homepage favicon discovery** for the poller/refresh path (`_shared/jina.ts`) — when a feed advertises no icon, its `/favicon.ico` guess 404s, and its homepage 403s our fetcher (ft.com, economist.com), one Jina fetch of the homepage recovers the real `<link rel="icon">`; one-shot per feed, blocked-path only; (2) the **primary article fetch (markdown) for AI summaries** (the `summary` Edge Function), keeping summaries off our polite first-party fetcher. Configured via `JINA_API_KEY` Supabase secret; skipped silently if absent (summaries fall back to the stored body; favicon discovery falls back to the `/favicon.ico` guess). Tokenized/secret-bearing URLs are screened out before forwarding. | Free tier: 1 M tokens/month (~500–1000 page fetches). Paid from ~$0.02/1 M tokens. A single fetch is typically 10–100 K tokens. | Free tier: ~200 req/min. | Discovery/reading-mode: +1–5 s only on the 403 path. Favicon discovery: one Jina fetch (~1–5 s) once per feed, only when its homepage is bot-blocked. Summaries: one Jina fetch (~1–5 s) on the first open (or pin pre-warm) of an article, cache-instant after. | On timeout, non-2xx, or body-size-cap hit, the Jina helper returns `null`: discovery surfaces the original `auth` error; favicon discovery falls back to the `/favicon.ico` guess; summaries fall back to summarizing the already-stored body. |
| **Google News RSS** (`news.google.com/rss/search`) | Last-resort feed discovery: a `site:<domain>` search feed offered when neither the pasted page nor the site home page advertises a real feed, so the reader still gets *something*. Fetched + parsed through the SSRF-hardened path like any other candidate. No API key. **Gated on the trusted-user allowlist** (the DB `allowlist` table, managed from `/admin`): when the table is non-empty, only listed callers are offered Google News feeds (added, discovered, or this fallback); the gate functions read it via `loadAllowlistFromDb` (`_shared/allowlist.ts`). See SPEC *Feed discovery*. | **$0** — free, public, keyless. | Unofficial/undocumented endpoint; no published quota. Discovery only hits it on the empty-result path (one request), so volume is low and well under any informal ceiling. | One extra fetch+parse, only on the otherwise-"no feed found" path — never on the happy path. | Unofficial: Google may change/throttle/remove it without notice. On any non-2xx, timeout, SSRF block, or an empty result set for the domain, the candidate is simply dropped and discovery falls back to the existing "no feed found" message — no worse than today. |
| **Google Gemini** (`gemini-2.5-flash-lite`) | Two uses, same model + `GOOGLE_API_KEY` secret. (1) The short **AI article summary** (a few sentences) shown at the top of the reader for an allowlisted user — generated automatically only for an article **pinned before opening** (a pin by an **allowlisted** user triggers the work server-side — the 0053/0054 DB trigger, which downloads the full article and summarizes concurrently — and pre-warms the device cache), else on demand via a **"Generate summary"** button (the `summary` Edge Function). Summarizes text fetched via **Jina** (markdown), falling back to the stored sanitized body. (2) The **spoiler-free sports headline** — for feeds with an allowlisted subscriber, the **poller** classifies each new headline and, when it spoils a result, caches a spoiler-free rewrite ("EPL MNU v ARS spoiler") on `items.spoiler_free_title`; input is the headline + the **already-stored RSS body only** (no Jina/fetch). Both skip silently when the key is unset. | Flash-Lite ≈ $0.10 / 1M input tokens, $0.40 / 1M output. **Summary:** a few-K-token input + short output, generated **once per article** (shared cache), only for pinned or explicitly-requested articles, bounded by *distinct pinned/requested articles* across the family set — **effectively $0**. **Spoiler title:** one call per **new item in an allowlisted-subscriber feed** — smaller (headline + short body) input, no Jina — cached forever, regenerated only on title/body change; bounded by *new items in family feeds* — also **effectively $0**. (Empty allowlist → the poller and the pin trigger generate for no one, the cost guard against an unseeded deploy.) | Standard Google AI Studio quotas (generous; far above family volume — only cache misses call out). | Summary: one Jina + one Gemini call (~2–7 s) on the first open. Spoiler title: one Gemini call per new item at poll time (off the user's path entirely). Cache-instant thereafter. | Summary: Gemini down/timeout → `unreachable` (retryable), a "Could not summarize" card with Retry; key unset → `unavailable`, no card. Spoiler title: any failure → the item keeps its original headline and is retried next poll; key unset → pass skipped. All soft — articles, reading mode, and polling are unaffected. |
| **SMTP relay** (provider-agnostic, e.g. Fastmail / Gmail / SES) | Sends the operator a "new user signed up" email from the `notify-signup` Edge Function, triggered by the `auth.users` insert trigger. Configured via `SMTP_*` Supabase secrets; trigger no-ops if unset. | **Negligible** — one email per new account; every mainstream relay's free tier covers signup volume many times over. | Provider-dependent (e.g. Gmail ~500/day); far above signup rate. | Off the critical path: `pg_net` posts fire-and-forget *after* the signup commits, so SMTP latency never delays or blocks account creation. | Relay down/rejecting → function returns 502; secrets unset → no-op/500. Only the *alert* is lost; the account is still created. |
| **Supabase Auth email** (GoTrue sender — built-in or custom SMTP) | Delivers the **passwordless magic-link sign-in** email when a user submits their address on the sign-in page (`signInWithOtp`). Sent by GoTrue itself, configured under Authentication → Emails — separate from the `SMTP_*` secrets above. Built-in sender is test-only; production points Auth at a real SMTP relay (SETUP.md §4). | **Negligible** — one email per email-sign-in attempt; any mainstream relay's free tier covers sign-in volume many times over. Built-in sender is $0 but capped at a few emails/hour (not for production). | Built-in: a few/hour (hard, silent). Custom relay: provider-dependent (e.g. SES generous), far above sign-in rate. | One email round-trip (seconds) before the link arrives; off every in-app path (the user completes sign-in from their inbox). | Sender down / rate-limited → link never arrives; `signInWithOtp` may still return success (queued server-side), so the client can't always detect it. **Email sign-in degrades; OAuth (Google/Discord) is unaffected.** Provider unset → built-in sender used (test-only cap). |
| **Supabase Metrics API** (`/customer/v1/privileged/metrics`) | Out-of-band database performance monitoring: a Prometheus endpoint of ~200 Postgres/host health series, scraped externally so detection adds no load to the DB and survives a DB outage. Basic-auth as `service_role`. See `OBSERVABILITY.md` / SETUP.md §12. | **$0** — included on all hosted Supabase projects (incl. free tier). | One scrape/min (the set refreshes ~1×/min). | Not on any user path — external scrape, computed by Supabase, **zero load on our Postgres**. | **Beta** (metric names/labels may change) and **hosted-Supabase only** (self-hosted needs `postgres_exporter`). A scrape failure *is* the "DB unreachable" signal. |
| **Grafana Cloud** (or any Prometheus collector) | Scrapes the Metrics API, evaluates the DB-performance alert rules, and pages (dedup / `for:` hysteresis / re-notify / silences). The paging layer that turns saturation into one incident instead of an email a minute. | Free tier covers a one-operator project; paid only if series/retention outgrow it. | Free-tier ingestion/series caps (generous at this scale). | Separate system from our DB — adds no user-facing latency. | A separate system, so it keeps paging during a Supabase incident (the point of out-of-band detection). If Grafana itself is down, detection lapses until it recovers; the DB is unaffected. |

## Deploying & client/server compatibility

Readmo ships as two halves that deploy on **different clocks**:

- **Frontend (the client)** — React/Vite on Vercel. **Auto-deploys** on every
  push/merge to `main` via Vercel's GitHub integration; no manual step. (Lone
  exception: after changing a Vercel env var you must redeploy — existing
  deployments keep their original env snapshot.)
- **Backend** — Supabase **Edge Functions** (`supabase/functions/**`, incl.
  `_shared/`) and **Postgres migrations** (`supabase/migrations/*.sql`). **CI
  never deploys these** — it only type-checks/tests them. They go live only when
  a human runs `make deploy` (= `make migrate`, then deploy every function) or
  `make migrate` / `make deploy-<fn>`. See SETUP.md §6.

Because the two roll out independently, a merge can put a **new client in front
of an old, not-yet-deployed backend**, and — once you do deploy — a **new
backend in front of an old, service-worker-cached client** (PWA clients can lag
arbitrarily). Both directions have to keep working.

**Keep the client backwards compatible.**
- Never merge a client that *requires* a server change that isn't deployed yet.
  If a change spans both halves, either deploy the backend first, or gate the
  new client behavior behind a capability/feature check so it no-ops against the
  old backend.
- Treat new server capabilities as **optional** until their deploy lands:
  feature-detect, fall back, and don't hard-crash on a missing Edge
  Function/RPC/column (404, `PGRST` "not found", or an unexpected response
  shape). The newest client must still work against the currently-deployed
  backend.

**Keep server changes backwards compatible too.**
- Make backend changes **additive** (new columns/RPCs/params; new function
  versions that still accept the old request shape). Don't remove or rename an
  RPC/column/param a shipped client still calls — an old cached client will keep
  hitting it after you deploy.
- The `x-readmo-build` + `MIN_CLIENT_BUILD` version gate
  (`supabase/functions/_shared/clientVersion.ts`; 426 Upgrade Required) is the
  deliberate escape hatch to *shed* old clients when one is actively harming the
  backend — not a license to break compatibility casually.

**When a manual deploy is required.** Merging alone does **not** make these
live — note the required command in the PR description and your end-of-turn
summary:

| You changed… | Goes live via | Manual? |
|---|---|---|
| `src/`, `index.html`, frontend build/routing config | push/merge to `main` (Vercel) | No — auto |
| `supabase/migrations/*.sql` | `make migrate` (`supabase db push`) | **Yes** |
| `supabase/functions/**` (incl. `_shared/`) | `make deploy` (migrates first) or `supabase functions deploy <fn> --import-map …` | **Yes** |
| Supabase secret/config (`MIN_CLIENT_BUILD`, `JINA_API_KEY`, `SMTP_*`, …) | set via Supabase dashboard/CLI; arming the version gate is an operator action | **Yes** |
| Vercel env var | redeploy the frontend (env snapshot is per-deploy) | **Yes** |

When a PR touches both `src/` and `supabase/`, **deploy the backend before the
client reaches users** (or make the client tolerate the old backend), and call
out the required `make deploy` / `make migrate` in the PR.

## Dev commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (service worker disabled) |
| `npm run build` | `tsc -b` typecheck + `vite build` |
| `npm run preview` | Serve the production build |
| `npm test` | `vitest run` (one shot) |
| `npm run test:coverage` | tests + the 80% coverage floor (what CI runs) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint over the repo |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run icons:generate` | Regenerate `public/` icons (`node scripts/generate-icons.mjs`) |
| `npm run feeds:check` | Fetch every `popularFeeds.ts` URL and report dead/non-feed entries (`--json` for machine output). Manual/CI only — makes one request per feed; egress-blocked sandboxes show all as failing. |

Run `lint`, `typecheck`, and `test` before every PR; add `build` when you touch
build/routing/deploy.

## Testing expectations

- **The test environment is Vitest + jsdom.** Pure-logic tests that need Node
  instead opt in per-file with a docblock pragma at the top:

  ```ts
  // @vitest-environment node
  ```
- **Fix any preexisting test failures as the *first* commit of the series.**
  If `npm test` is already red when you start a task, don't stack your work
  on top of a broken baseline. Land the fix first, on its own commit. If the
  failure is genuinely unrelated and out of scope, say so in the first
  response and confirm with the user before skipping past it — don't silently
  report a task "done" with the tree still red.
- **Avoid racy / flaky tests.** Never paper over a timing race with
  `await new Promise(r => setTimeout(r, 500))`, a retry loop, or a bumped
  `findBy*` timeout. If a test depends on ordering, make the ordering
  explicit: resolve a controlled promise, advance fake timers, wrap in
  `act(...)`, or hold the in-flight fetch open behind a gate you release from
  the test. A test that passes "most of the time" is broken; rewrite it or
  fix the underlying cause.

## Vercel `api/` gotchas

- **No shared modules for `api/*.ts` — keep helpers inlined, even if they're
  duplicated across handlers.** Learned on Vercel in newshacker, where both
  obvious escape hatches failed *only at deploy time* after every local check
  passed: importing from outside `api/` (the bundler's import tracer includes
  such files inconsistently) and importing from a `_`-prefixed directory
  inside `api/` (Vercel treats `_` as "don't route" *and* "don't ship", so the
  deployed function dies at startup with `ERR_MODULE_NOT_FOUND`). A
  non-underscore subdirectory would ship, but every file in it would be routed
  as its own function. The accepted pattern is to copy-paste the helper, add a
  comment pointing at the siblings, and move on.

  A regression test at `api/imports.test.ts` scans every `api/*.ts` file and
  fails if it imports from a subdirectory of `api/` or from a parent
  directory. Delete that test only after actually deploying and verifying a
  new approach works on a Vercel preview.

## Talking to the user

- **One question at a time.** Never stack multiple questions in a single
  turn — ask the most important one, wait for the answer, then ask the next if
  you still need it. A wall of bundled questions is harder to answer than a
  short back-and-forth.
- **Don't interrupt.** Never fire off a question while the user is still
  typing. Let them finish; a half-typed message isn't an invitation to jump in.
- **Keep replies short — don't dump a full page.** Lead with the single most
  important point and stop. If there's more, say the first point and ask
  whether they're ready for the next one rather than emptying everything at
  once.

## Asking questions

- **Ask in chat, never with `AskUserQuestion`.** That's Claude Code's
  multiple-choice question prompt, and it's broken in the Claude mobile app —
  a question asked through it may be unanswerable. Plain chat also keeps the
  question, its context, and the answer in one readable thread.
- **After asking, stop and wait for the answer.** Don't proceed on an assumed
  answer, pick a "recommended" option yourself, or keep working on the part
  the question affects.
## Node version

- **The Node major is named in three places and they move together or not at
  all:** `.nvmrc` (CI's `setup-node` via `node-version-file`, `nvm use`, and
  the web sandbox's session-start hook), `engines.node` in `package.json`
  (Vercel's build image and function runtime, plus npm's EBADENGINE warning),
  and `@types/node` (what `tsc` believes the runtime's stdlib looks like).
  `nodeVersion.test.ts` fails CI on a mismatch.
- **A split is quiet in the worst way** — the suite goes green on one runtime
  while production serves another, or `tsc` type-checks against APIs the
  deployed Node doesn't have.
- **The web sandbox is the consumer that can't follow on its own.** Its image
  ships whatever Node it ships (22 today), so `.claude/hooks/session-start.sh`
  provisions the `.nvmrc` major before `npm install` — before any native dep
  builds against an ABI. It re-resolves the newest release of that major every
  run rather than trusting the container's cached copy, because container state
  survives between sessions and an existence-only check would pin the first
  version ever installed. Best-effort: an unreachable nodejs.org keeps the
  cached toolchain and says so, rather than failing session startup.
- **The hook is identical in all three repos, and so is its test.**
  `scripts/session-start-hook.test.ts` runs the real hook end to end against a
  temp install root and a `file://` release fixture, via the `SESSION_NODE_ROOT`
  and `SESSION_NODE_DIST_URL` seams — no network, no stubbed internals. Its
  failure mode is a *false pass*, so behavior is asserted, not structure. When
  you change the hook, change it everywhere and keep the Node block byte-identical.
- **A `@types/node` major is a runtime migration, not a dependency update.** A
  packageRule disables that major so it stops arriving as an unmergeable
  weekly PR. When you do move the runtime, move all three pins in one commit.
- **Assert the `@types/node` version npm *resolved*, not the range declared.**
  `vite`, `vitest` and `msw` all depend on it with ranges permissive enough to
  resolve any newer major, so a declared-range check stays green while `tsc`
  loads something else entirely. newshacker had no direct dependency at all and
  was type-checking `vite.config.ts` against Node 26 types on a Node 24
  runtime; `nodeVersion.test.ts` here reads the lockfile for that reason.
- Currently Node **24** (the active LTS; 22 dropped to maintenance when 26
  shipped).

## Dependency updates

- **Renovate (Mend-hosted app) owns dependency bumps.** Config lives in
  `renovate.json` at the repo root; validate changes with
  `npx --package renovate renovate-config-validator`.
- **Renovate silence is not success — every failure mode here is silent.** A
  bot that opens nothing looks exactly like a repo with nothing to update.
  This config landed on Jul 12 and produced zero PRs and — the telling part —
  no dependency dashboard issue either, which "nothing needs updating" does
  not explain. If PRs go quiet, open the per-repo job log at developer.mend.io
  before assuming there's nothing to do. A `DONE` job does not mean Renovate
  did anything: a silent-mode run clones, scans, extracts, creates nothing,
  and reports `DONE`.
- **`mode=silent` suppresses everything, and the authoritative switch is
  Mend-side.** The Mend-hosted app injects its own config via
  `RENOVATE_CONFIG` and defaults an "All repositories" install to silent: no
  PRs, no `renovate/*` branches, no Dependency Dashboard, not even an
  onboarding PR. `"mode": "full"` here states the repo-side intent (and is what
  a self-hosted or CLI run honors), but the injected value wins — the other
  half is developer.mend.io → repo/org → Interactive.
- **A top-level `schedule` is a delay, not a gate.** The per-update-type
  `minimumReleaseAge` cooldowns (5 days patch / 7 minor / 14 major) plus
  `prConcurrentLimit` are what pace volume; a window only parks updates that
  have *already* cooled down, and this repo's weekly window added up to six
  days on top for no benefit. Schedules never apply to security fixes —
  Renovate forces `schedule: []` and `prCreation: immediate` on
  vulnerability-alert branches, so don't blame a window for a missing advisory
  PR.
- **Deleting `lockFileMaintenance.schedule` does not mean "any time".** That
  option's own default is `before 4am on monday`, so dropping the key silently
  restores a weekly window instead of removing one. `renovate.test.ts` guards
  that, along with `mode` and the top-level `schedule`.
- **Minors and patches auto-merge on green CI; majors always wait for review.**
  Pre-1.0 (`0.x`) packages are excluded — SemVer permits breaking changes in a
  0.x minor. Auto-merge is only as safe as CI, so a red or skipped check is a
  stop sign, not noise to route around.
- **The Deno import map has no ecosystem behind it**, so no built-in manager
  sees it. A custom regex manager bumps `supabase/functions/import_map.json`
  in the *same* branch as the matching `package.json` bump; without it a bump
  edits package.json + the lockfile and silently leaves the map behind, which
  is how `entities` ran 8.x in tests and 7.x in production.
  `import_map.test.ts` fails CI on that drift.

## Error handling

- **Don't silently swallow exceptions.** A bare `catch {}` or
  `catch (e) { /* ignore */ }` hides real failures in the field and burns
  hours when something eventually breaks. Every catch needs to do three
  things: **log** the error with enough context to identify the failed call —
  the operation, the feed or item id, the status code — but **sanitized
  context only**. Never log a token, API key, service-role key, `secret_url`
  or tokenized feed URL, or a raw request/response body; the *Privacy* rule
  below applies to logs too, so redact or summarize instead ("poll of feed
  42 failed: 403", not the URL that carried the token). **Clean up** what the
  `try` acquired — abort controllers,
  in-flight fetches, outbox entries, partial writes, in-progress UI state —
  so a failure doesn't leak resources or leave the app half-mutated; and
  **handle the edge case explicitly** — pick how the caller sees this failure
  (default value, `null`, a typed error result, rethrow) rather than letting
  control fall through. Two traps specific to this codebase: a blanket
  `catch` swallows `AbortError` from a deliberately-canceled fetch, turning a
  normal cancellation into a silent no-op; and swallowing a Supabase/Edge
  error is how a *feature-detect* fallback (guardrail 11) turns into "the
  write silently didn't happen". Narrow the type. If you genuinely do want to
  ignore a specific failure, name the reason in a one-line comment
  ("publisher 404s on dead items, treat as empty") and still log at debug.

## Privacy

- **Never put user data in any artifact that leaves this machine.** That
  includes commit subjects and bodies, PR titles / descriptions / comments,
  review replies, issue text, branch names, code comments, test fixtures, and
  anything else that ends up on GitHub or in logs. Here that covers the
  operator's and any user's email address, `auth.uid()` values, Supabase
  service-role keys, `JINA_API_KEY` / `GOOGLE_API_KEY` / `SMTP_*` values,
  allowlist membership, and — most easily missed — **`secret_url` and any
  tokenized feed URL** (guardrail 7 keeps those server-only; a fixture is
  still "off the machine"). Use generic placeholders
  (`alice@example.com`, `https://example.com/feed.xml`, `sk-example`) in
  examples, fixtures, and reproductions. If a user-supplied bug report
  contains any of it, paraphrase in the commit / PR — don't quote verbatim.
  When in doubt, ask before pushing.

## Safe vs. risky actions

- Safe: edit files, add dependencies, run tests, run the dev server,
  creating new `<agent>/<short-topic>` feature branches, creating PRs via
  `mcp__github__create_pull_request` once the user has asked you to open one
  (and for subsequent follow-up PRs in the same thread — don't keep
  re-asking), `git push --force-with-lease` to your own live feature branch
  after a rebase (this is normal hygiene, not a risky action), and the
  Codex-review round-trip on your own PRs:
  `mcp__github__add_reply_to_pull_request_comment` and
  `mcp__github__resolve_review_thread` (see *Codex reviews* below for where
  the `threadId` comes from).
- Ask first before: force-pushing to `main`/`master` or to a merged branch,
  rewriting history on shared branches, deleting branches you didn't create,
  changing Vercel/Supabase project settings, changing CI secrets, adding
  paid/third-party services.

## Branching

- **Branch naming.** Feature branches are prefixed with the agent's own short name: `<agent>/<short-topic>` (e.g. `claude/...` for Claude Code). Human contributors pick a name that identifies them.
- **Workflow.** `<agent>/<short-topic>` branch off `origin/main` → PR → merge via rebase or squash. One topic per branch. Follow-up work after a merge goes on a new branch. Never commit to `main` / `master`.
- **Use `git worktree` when it's available.** Give each branch its own worktree instead of switching branches in place, so work in progress on one branch isn't disturbed by work on another.
- **One commit per logical surviving change on the branch.** Rewrite unmerged commits freely (squash, amend, reorder, split with `git rebase -i` / `git reset --soft`) so each landing commit is one coherent change, with fix-ups and review responses folded into the commit they belong to. A PR can be a single commit or a short series — but review-fix noise doesn't survive into `main`.
- **Check state before you push or branch.** Query the branch's PR via the GitHub MCP first.
  - No PR yet, or PR open → `git push` (`--force-with-lease` to your own feature branch after a rebase is fine; don't ask).
  - PR merged / closed → don't push. Merge-path hygiene: `git fetch origin`, cut a fresh `<agent>/<short-topic>` branch off `origin/main`, announce the switch.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene *before* engaging with the rest of the message.**
- Creating new `<agent>/<short-topic>` branches and creating PRs via `mcp__github__create_pull_request` (once the user has asked for one in the thread) are safe — don't re-ask.
- Sandbox git proxy can't delete branches (HTTP 403). Flag it and move on; auto-delete-on-merge handles GitHub's side.
- **After every push and after every merge, report the resulting HEAD SHA** so the operator can verify which build is deployed. Format: `pushed <short-sha>` after a push; `merged at <short-sha>` after a merge webhook. 7-char prefix is fine. Mention it once per push.
- **On every push, update the PR body and print the PR link.** Whenever you push to a branch that has an open PR, edit the PR description (`mcp__github__update_pull_request`) so it still matches what's on the branch — new commits, reversed decisions, changed scope — and print the PR link in the chat reply for that push, not only at the end of the conversation. If no PR exists yet, do this as soon as one is opened.
- **Unshallow before answering anything that depends on git history depth.** The sandbox clones shallow, so `git rev-list --count`, `git log` past the shallow boundary, blame, and any "how many commits / what's the build number" question return wrong answers without warning. If `git rev-parse --is-shallow-repository` says `true`, run `git fetch --unshallow` first — same rule `vite.config.ts` already follows for the `build` field shown in `/debug`. Don't quote a count off a shallow clone.
- End every reply with the open-PR link (or `.../compare/main...<branch>` until a PR exists). Never link to a closed or merged PR.

## Codex reviews

**Codex is the automated reviewer on this repo** — not Copilot. Its reviews are triggered automatically; you don't request them.

- **Address Codex comments automatically — don't wait to be asked.** When a Codex review lands, treat each comment like a real review note: read it, decide whether it's a real issue or a false positive, and if it's real, fix it in the same PR. Fold the fix into the commit it belongs to (rebase / `--fixup`) rather than tacking on an "address review" commit, per the *one commit per logical surviving change* rule. Group several small fixes into one commit when they share a topic.
- **Reply to (and resolve) every addressed Codex comment** via `mcp__github__add_reply_to_pull_request_comment`, then `mcp__github__resolve_review_thread`. Do this for each addressed comment, not in bulk.
- **Don't resolve threads you haven't addressed.** If you disagree with a suggestion or are deferring it, leave the thread open and reply explaining why.
- **Order of operations on a push that addresses review comments:** (1) push the fix commit, (2) reply on each addressed thread referencing the new sha, then resolve it. Doing (2) before (1) means the sha you cite doesn't exist yet.
- **`resolve_review_thread` works — the old MCP limitation is fixed.** `mcp__github__pull_request_read` / `get_review_comments` now returns each thread's node ID (`PRRT_*`) on the `review_threads[].id` field, alongside `is_resolved` / `is_outdated` / `is_collapsed`. Pass that `PRRT_*` value straight to `mcp__github__resolve_review_thread` as `threadId`. Do NOT pass a comment's node ID (`PRRC_*`) — that fails with `Could not resolve to PullRequestReviewThread node`; the thread ID and the comment ID are different objects. So the full round-trip is available, with no "replied-but-unresolved, please resolve in the UI" caveat in the end-of-turn summary.

  > **History.** This was previously documented here as broken: the response stripped the thread node ID, leaving no way to obtain a `threadId`. Tracked upstream as github/github-mcp-server#2331 (issue) and github/github-mcp-server#2245 (fix), and verified working against a real Codex review thread on 2026-07-24. Kept as a note rather than deleted so the next agent that hits a resolve failure knows this was a real, since-fixed upstream bug and doesn't re-derive it.

- **Report when Codex finishes reviewing a fresh push.** Codex's review runs asynchronously after each push; once its review event lands for the latest commit, surface a one-liner naming the SHA and comment count — e.g. `Codex reviewed 87d9f02 — 0 comments` or `Codex reviewed 87d9f02 — 3 comments, addressing now`. Tie it to the *latest* pushed SHA so a stale review of a superseded commit isn't conflated with the current state.
- **Skip echo events silently.** `mcp__github__add_reply_to_pull_request_comment` / `add_issue_comment` post under whichever GitHub identity backs the MCP auth (typically the repo owner's), so a moment after you post a reply the same body comes back as a webhook event authored by that identity. That's the echo of your own reply, not user feedback — treat it as a duplicate and continue without a chat-side acknowledgement. The test is "did *I* just post this body?", not "who is the author?".
- **Keep watching merged PRs for late review comments.** Reviewers and bots routinely comment *after* merge. Stay subscribed after the merge and handle each new comment per the reply-or-resolve rule — reply, resolve, or open a follow-up PR with the fix. Stop once every comment posted on or after the merge commit has been answered or resolved, or after ~24h of silence, whichever comes first.

## Pull requests and reviews

- **"Drive to merge"** is shorthand for the whole loop: open the PR, send it
  for Codex review, address every review comment — fix it if you agree, reply
  on the thread saying why if you don't — and merge once CI is green and Codex
  has left its thumbs up.
- Open PRs ready for review (not draft) unless asked otherwise.
- **Never leave a review comment thread silently dismissed.** Either reply on the thread *or* resolve it — every thread ends in one of those two states, not "left open and ignored". When you think a comment is a false positive, say *why* on the thread (one or two sentences): the reasoning is exactly what the user wants surfaced, and "Deno-only path, doesn't apply" is more useful on the PR than buried in chat history. Acknowledgement noise ("good catch, will do") is fine and preferred over silence; the discipline is "say something or resolve", not "say nothing". This applies to human reviewers too, not just Codex.
- **Wait for a 👍 reaction and no open comments before merging.** Don't merge to `main` (via rebase) until the reviewer has left a top-level thumbs-up reaction on the PR AND there are no open review comments. Don't ask whether it's okay to merge — wait for the signal.
- When a feature has multiple open PRs, list **every** open PR by URL,
  one per line — the "View PR" chip sticks to the first link and hides
  the rest (anthropics/claude-code#46625).

## CI

- After pushing, **wait for CI** before claiming a change works in any environment you can't test locally. Webhooks deliver — don't poll.
- Report significant CI timing regressions (rule of thumb: >25% or >30s on a job under ~5min). Name the likely cause.
