# Readmo — Contributor guide

Readmo is a mobile-first RSS/Atom/JSON-feed reader PWA (React + TypeScript +
Vite, Supabase backend). It reuses *newshacker*'s UX as-is; the only intended
differences are the data source (your subscriptions, not Hacker News) and the
plumbing that requires (server-side fetch/parse + accounts + sync). The
normative product spec is [`SPEC.md`](./SPEC.md). These are the load-bearing
guardrails — read them before opening a PR.

Keep this file as short as it can be and still work. Every session loads it
whole, so each rule costs context on every turn: add one the first time
something bites, say it once in the fewest words that carry the *why*, rewrite
or trim an existing rule rather than appending beside it, and delete one that
has stopped biting.

## Guardrails

1. **Always add tests; always run them before reporting done.** Run
   `npm test`, `npm run lint`, and `npm run typecheck` on every change, and
   `npm run build` when you touch build, routing, or deploy config.
   CI mirrors this on every diff that can change behavior; housekeeping-only
   changes (root-level markdown and the `docs/` tree — markdown anywhere else
   is code, since it can sit beside what CI validates) ride the docs lane
   instead, on a pull request and on a push to `main` alike, and Vercel skips
   the deployment for one too (`vercel.json`'s `ignoreCommand`, see *Deploying*
   below). The required `lanes` check independently re-verifies any skip (the
   shared mikelward/lanes action; the policy is `.github/lanes.conf`). Fix a red
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

12. **Look at how the repo already does it.** Before adding a client-side store
    of server state or a second place holding the same fact, read
    `lib/settingsSync` and the item-state store + outbox. Both are local-first
    with an async reconcile on top; both are fine. What neither has is a
    **redundant fallback authority** — a second copy of the same server-read
    fact, holding no writes of its own, that something then has to choose
    between. The open-mode snapshot (#700) shipped as one and cost an ordering
    predicate, a clock-correction exception, a stamp floor and a tie-break
    across nine review rounds.

13. **Ask before adding wordy in-product copy.** Settings options, controls,
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
| **Google Gemini** (`gemini-2.5-flash-lite`) | Two uses, same model + `GOOGLE_API_KEY` secret. (1) The short **AI article summary** (one or two sentences) shown at the top of the reader for an allowlisted user — generated automatically only for an article **pinned before opening** (a pin by an **allowlisted** user triggers the work server-side — the 0053/0054 DB trigger, which downloads the full article and summarizes concurrently — and pre-warms the device cache), else on demand via a **"Generate summary"** button (the `summary` Edge Function). Summarizes text fetched via **Jina** (markdown), falling back to the stored sanitized body. (2) The **spoiler-free sports headline** — for feeds with an allowlisted subscriber, the **poller** classifies each new headline and, when it spoils a result, caches a spoiler-free rewrite ("EPL MNU v ARS spoiler") on `items.spoiler_free_title`; input is the headline + the **already-stored RSS body only** (no Jina/fetch). Both skip silently when the key is unset. | Flash-Lite ≈ $0.10 / 1M input tokens, $0.40 / 1M output. **Summary:** a few-K-token input + short output, generated **once per article** (shared cache), only for pinned or explicitly-requested articles, bounded by *distinct pinned/requested articles* across the family set — **effectively $0**. **Spoiler title:** one call per **new item in an allowlisted-subscriber feed** — smaller (headline + short body) input, no Jina — cached forever, regenerated only on title/body change; bounded by *new items in family feeds* — also **effectively $0**. (Empty allowlist → the poller and the pin trigger generate for no one, the cost guard against an unseeded deploy.) | Standard Google AI Studio quotas (generous; far above family volume — only cache misses call out). | Summary: one Jina + one Gemini call (~2–7 s) on the first open. Spoiler title: one Gemini call per new item at poll time (off the user's path entirely). Cache-instant thereafter. | Summary: Gemini down/timeout → `unreachable` (retryable), a "Could not summarize" card with Retry; key unset → `unavailable`, no card. Spoiler title: any failure → the item keeps its original headline and is retried next poll; key unset → pass skipped. All soft — articles, reading mode, and polling are unaffected. |
| **SMTP relay** (provider-agnostic, e.g. Fastmail / Gmail / SES) | Sends the operator a "new user signed up" email from the `notify-signup` Edge Function, triggered by the `auth.users` insert trigger. Configured via `SMTP_*` Supabase secrets; trigger no-ops if unset. | **Negligible** — one email per new account; every mainstream relay's free tier covers signup volume many times over. | Provider-dependent (e.g. Gmail ~500/day); far above signup rate. | Off the critical path: `pg_net` posts fire-and-forget *after* the signup commits, so SMTP latency never delays or blocks account creation. | Relay down/rejecting → function returns 502; secrets unset → no-op/500. Only the *alert* is lost; the account is still created. |
| **Supabase Auth email** (GoTrue sender — built-in or custom SMTP) | Delivers the **passwordless magic-link sign-in** email when a user submits their address on the sign-in page (`signInWithOtp`). Sent by GoTrue itself, configured under Authentication → Emails — separate from the `SMTP_*` secrets above. Built-in sender is test-only; production points Auth at a real SMTP relay (SETUP.md §4). | **Negligible** — one email per email-sign-in attempt; any mainstream relay's free tier covers sign-in volume many times over. Built-in sender is $0 but capped at a few emails/hour (not for production). | Built-in: a few/hour (hard, silent). Custom relay: provider-dependent (e.g. SES generous), far above sign-in rate. | One email round-trip (seconds) before the link arrives; off every in-app path (the user completes sign-in from their inbox). | Sender down / rate-limited → link never arrives; `signInWithOtp` may still return success (queued server-side), so the client can't always detect it. **Email sign-in degrades; OAuth (Google/Discord) is unaffected.** Provider unset → built-in sender used (test-only cap). |
| **Supabase Metrics API** (`/customer/v1/privileged/metrics`) | Out-of-band database performance monitoring: a Prometheus endpoint of ~200 Postgres/host health series, scraped externally so detection adds no load to the DB and survives a DB outage. Basic-auth as `service_role`. See `OBSERVABILITY.md` / SETUP.md §12. | **$0** — included on all hosted Supabase projects (incl. free tier). | One scrape/min (the set refreshes ~1×/min). | Not on any user path — external scrape, computed by Supabase, **zero load on our Postgres**. | **Beta** (metric names/labels may change) and **hosted-Supabase only** (self-hosted needs `postgres_exporter`). A scrape failure *is* the "DB unreachable" signal. |
| **Grafana Cloud** (or any Prometheus collector) | Scrapes the Metrics API, evaluates the DB-performance alert rules, and pages (dedup / `for:` hysteresis / re-notify / silences). The paging layer that turns saturation into one incident instead of an email a minute. | Free tier covers a one-operator project; paid only if series/retention outgrow it. | Free-tier ingestion/series caps (generous at this scale). | Separate system from our DB — adds no user-facing latency. | A separate system, so it keeps paging during a Supabase incident (the point of out-of-band detection). If Grafana itself is down, detection lapses until it recovers; the DB is unaffected. |

## Deploying & client/server compatibility

Readmo ships as two halves that deploy on **different clocks**:

- **Frontend (the client)** — React/Vite on Vercel. **Auto-deploys** on every
  push/merge to `main` via Vercel's GitHub integration; no manual step. (Lone
  exception: after changing a Vercel env var you must redeploy — existing
  deployments keep their original env snapshot.) A **docs-only** commit is the
  one thing that does not deploy: `vercel.json`'s `ignoreCommand` runs
  `scripts/vercel-ignore.mjs`, which reads the same `.github/lanes.conf` the
  docs lane reads and cancels the build when every changed path is
  documentation. It measures from the last successful deployment of this
  project and branch, so production skips from the first docs-only merge
  onward, while a branch builds its first preview and skips the docs-only
  pushes after it — a first deployment has no earlier one to measure against.
  It fails open — no previous deployment to measure from, a SHA outside
  Vercel's shallow clone, anything unrecognized, and it builds, saying in the
  build log which of those it was and what the underlying failure said.
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
| `src/`, `index.html`, frontend build/routing config | push/merge to `main` (Vercel) | No — auto (docs-only commits are skipped) |
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
- **Don't disable a failing check** (a test, ESLint, `tsc`, the coverage
  floor, a CI job) to make it pass — fix the underlying issue. Lowering the
  80% floor in guardrail 1 to land a change is the same move under a different
  name.
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
- **Respond to a mid-turn message immediately.** When the user sends a message while you're
  still working — surfaced as a "sent while you were working" interjection — address it in
  your very next output, before starting or continuing any further tool call, even if it's
  only one sentence. Don't let it queue up behind an in-flight chain of tool calls.
- **Don't narrate routine machinery.** A check run flipping, a re-run, a scheduled check
  re-arming, a webhook echo, a resolved thread — act on those silently; the noise buries
  the one line that matters. Reports another rule requires stand (the Codex SHA and
  comment count, a CI timing regression).
- **Don't report your own caught-and-fixed mistakes.** A wrong turn you noticed
  and corrected before it reached anything is not news — no "one thing worth
  flagging", no narration of the recovery. Say it only when it left something
  the user has to act on: work actually lost, a bad push someone may have
  pulled, a decision they would make differently knowing it.
- **Keep replies short — don't dump a full page.** Lead with the single most
  important point and stop. If there's more, say the first point and ask
  whether they're ready for the next one rather than emptying everything at
  once.
- **End the turn by restating any pending decision.** If you're waiting on an
  answer — a question you asked, or a guess autopilot recorded for review — the
  last line of the reply is that question, written out in about a sentence. A
  back-reference ("as asked above") isn't actionable when the question is pages
  back or was never actually put into words; restate it every turn until it's
  answered. Nothing pending, no line. It is the *last* line: where *Branching*
  also ends the reply with the open-PR link, that link goes just above it. This
  governs replies the user reads: a scheduled check that finds nothing new
  re-arms silently and produces no reply at all, so there is nothing to restate.

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
- **Provisioning the runtime and making it REACH the session are two
  problems, and the second one failed silently for a while.** The hook
  exports PATH and writes it to `$CLAUDE_ENV_FILE` — but that variable is not
  always set (it is unset in the web sandbox today), and then the export
  reaches only the hook and its children: `/opt/node24` sat there correctly
  provisioned while every agent shell ran the image's Node 22, on an npm too
  old to honor `.npmrc`'s cooldown. A shell rc file is not the fallback — the
  harness snapshots the environment before hooks run, so an rc edit lands a
  session late while looking like it worked. So the fallback changes what the
  NAME resolves to instead: symlinks for `node`/`npm`/`npx` (and `deno`) in
  the first PATH directory **under `$HOME`**, which wins the lookup whatever a
  later shell sources. Three refusals keep that from being a lie: it links
  nothing if any tool is missing from the source, nothing if any *earlier*
  PATH entry still supplies one of the names (node and npm need not come from
  the same directory, so the question is asked per tool), and nothing over a
  real file — all decided before the first link, because a half-linked
  toolchain is a split one, worse than the fallback it replaces. It does
  **not** stop at whichever directory currently answers: from the second
  session on that is this shim directory itself, and refusing to touch its own
  links would strand every later `.nvmrc` major on the old runtime.
- **The hook is identical in all three repos, and so is its test.**
  `scripts/session-start-hook.test.ts` runs the real hook end to end against a
  temp install root and a `file://` release fixture, via the `SESSION_NODE_ROOT`
  and `SESSION_NODE_DIST_URL` seams — no network, no stubbed internals. Its
  failure mode is a *false pass*, so behavior is asserted, not structure. When
  you change the hook, change it everywhere and keep the Node block byte-identical.
- **A `@types/node` major is a runtime migration, not a dependency update.** A
  packageRule disables that major so it stops arriving as an unmergeable
  weekly PR. When you do move the runtime, move all three pins in one commit.
- **Renovate does not bump the Node runtime either, and can't be made to.**
  `.nvmrc` holds the bare major on purpose — every consumer resolves the newest
  release of it on its own — but Renovate's nvm manager can only write a *full*
  version, so `Update Node.js to v24.18.1` rewrote `.nvmrc` to `24.18.1` and
  `nodeVersion.test.ts` failed it, in all three repos, every time a Node patch
  shipped. There was never a mergeable version of that PR: the upgrade it
  offers already happens at runtime without a commit. Patches and minors are
  off; a **major** is held behind `dependencyDashboardApproval`, so a new LTS
  still shows up on the dashboard without opening a PR nobody can merge.
  Checking that box means "I am doing the migration now" — expect to restore
  the bare major in `.nvmrc` by hand in that branch.
- **Assert the `@types/node` version npm *resolved*, not the range declared.**
  `vite`, `vitest` and `msw` all depend on it with ranges permissive enough to
  resolve any newer major, so a declared-range check stays green while `tsc`
  loads something else entirely. newshacker had no direct dependency at all and
  was type-checking `vite.config.ts` against Node 26 types on a Node 24
  runtime; `nodeVersion.test.ts` here reads the lockfile for that reason.
- Currently Node **24** (the active LTS; 22 dropped to maintenance when 26
  shipped).

## Dependency updates

- **The weekly batch itself now lives in mikelward/npm-update.** `.github/workflows/npm-update.yml` here is a thin caller (`uses: mikelward/npm-update/.github/workflows/npm-update.yml@main`, plus the schedule, the permissions grant, and the `regenerate`/`regenerated-files` inputs that keep `supabase/functions/import_map.json` in sync via `npm run import-map:sync` — see that repo's README.md "Regenerating a derived file") — see that repo's README.md for the wiring contract and its own AGENTS.md/`check-npm-update.mjs` for the mechanism (fingerprinting, the consumer-declared lockfile-major-crossing walk, the two-job read-only/write-token split, the ci.yml dispatch). A fix to the mechanism now lands in mikelward/npm-update, not here — this file no longer duplicates that narrative, to avoid the drift a hand-synced copy would cause. `scripts/sync-import-map.mjs` and its test stay local — they are the regenerate command itself, not the batch mechanism.
- **Cost and failure mode of that dependency:** zero dollars — it's another GitHub Actions job in the same free-tier budget as the old local copy, just hosted at `mikelward/npm-update` instead of here. If that repository ever goes private, is deleted, or the `@main` ref stops resolving, the scheduled run fails at the `uses:` step with no PR opened and no other symptom — the Actions run log for `npm update` is the only place that shows up, since a failed scheduled workflow doesn't otherwise notify anyone.
- **Renovate is off.** `"enabled": false` at the top of `renovate.json` is the
  master switch: the job still runs, logs `Repository is disabled`, and creates
  nothing — no PRs, no `renovate/*` branches, no dependency dashboard, and no
  vulnerability-alert PRs either, since a disabled repo is skipped before alerts
  are considered. It was switched off after the config kept producing PRs that
  were unmergeable or actively harmful: Node patches that could never go green,
  and — once `constraints.npm` was added — an auto-merge-eligible npm floor
  above what the pinned Node major bundles. GitHub's own Dependabot **security**
  updates are a separate switch in repo settings and still run, so advisories
  stay covered. Everything in the Renovate bullets below is dormant but
  retained, so re-enabling is deleting one key rather than rebuilding a config that took several rounds to
  get right; `renovate.test.ts` asserts the switch, so an accidental re-enable
  fails CI. Uninstalling the Mend app at developer.mend.io is the other half, if
  you want the jobs to stop running at all.
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
- **`minimumReleaseAge` is a lookup-time filter, so `.npmrc` carries the other
  half.** Renovate applies its cooldown when it *looks up* a version, which
  means it only ever governed the direct dependency a PR names. Lock file
  maintenance never does a lookup — it deletes the lockfile and lets npm
  rebuild it, taking whatever is newest — and those PRs auto-merge, so the
  highest-volume path to production was the one path with no cooldown on it.
  Transitive dependencies escaped the same way inside ordinary bumps: Renovate
  picks the direct version, npm resolves everything underneath. `.npmrc` sets
  npm's own `min-release-age` (5 days, matching the shortest Renovate cooldown;
  `renovate.test.ts` asserts they stay in step), which npm enforces while
  resolving and therefore covers both. It only affects resolution — `npm ci`
  installs from the lockfile, so CI and Vercel builds are untouched.
- **The npm that resolves is the one that has to support the window, and for
  lock file maintenance that npm is Renovate's.** `min-release-age` landed in
  **npm 11.10.0** and is silently ignored before it ("Unknown project config"),
  so the floor is declared rather than inferred from the Node major — Node
  bundles vary within one: 24.12.0 ships npm 11.6.2 (no), 24.14.1 ships 11.11.0
  (yes). `engines.npm` covers local installs and Vercel; `constraints.npm` in
  renovate.json covers the lockfile regeneration that the window exists to
  protect. Both are asserted, because an unsupported npm doesn't fail — it just
  quietly resolves without the window. If the window ever blocks an
  `npm audit fix`, npm keeps the vulnerable version and exits non-zero rather
  than failing quietly — `min-release-age-exclude` is the escape hatch for
  taking that fix immediately.
- **The npm floor is not a dependency, and Renovate must not treat it as one.**
  Adding `constraints.npm` made Renovate start managing it: within minutes it
  opened `>=11.18.0` (a minor, so auto-merge eligible) and `v12` in all three
  repos. Both sit above the npm Node 24 actually bundles — 24.18.1 ships
  11.16.0 — so either would EBADENGINE every contributor, CI runner and Vercel
  build, and the lower-bound assertion in renovate.test did **not** catch it,
  because a floor that is too high still clears a `>=` check. `npm` is now
  disabled in packageRules, and the guard pins the floor to exactly the release
  that introduced the option rather than asserting a minimum. Raise it by hand
  only if a later npm becomes genuinely required, and check what the pinned
  Node major bundles first.
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
  `mcp__github__create_pull_request` (this file is the standing ask — see
  *Autonomy*, so don't wait for a per-thread one), `git push --force-with-lease` to your own live feature branch
  after a rebase (this is normal hygiene, not a risky action), and the
  Codex-review round-trip on your own PRs:
  `mcp__github__add_reply_to_pull_request_comment` and
  `mcp__github__resolve_review_thread` (see *Codex reviews* below for where
  the `threadId` comes from).
- Ask first before: force-pushing to `main`/`master` or to a merged branch
  (resetting a merged branch name included — see *Branching*),
  rewriting history on shared branches, deleting branches you didn't create,
  changing Vercel/Supabase project settings, changing CI secrets, adding
  paid/third-party services.

## Commit messages

- Write a clear, plain-English subject in sentence case; keep it short
  (≤ ~70 chars, prefix included) and free of internal jargon.
- Put the mechanism, the bug fixed, and file:line detail in the body, after a
  blank line — the body is not size-constrained. A commit with nothing to
  explain needs no body: the weekly dependency batch is the standing example,
  where the diff is the manifests and the PR carries the check results.
- **Prefix a subject that does not change what the app does.** A bare subject
  means a user could notice the difference. Anything else takes one of these,
  lowercase, followed by the sentence-case subject as above:

  | Prefix | For |
  |---|---|
  | `docs:` | Prose: `SPEC.md`, `SETUP.md`, `OBSERVABILITY.md`, this file, the rest |
  | `todo:` | `TODO.md` bookkeeping on its own |
  | `test:` | Tests only, with the code under test unchanged |
  | `build:` | Toolchain, CI, lint/build config, `scripts/` |
  | `refactor:` | Code that is deliberately behavior-preserving |

- **No `feat:` or `fix:`, on purpose** — they would prefix nearly everything
  left and leave the log as flat as it is now. The prefix marks the exception,
  so the default stays bare.
- **No `deps:` either — a dependency bump changes what the app runs, so it's
  bare like any other release-worthy change.**
  `.github/workflows/npm-update.yml` used to write a `deps:` prefix on the
  weekly batch specifically, which is how 23 of the last 50 commits ended up
  reading `deps: Update dependencies (<date>)` with nothing to say whether
  the app actually changed. That prefix is gone now: a bump taken *because*
  of the behavior it changes still says what changed; the routine weekly
  bump has nothing extra to say, but it's bare too.
- **`TODO.md` and `SPEC.md` ride along and never decide the prefix.** Guardrail
  4 requires SPEC to move in the *same commit* as the behavior it documents, so
  a SPEC edit is almost always riding on a bare commit; either counts only when
  it is the whole change. A SPEC-only commit recording or reversing a decision
  is `docs:`.
- **A mixed commit goes bare if any part of it changes behavior** — a change
  spanning `src/` and `supabase/` is one behavior change, not two categories.
  Below that line the prefix names why the commit exists, not what it touched:
  a toolchain pin that also edits the guides describing it is `build:`, because
  the prose moved to follow the toolchain. So there is no precedence order to
  memorize. Two genuinely independent categories are two commits.

## Branching

- **Branch naming.** Feature branches are prefixed with the agent's own short name: `<agent>/<short-topic>` (e.g. `claude/...` for Claude Code). Human contributors pick a name that identifies them.
- **Workflow.** `<agent>/<short-topic>` branch off `origin/main` → PR → rebase-merge. One topic per branch. Follow-up work after a merge goes on a new branch. Never commit to `main` / `master`. Squash merging is disabled on every repository in this fleet, so each commit's own subject is what lands — the PR title never becomes one.
- **Give the PR title the same prefix a commit subject would carry** (see *Commit messages*), judged over the whole branch rather than any one commit, and re-judged on every push — a branch can start documentation-only and stop being so with the next commit. This is a convention for reading, not a gate: the title is what the PR list shows the repo owner, so the prefix says at a glance whether a PR changes what the app does. Only commit subjects are enforced (`lint-title no` in `.github/lanes.conf`), because squash merging is disabled and a title therefore never becomes a commit subject.
- **No-remote sandbox exception.** Sandboxes without remote Git support (such as Codex cloud) may continue from the checked-out HEAD without fetching `origin` — but still on this task's own topic branch: unless the checked-out branch is already it, cut a local `<agent>/<short-topic>` first — and cut it from a base free of earlier work (local `main` where it carries none, otherwise ask for a synced checkout), since branching off a stale topic tip only renames that topic's commits into your PR. Committing onto `main` or onto a stale topic branch from earlier work both mix unrelated topics into one PR once remote access returns; only fetch, push and the PR are unavailable, not the branching rules — a missing remote or unsupported fetch must not block otherwise-local work. Do not make claims that depend on unseen remote state.
- **Use `git worktree` when it's available.** Give each branch its own worktree instead of switching branches in place, so work in progress on one branch isn't disturbed by work on another.
- **One commit per logical surviving change on the branch.** Rewrite unmerged commits freely (squash, amend, reorder, split with `git rebase -i` / `git reset --soft`) so each landing commit is one coherent change, with fix-ups and review responses folded into the commit they belong to. A PR can be a single commit or a short series — but review-fix noise doesn't survive into `main`.
- **Check state before you push or branch.** Query the branch's PR via the GitHub MCP first.
  - No PR yet, or PR open → `git push` (`--force-with-lease` to your own feature branch after a rebase is fine; don't ask).
  - PR merged / closed → don't push. Merge-path hygiene: `git fetch origin main`, cut a fresh `<agent>/<short-topic>` branch off `origin/main`, announce the switch. Where the sandbox has no remote, the cue can't be honored as written — a fresh branch needs a base that contains the merge, and an offline checkout can't fetch one; say so and ask for a synced checkout rather than branching off a stale `main`. Where a sandbox pins the branch name and it has been reset onto `origin/main` per the post-merge rule below, that reset clears its association with the merged PR: the check applies to the new work on it, so push rather than reading the old PR as a block — with `--force-with-lease`, since the reset leaves the branch diverged from its pre-merge remote tip and a plain push is rejected as non-fast-forward.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene *before* engaging with the rest of the message.**
- **After a merge, take a fresh `<agent>/<short-topic>`** — don't reset the merged name onto the new base. Its remote ref still points at the pre-merge tip, so `origin/<branch>..HEAD` keeps spanning the merged commits and unpushed-work checks report your own merged history back at you. When a sandbox pins the branch name so a fresh one isn't available, say so and ask before resetting it. No short check reliably separates "already merged" from "not yet merged" here: a rebase merge rewrites the commits, a squash merge collapses them, `main` moves on underneath so a tip-to-tip diff reports upstream drift as branch work, the remote ref can hold a commit the local one doesn't, and no tree comparison sees the uncommitted work a `--hard` reset would erase. Confirming costs one question in a rare situation; guessing costs someone their work. Don't reach for `--force-with-lease` as the safety net either — fetching updates the remote-tracking ref the lease compares against, so a commit you have already fetched passes the lease unnoticed.
- **Branches under your own `<agent>/` prefix are yours.** Create, push,
  `--force-with-lease` and rename them freely — no permission, no announcement,
  no per-branch confirmation. Only a branch outside that prefix, or `main`
  itself, is a conversation. Deleting is the one the prefix can't settle: it
  doesn't say which session made the branch, so delete the ones this session
  created and ask about the rest.
- **The agent authors; whoever merges takes over the committer line.** A squash or rebase merge rewrites the committer to the person who pressed the button — the repo owner normally, the agent itself when it merges under *drive* (see *Autonomy*). That's expected either way — never re-author or amend already-merged commits to "fix" authorship or signing, and don't narrate it: no note in the reply, no offer to correct it. It is not a finding.
- Creating new `<agent>/<short-topic>` branches and creating PRs via `mcp__github__create_pull_request` are safe — this file is the standing ask (see *Autonomy*), so don't wait for a per-thread one and don't re-ask.
- Sandbox git proxy can't delete branches (HTTP 403). Flag it and move on; auto-delete-on-merge handles GitHub's side.
- **After every push and after every merge, report the resulting HEAD SHA** so the operator can verify which build is deployed. Format: `pushed <short-sha>` after a push — your branch tip on `origin/<branch>`; `merged at <short-sha>` after a merge — the commit the merge produced on `main`, which is *not* your local `HEAD`: a rebase merge leaves the feature branch pointing at the source commit, so take the SHA the merge API returned, or the merge commit the PR itself records — not the `origin/main` tip, which another push can have moved past it by the time you look. 7-char prefix is fine. Mention it once per push.
- **Update the PR title and body with the push, not after it, and print the PR link.** Pushing to a branch that has an open PR and editing the PR title and description are one step, not two: (`mcp__github__update_pull_request`) so they still match what's on the branch — new commits, reversed decisions, changed scope — and print the PR link in the chat reply for that push, not only at the end of the conversation. If no PR exists yet, do this as soon as one is opened.
- **Unshallow before answering anything that depends on git history depth.** Claude Code sessions get this automatically — `scripts/unshallow.sh` runs from the session-start hook — but the hook is Claude-only, so in any other environment run that script (or `git fetch --unshallow`) yourself first, same rule `vite.config.ts` already follows for the `build` field shown in `/debug`. The sandbox clones shallow, so `git rev-list --count`, `git log` past the shallow boundary, and blame return wrong answers without warning; where no remote is reachable (Codex cloud), say the history is truncated rather than quoting a count.
- End every reply with the open-PR link (or `.../compare/main...<branch>` until a PR exists). Never link to a closed or merged PR. In a no-remote sandbox there is no link to give: say the branch is local and unpushed rather than inventing a URL. When a pending decision also needs restating (see *Talking to the user*), the link goes second-to-last and the question is the final line.

## Autonomy

- **Open the PR without being asked.** Pushing a finished branch and opening
  its pull request are one step, not two — don't park a branch waiting for
  "please open a PR." The exception is an explicit instruction not to ("just
  commit", "no PR yet"), which holds until the user lifts it. This file is the
  repo owner's standing request for that PR, so a client-level rule reading
  "open a PR only when the user explicitly asks" is already satisfied — the ask
  is here, and it doesn't need repeating per branch.
- **Watch your own PRs by subscription, plus one scheduled check.** Have a
  subscription — Claude Code makes one when you open a PR; where a client
  doesn't, call `subscribe_pr_activity`. It delivers reviews, comments and CI
  failures. It cannot deliver CI *success*, a push, the merge, Codex's clean
  verdict (a reaction), or Codex never answering at all — so keep exactly one
  check armed for as long as the PR is open (each event and each check costs
  a model turn). Under drive, arm auto-merge at PR open too — but only where
  the ruleset makes the Codex verdict a required check AND requires
  conversations resolved: where CI is the only requirement it merges before
  Codex has answered, and an open review comment holds nothing back on its own.
  - Settle the fired trigger first thing in the turn, not last. It may have
    silently re-armed rather than retired — update the one that survived,
    replace the one that didn't, and end the turn with exactly one pending.
  - Check the fire time you got against the one you asked for — a 4-minute
    request has come back as 64. Prefer a relative delay: the scheduler's
    clock is not this container's, so an absolute time computed here can be
    rejected as already past. Re-time it, or say the watch isn't armed.
  - A few minutes out while CI or the current head's Codex verdict is
    outstanding; longer once only a human is left; short again after a push.
  - A PR reading `dirty` — always — or `behind` where the ruleset requires
    branches up to date, needs a rebase onto its base and a lease-guarded
    force-push. Nothing reports a base advance, so only this check catches
    it. Fetch both refs by explicit refspec, unshallow a shallow clone, and
    rebase onto the fetched `origin/<base>` — not always `main`, never the
    local branch a fetch leaves behind. Confirm before you rebase that your
    branch has every commit the remote head has, and before you push that
    the head has not moved since the tip you noted before fetching: the push
    flags do not reliably refuse a rewind, a commit you never fetched, or
    one you fetched and did not rebase onto, and overwriting any of them
    loses someone's work. If either fails, or you can't tell, stop and ask.
  - Name the PR, and say what to re-read rather than what you read. A SHA or
    a list of which PRs are open goes stale before it fires; one PR number
    does not, and the trigger has to be matchable to it.
  - Merged or closed, take one last reply-and-resolve pass — a review can
    land after the merge. Nothing is holding the PR now, so on a merged one
    anything real goes to a follow-up PR, named on the thread, before you
    resolve it; leaving it open records the work nowhere. A closed-unmerged
    PR is a stop — the work was abandoned, so answer, resolve, and open
    nothing. Then cancel the check and unsubscribe. `list_triggers`
    spans the account, so match this session and this PR before updating
    or deleting one; an update reschedules whatever it matches as surely
    as a delete cancels it.
- **If a scheduler or GitHub call prompts, say so once and carry on.**
  Permissions load at session start, so writing a settings file mid-session
  can't fix the session you're in.
- **"Drive" means run the loop automatically**: pick the next task,
  implement it, open the PR, wait for the automatic Codex review, address
  every comment, merge once CI is green and Codex's verdict for the current
  head is in — then pick the next actionable `TODO.md` item and go around
  again. Actionable means ready to build: skip anything explicitly deferred
  or waiting on a product decision rather than guessing the decision.
  Driving ends when the work runs out or the user says stop, not when one PR
  merges.
- **A red baseline is the next task.** Before pulling anything from `TODO.md`,
  run `npm test`, `npm run lint`, and `npm run typecheck` and get them green. A
  preexisting failure is work to do, not a thing to classify as "unrelated" and
  step around — deciding it's out of scope is exactly the call that goes wrong,
  and the cost is every later PR merged onto an unverified tree. Fix it first
  (as its own first commit, per *Testing expectations*), then pick the task. That
  section's "genuinely unrelated, out of scope" escape hatch is the only way past
  a red tree, and it needs a real answer from the user — not a call you make on
  your own, and not one autopilot guesses.
- **"Autopilot" is drive without blocking on the user.** Wherever drive would
  stop and ask, autopilot takes its best guess and keeps going, preferring the
  option that is cheapest to undo or change later. Record each guess in
  `TODO.md` under a `Decisions needing review` heading — what was decided,
  what the alternative was, and why it's reversible — creating the heading if
  it isn't there, so nothing guessed silently becomes permanent. While
  autopilot is in effect it outranks *Asking questions*' "after asking, stop
  and wait for the answer"; that rule governs everywhere else. The carve-out
  is for destructive or irreversible actions *outside* the loop — rewriting
  shared history, deleting work, anything reaching a system beyond this repo
  (a Supabase migration or function deploy included) — which still wait for a
  real answer. Resetting a pinned merged branch waits too, even though it is
  inside the loop: the post-merge rule asks precisely because no check can
  tell what the reset would destroy, and autopilot guessing there is the loss
  that rule exists to prevent. *Safe vs. risky actions*' ask-first list holds
  under autopilot too: adding a paid or third-party service, or changing CI
  secrets or Vercel/Supabase settings, is an ask however reversible it looks
  from inside the repo — as is guardrail 13's in-product copy, which waits for
  an explicit yes. The loop's own steps don't count: committing, pushing,
  opening a PR, reading its CI and review state, arming the
  next scheduled check, and merging a green PR are authorized here, so
  autopilot must not stall on them — the carve-out is aimed at destructive
  writes to systems outside the repo, not at the loop's own GitHub reads and
  follow-ups. Privacy uncertainty is never inside the loop either: if you
  can't tell whether something is user data — an email address, an
  `auth.uid()`, a key, a `secret_url` — it waits for a real answer, since a
  push can't be un-published and a `TODO.md` note doesn't retract it.

## Codex reviews

**Codex is the automated reviewer on this repo** — not Copilot. Its reviews
are triggered automatically; you don't request them, except when nothing has
come back five minutes after a push — that means it never picked the push
up.

- **Address Codex comments automatically — don't wait to be asked.** When a Codex review lands, treat each comment like a real review note: read it, decide whether it's a real issue or a false positive, and if it's real, fix it in the same PR. Fold the fix into the commit it belongs to (rebase / `--fixup`) rather than tacking on an "address review" commit, per the *one commit per logical surviving change* rule. Group several small fixes into one commit when they share a topic.
- **Reply to (and resolve) every addressed Codex comment** via `mcp__github__add_reply_to_pull_request_comment`, then `mcp__github__resolve_review_thread`. Do this for each addressed comment, not in bulk.
- **Order of operations on a push that addresses review comments:** (1) push the fix commit, (2) reply on each addressed thread referencing the new sha, then resolve it. Doing (2) before (1) means the sha you cite doesn't exist yet.
- **`resolve_review_thread` works — the old MCP limitation is fixed.** `mcp__github__pull_request_read` / `get_review_comments` now returns each thread's node ID (`PRRT_*`) on the `review_threads[].id` field, alongside `is_resolved` / `is_outdated` / `is_collapsed`. Pass that `PRRT_*` value straight to `mcp__github__resolve_review_thread` as `threadId`. Do NOT pass a comment's node ID (`PRRC_*`) — that fails with `Could not resolve to PullRequestReviewThread node`; the thread ID and the comment ID are different objects. So the full round-trip is available, with no "replied-but-unresolved, please resolve in the UI" caveat in the end-of-turn summary.

  > **History.** This was previously documented here as broken: the response stripped the thread node ID, leaving no way to obtain a `threadId`. Tracked upstream as github/github-mcp-server#2331 (issue) and github/github-mcp-server#2245 (fix), and verified working against a real Codex review thread on 2026-07-24. Kept as a note rather than deleted so the next agent that hits a resolve failure knows this was a real, since-fixed upstream bug and doesn't re-derive it.

- **Report when Codex finishes reviewing a fresh push.** Codex's review runs asynchronously after each push; once its review event lands for the latest commit, surface a one-liner naming the SHA and comment count — e.g. `Codex reviewed 87d9f02 — 0 comments` or `Codex reviewed 87d9f02 — 3 comments, addressing now`. Tie it to the *latest* pushed SHA so a stale review of a superseded commit isn't conflated with the current state.
- **Read the Codex verdict, don't infer it.** It reacts to the PR body
  (`issue_read` → `reactions`), not to a review thread, whose `Useful?` bar
  reads true on any PR it has commented on. `eyes` means reading, `+1` means
  clean, and Codex revokes it on push — so a visible one belongs to the
  visible head, and `+1` with green CI is a merge. The count names no
  author, so leave PR-body reactions to Codex: nobody else's is revoked, and
  a review naming that commit with no findings is the same verdict, in the
  attributable form. Findings arrive as review comments, as a top-level
  comment, or as a review — read `get_review_comments`, `get_comments` and
  `get_reviews` to the last page, since all three page oldest first — and
  they block the merge until fixed or rebutted; an acknowledgement is not an
  answer. Nothing from Codex since the push, five minutes on, means it never
  picked it up — comment `@codex review`, once.
- **Skip echo events silently.** `mcp__github__add_reply_to_pull_request_comment` / `add_issue_comment` post under whichever GitHub identity backs the MCP auth (typically the repo owner's), so a moment after you post a reply the same body comes back as a webhook event authored by that identity. That's the echo of your own reply, not user feedback — treat it as a duplicate and continue without a chat-side acknowledgement. The test is "did *I* just post this body?", not "who is the author?".
## Pull requests and reviews

- **"Drive to merge"** is the PR stretch of *drive* (see *Autonomy* above):
  open the PR, wait for the automatic Codex review, address every review
  comment — fix it if you agree, reply on the thread saying why if you don't
  — and merge once CI is green and Codex's verdict for the current head is
  in.
- Open PRs ready for review (not draft) unless asked otherwise.
- **Judge every review comment on merit, whoever wrote it.** Verify the claim before acting; if it doesn't hold up, reply saying why and decline. A comment citing a rule is a *reading* of that rule, not the rule — check what the rule actually says. Codex misreads the privacy rules especially, and in one direction: stricter always feels safer, so an over-strict finding quietly costs capability the product needs. Quote the rule and decline rather than narrowing the code to satisfy it; where the rule really does forbid what the product needs, that conflict is the maintainer's call, not one to settle either way yourself.
- **A second verified finding in the same mechanism is evidence about the design, not another bug.** Before fixing it, look for the same shape elsewhere and ask whether a different design — an existing one (guardrail 12) or a better new one — would delete the class rather than the instance. Say what you chose on the thread; a design change is the maintainer's call, autopilot included.
- **Never leave a review comment thread silently dismissed.** Answer on the thread — a disagreement is an answer, so say why — then resolve it once the fix is on the head or the point is rebutted; anything still to do stays open — every thread ends in one of those two states, not "left open and ignored". When you think a comment is a false positive, say *why* on the thread (one or two sentences): the reasoning is exactly what the user wants surfaced, and "Deno-only path, doesn't apply" is more useful on the PR than buried in chat history. Acknowledgement noise ("good catch, will do") is fine and preferred over silence; the discipline is "answer, then resolve", not "say nothing". This applies to human reviewers too, not just Codex.
- **Don't merge ahead of that verdict**, and don't ask whether it's okay to
  merge — the gate is the rule above, in one place: Codex's verdict for the
  head you are merging, green CI, nothing left open.
- When a feature has multiple open PRs, list **every** open PR by URL,
  one per line — the "View PR" chip sticks to the first link and hides
  the rest (anthropics/claude-code#46625).

## CI

- After pushing, **wait for CI** before claiming a change works in any environment you can't test locally. Don't busy-poll inside the turn — a failure arrives on the subscription, and success is what the scheduled check is for.
- Report significant CI timing regressions (rule of thumb: >25% or >30s on a job under ~5min). Name the likely cause.
