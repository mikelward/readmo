# Readmo — agent reference

Background and reference material moved out of `AGENTS.md` so that file stays
under Antigravity's 24,000-byte rule-file cap (it truncates the tail silently).
`AGENTS.md` holds the rules; this file holds the tables, narratives and
reasoning behind them. When a rule here and in `AGENTS.md` disagree,
`AGENTS.md` wins — fix this file.

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
  (auto-invoked only in Claude Code; other agents run it, or match `.nvmrc`,
  themselves) provisions the `.nvmrc` major before `npm install` — before any native dep
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
  the first PATH directory **under `$HOME`** that
  exists — it creates only `~/.local/bin`, never another tool's missing
  directory such as `~/.nix-profile/bin` — which wins the lookup whatever a
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
  above what the pinned Node major bundles. GitHub's Dependabot **alerts** stay
  on, but its **security updates** are off too (2026-09-11): a grouped
  security update for a transitive `@vitest/mocker` advisory arrived as a
  vitest 4 → 5 major when the patched 4.1.11 sat inside the declared range,
  because grouped security updates resolve to the latest version, not the
  lowest fixed one. An advisory is therefore an alert to act on by hand — bump
  the affected package together with any peer-pinned partner
  (`@vitest/coverage-v8` for vitest) — unless the weekly npm-update batch has
  already carried the fix. Everything in the Renovate bullets below is dormant
  but retained, so re-enabling is deleting one key rather than rebuilding a config that took several rounds to
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


## `resolve_review_thread` history

This was previously documented here as broken: the response stripped the thread node ID, leaving no way to obtain a `threadId`. Tracked upstream as github/github-mcp-server#2331 (issue) and github/github-mcp-server#2245 (fix), and verified working against a real Codex review thread on 2026-07-24. Kept as a note rather than deleted so the next agent that hits a resolve failure knows this was a real, since-fixed upstream bug and doesn't re-derive it.
