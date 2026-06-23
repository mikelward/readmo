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
   server handlers.

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
   Keep secret/tokenized feed URLs (`secret_url`) server-only.

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
  styles/        global.css with the --rm-* design tokens
  types/         ambient/build type declarations
public/          PWA icons + manifest assets (generated; see below)
scripts/         dev one-shots (generate-icons.mjs)
supabase/        Postgres migrations + Edge Functions (poller, discover,
                 SSRF helper, feed parser, sanitizer) and their fixtures
```

The data layer is abstracted behind **`src/lib/data/DataSource.ts`**.
`MockDataSource` backs it today; a `SupabaseDataSource` replaces it later
without touching callers — build features against the interface, not a concrete
source.

## External services

Per guardrail #5, cost and reliability are documented here for every
third-party call the app makes.

| Service | Purpose | Cost | Rate limits | Latency | Failure mode |
|---|---|---|---|---|---|
| **Jina Reader** (`r.jina.ai`) | Fallback HTML fetch for bot-blocked discovery (403 responses). Configured via `JINA_API_KEY` Supabase secret; skipped silently if absent. | Free tier: 1 M tokens/month (~500–1000 page fetches). Paid from ~$0.02/1 M tokens. A single discovery fetch is typically 10–100 K tokens. | Free tier: ~200 req/min. | +1–5 s added to a 403-path discovery (on top of the failed direct fetch). The Jina call is not on the happy path so normal discovery is unaffected. | On timeout, non-2xx, or body-size-cap hit, `fetchViaJina` returns `null` and the original `auth` error is surfaced to the user — no change in behavior from today. |

## Dev commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (service worker disabled) |
| `npm run build` | `tsc -b` typecheck + `vite build` |
| `npm run preview` | Serve the production build |
| `npm test` | `vitest run` (one shot) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint over the repo |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run icons:generate` | Regenerate `public/` icons (`node scripts/generate-icons.mjs`) |

Run `lint`, `typecheck`, and `test` before every PR; add `build` when you touch
build/routing/deploy.

## Testing expectations

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

## Safe vs. risky actions

- Safe: edit files, add dependencies, run tests, run the dev server,
  creating new `<agent>/<short-topic>` feature branches, creating PRs via
  `mcp__github__create_pull_request` once the user has asked you to open one
  (and for subsequent follow-up PRs in the same thread — don't keep
  re-asking), `git push --force-with-lease` to your own live feature branch
  after a rebase (this is normal hygiene, not a risky action), and the
  Copilot-review round-trip on your own PRs:
  `mcp__github__request_copilot_review`,
  `mcp__github__add_reply_to_pull_request_comment`, and
  `mcp__github__resolve_review_thread` (currently broken via MCP — see
  *Copilot reviews* below).
- Ask first before: force-pushing to `main`/`master` or to a merged branch,
  rewriting history on shared branches, deleting branches you didn't create,
  changing Vercel/Supabase project settings, changing CI secrets, adding
  paid/third-party services.

## Branching

- **Branch naming.** Feature branches are prefixed with the agent's own short name: `<agent>/<short-topic>` (e.g. `claude/...` for Claude Code). Human contributors pick a name that identifies them.
- **Workflow.** `<agent>/<short-topic>` branch off `origin/main` → PR → merge via rebase or squash. One topic per branch. Follow-up work after a merge goes on a new branch. Never commit to `main` / `master`.
- **One commit per logical surviving change on the branch.** Rewrite unmerged commits freely (squash, amend, reorder, split with `git rebase -i` / `git reset --soft`) so each landing commit is one coherent change, with fix-ups and review responses folded into the commit they belong to. A PR can be a single commit or a short series — but review-fix noise doesn't survive into `main`.
- **Check state before you push or branch.** Query the branch's PR via the GitHub MCP first.
  - No PR yet, or PR open → `git push` (`--force-with-lease` to your own feature branch after a rebase is fine; don't ask).
  - PR merged / closed → don't push. Merge-path hygiene: `git fetch origin`, cut a fresh `<agent>/<short-topic>` branch off `origin/main`, announce the switch.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene *before* engaging with the rest of the message.**
- Creating new `<agent>/<short-topic>` branches and creating PRs via `mcp__github__create_pull_request` (once the user has asked for one in the thread) are safe — don't re-ask.
- Sandbox git proxy can't delete branches (HTTP 403). Flag it and move on; auto-delete-on-merge handles GitHub's side.
- **After every push and after every merge, report the resulting HEAD SHA** so the operator can verify which build is deployed. Format: `pushed <short-sha>` after a push; `merged at <short-sha>` after a merge webhook. 7-char prefix is fine. Mention it once per push.
- End every reply with the open-PR link (or `.../compare/main...<branch>` until a PR exists). Never link to a closed or merged PR.

## Copilot reviews

Copilot reviews are triggered automatically — do not call `mcp__github__request_copilot_review`.

- **Address Copilot comments automatically — don't wait to be asked.** When a Copilot review lands, treat each comment like a real review note: read it, decide whether it's a real issue or a false positive, and if it's real, fix it in the same PR. Fold the fix into the commit it belongs to (rebase / `--fixup`) rather than tacking on an "address review" commit, per the *one commit per logical surviving change* rule. Group several small fixes into one commit when they share a topic.
- **Reply to (and, when possible, resolve) every addressed Copilot comment** via `mcp__github__add_reply_to_pull_request_comment`. Do this for each addressed comment, not in bulk.
- **Don't resolve threads you haven't addressed.** If you disagree with a suggestion or are deferring it, leave the thread open and reply explaining why.
- **Order of operations on a push that addresses review comments:** (1) push the fix commit, (2) reply on each addressed thread referencing the new sha.
- **Known limitation: `resolve_review_thread` is currently broken via MCP.** The thread node ID (`PRRT_*`) is stripped from `get_review_comments` responses, so `resolve_review_thread` can't be called. Post the reply via `mcp__github__add_reply_to_pull_request_comment` and skip the resolve step — flag in the end-of-turn summary that the threads are replied-but-unresolved so the user can resolve them in the GitHub UI.

## Pull requests and reviews

- Open PRs ready for review (not draft) unless asked otherwise.
- **Wait for a 👍 reaction and no open comments before merging.** Don't merge to `main` (via rebase) until the reviewer has left a top-level thumbs-up reaction on the PR AND there are no open review comments. Don't ask whether it's okay to merge — wait for the signal.
- When a feature has multiple open PRs, list **every** open PR by URL,
  one per line — the "View PR" chip sticks to the first link and hides
  the rest (anthropics/claude-code#46625).

## CI

- After pushing, **wait for CI** before claiming a change works in any environment you can't test locally. Webhooks deliver — don't poll.
- Report significant CI timing regressions (rule of thumb: >25% or >30s on a job under ~5min). Name the likely cause.
