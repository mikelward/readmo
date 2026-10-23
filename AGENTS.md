---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-23
---

# Readmo — Contributor guide

Readmo is a mobile-first RSS/Atom/JSON-feed reader PWA (React + TypeScript + Vite, Supabase
backend). It reuses *newshacker*'s UX as-is; the only intended differences are the data
source (your subscriptions) and the plumbing that requires (server-side fetch/parse,
accounts, sync). The normative spec is [`SPEC.md`](./SPEC.md). `CLAUDE.md` and `GEMINI.md`
are symlinks to this file; edit `AGENTS.md` and bump `last_modified`.

**At the start of every session, print the full absolute path of the `AGENTS.md` you
loaded and its `last_modified` date**, so a stale or wrong copy is caught first.

Keep this file short — one-liners over essays, **under 24,000 bytes** (`wc -c AGENTS.md`):
Antigravity caps rule files at 24 KB and silently truncates the tail. Incident narratives
belong in commits, tables and background in `AGENTS-REFERENCE.md`. Add a rule the first
time something bites, rewrite/trim rather than append, delete rules that stopped biting.

## Guardrails

1. **Always add tests; run `npm test`, `npm run lint` and `npm run typecheck` before
   reporting done**, plus `npm run build` when touching build, routing or deploy config.
   Housekeeping-only diffs (root-level markdown and `docs/`; markdown elsewhere is code)
   ride the docs lane on PRs and `main` alike and Vercel skips them; the required `lanes`
   check re-verifies any skip (`.github/lanes.conf`). 80% coverage floor for `src/lib/`
   and server handlers, enforced by `npm run test:coverage` (the Deno-only Edge entry
   files and `ssrf.ts`: the `edge` CI job).
2. **Fewer, larger tap targets.** At most **3 tap zones per row, two shipped** (row-body
   stretched link + right-side icon button; the middle slot stays reserved). **44×44px**
   touch floor, **≥8px gaps**, pressed state on every zone. Flag anything adding a fourth
   tappable or filling the reserved slot.
3. **US English everywhere** — copy, identifiers, CSS classes, DB columns, comments, docs.
4. **Keep `SPEC.md` in sync, in the same commit** as any reversed/extended decision or new
   user-visible behavior, tap target, storage surface, route or layout reorder. SPEC holds
   product intent and user-visible decisions, not mechanics (identifiers, CSS, DOM APIs,
   timing constants, quirk workarounds, formulas — those go in code comments and tests):
   if an unobservable change would force a SPEC edit, that text is misplaced. Trim
   accumulated mechanism as a *net deletion*.
5. **Call out cost and reliability up front** for any new infra or external call — free
   tier vs paid, rough $/mo, failure modes, rate limits, latency; say "negligible" rather
   than omit it. Current services: `AGENTS-REFERENCE.md` § External services (keep it
   current).
6. **Publisher content and user-supplied URLs are untrusted.** Sanitize all publisher HTML
   server-side (strip scripts/handlers/disallowed tags, absolutize URLs, force
   `rel="noopener"`) before storing; never store or serve it raw. Every server-side fetch
   (`/api/discover`, poller, image proxy, any full-text fetch) goes through the
   SSRF-hardened helper: http/https only, resolved-IP denylist (loopback, link-local incl.
   `169.254.169.254`, RFC1918, ULA, reserved), re-validate every redirect, timeouts and
   size caps, no credential forwarding; a unit test asserts each rejection.
7. **RLS is the per-user boundary.** `subscriptions`, `item_state`, `folders` are gated on
   `auth.uid()`, failing closed. The client never gets the service-role key (poller only).
   `feeds`/`items` are shared but not world-readable: a row shows only with a matching
   `subscriptions` row or a permanent (`pinned`/`favorite`/`done`) `item_state` row.
   `secret_url`/tokenized feed URLs stay server-only. **Sharing carve-out (capability, not
   RLS):** `/item/:id` opens for any signed-in recipient via `get_shared_item` (`SECURITY
   DEFINER`, keyed on the item uuid, display-safe columns, public feeds only — no
   `secret_url`, non-tokenized `url`); row policies don't widen and full text/summary stay
   allowlist-gated (SPEC *Sharing an article*).
8. **Scope client caches by `auth.uid()`**: on sign-out or sign-in as someone else, purge
   the previous user's IndexedDB store and Workbox caches before the new session paints.
9. **Match newshacker's UX by default**; diverge only for no comments/votes, server-side
   data, accounts/sync.
10. **Branching:** one topic per `<agent>/<short-topic>` branch (see *Branching*).
11. **Ship a backwards-compatible client; flag manual deploys.** Never merge a client that
    *requires* an unshipped server change (see *Deploying*).
12. **Look at how the repo already does it** before adding a client store of server state
    or a second home for a fact: `lib/settingsSync` and the item-state store + outbox are
    local-first with async reconcile, both fine. Neither has a **redundant fallback
    authority** — a write-less second copy of a server-read fact that something must choose
    between; the open-mode snapshot (#700) was one and cost nine review rounds.
13. **Ask before adding wordy in-product copy** — the label is the copy. No explanatory
    blurb or aside beside a control without a yes; propose the wording and wait.

## External services

The table of every third-party call — purpose, cost, rate limits, latency and failure mode
for Jina, Google News RSS, Gemini, SMTP, Supabase Auth email, the Metrics API and Grafana —
lives in `AGENTS-REFERENCE.md` § External services. Keep it current (guardrail 5).

## Code

- **Build against `src/lib/data/DataSource.ts`**, not a concrete source
  (`SupabaseDataSource` when configured, else `MockDataSource`; `main.tsx` picks). Live
  writes land **asynchronously** via the outbox, so reading server truth right after one
  must tolerate the lag. Use the `--rm-*` tokens, not hard-coded colors. Layout and
  commands: `AGENTS-REFERENCE.md`.
- Vitest + jsdom; a Node-only test opts in with `// @vitest-environment node`. **Never
  disable a failing check** — lowering the coverage floor included. **No sleeps, retries
  or bumped `findBy*` timeouts**: resolve a controlled promise, advance fake timers,
  `act(...)`, or gate the fetch. Skipping a preexisting failure as unrelated needs the
  user's confirmation. `npm run feeds:check` fetches every popular feed: manual/CI only
  (a sandbox without egress shows all failing).

## Vercel `api/` gotchas

- **No shared modules for `api/*.ts`** — inline helpers, duplicated, with a comment naming
  the siblings. Imports from outside `api/` or from an `_`-prefixed dir in it pass every
  local check and fail at deploy; a plain subdir gets routed as functions.
  `api/imports.test.ts` enforces it; delete it only after verifying on a Vercel preview.

## Deploying & client/server compatibility

- **Two halves, two clocks.** The frontend auto-deploys to Vercel on every merge to `main`
  (docs-only commits skipped by `scripts/vercel-ignore.mjs`, failing open; an env var
  change needs a redeploy). The backend — Edge Functions incl. `_shared/`, and migrations —
  goes live only via a human's `make deploy` (migrates first), `make migrate` or
  `make deploy-<fn>`. Supabase secrets/config (`MIN_CLIENT_BUILD`, `GOOGLE_API_KEY`,
  `JINA_API_KEY`, `SMTP_*`) go live separately, set by an operator in the dashboard or CLI.
- **Both directions must work.** A new client may hit the old backend: feature-detect and
  fall back on a missing function/RPC/column (404, `PGRST` not found, odd shape), or
  deploy the backend first. A new backend meets old cached clients: keep server changes
  **additive**; never remove or rename what a shipped client calls. The `x-readmo-build`
  + `MIN_CLIENT_BUILD` 426 gate sheds a harmful old client, not compatibility in general.
- **Name any required `make deploy`/`make migrate`, or secret to set,** in the PR and your
  end-of-turn summary.

## Talking to the user

- **One question at a time**, in plain chat or your client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity). **After asking, stop
  and wait** — don't assume an answer, pick a "recommended" option, or keep working on the
  part it affects. Never ask while the user is typing.
- **Answer a mid-turn message first**, before any further tool call — except a merge cue,
  whose hygiene runs first and whose announced switch is the answer.
- **Message only when the user needs to see it** (maintainer, 2026-10-15): each notifies
  their phone. Speak up for a question/blocker, something to merge or act on, a merge, an
  autopilot decision (to review, never waited on), or a change from the plan, `SPEC.md` or
  their instructions (review-prompted included). Never for progress (a client's nudge
  doesn't count), a review or push alone (its report rides the next message), routine
  machinery, or a mistake fixed before reaching the repo. The session-start line still
  opens every session.
- **Keep replies short**: lead with the most important point; ask before unloading more.
- **End the turn by restating any pending decision** as its last line (an open-PR link
  goes just above it), every turn until answered; nothing pending, no line. A scheduled
  check that finds nothing new re-arms silently with no reply.

## Error handling

- **Don't silently swallow exceptions.** Log the error with sanitized context ("poll of
  feed 42 failed: 403"), clean up what `try` acquired (abort controllers, fetches, outbox
  entries, partial writes, UI state), and pick explicitly what the caller sees. A blanket
  `catch` swallows a deliberate `AbortError`, and a swallowed Supabase/Edge error turns a
  feature-detect fallback into a silently lost write — narrow the type. Ignoring a failure
  on purpose: say why in a comment, still log at debug.

## Privacy

- **Never put user data in any artifact leaving this machine** (commits, PRs, comments,
  issues, branches, fixtures, logs): emails, `auth.uid()`s, the service-role key,
  `JINA_API_KEY`/`GOOGLE_API_KEY`/`SMTP_*`, allowlist membership, and — easiest to miss —
  `secret_url`/tokenized feed URLs. Use placeholders (`alice@example.com`,
  `https://example.com/feed.xml`, `sk-example`); paraphrase bug reports; ask when unsure.

## Safe vs. risky actions

- **Safe:** edits, dependencies, tests, the dev server, new `<agent>/` branches, PRs (this
  file is the standing ask), `--force-with-lease` to your own live branch after a rebase,
  and the Codex reply/resolve round-trip on your PRs.
- **Ask first:** force-pushing `main` or a merged branch (resetting a merged name too),
  rewriting shared history, deleting any branch but this session's own under your
  prefix, changing Vercel/Supabase settings or CI secrets, adding paid/third-party
  services.

## Commit messages

- **Title like a changelog line** (maintainer, 2026-10-23): after any prefix, an imperative
  verb, then the change in the user's plain words, sentence case, ≤ ~70 chars incl.
  prefix, e.g. `Fix …`, `Improve …`, `Add …`; an optional parenthetical says how.
  Scenario, mechanism and file:line go in the body (none needed when there's nothing to
  explain, like the weekly batch). PR titles match.
- **Prefix a subject that changes nothing a user could notice**: `docs:` (prose), `todo:`
  (`TODO.md` alone), `test:` (tests only), `build:` (toolchain, CI, lint/build config,
  `scripts/`), `refactor:` (behavior-preserving). Bare means behavior changed. No
  `feat:`/`fix:`, and no `deps:` — a dependency bump is bare, the weekly batch included (one
  taken for a behavior change says what changed).
- `TODO.md` and `SPEC.md` ride along and never decide the prefix (a SPEC-only decision is
  `docs:`). A mixed commit is bare if any part changes behavior (`src/` + `supabase/` is
  one change); below that the prefix names why it exists (a toolchain pin that edits its
  guides is `build:`). Independent categories are two commits.
- **No model identifier** — never name the coding agent's model or version (`Opus 4.8`,
  `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR, comment, or pushed
  artifact; keep it to chat. A model the product calls (readmo's Gemini model) is not
  covered. Generic attribution (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`,
  "Generated with Claude Code") is fine.

## Branching

- `<agent>/<short-topic>` (`claude/…` Claude Code, `gemini/…` Gemini / Antigravity,
  `codex/…` Codex; humans pick their own) off `origin/main` → PR → rebase-merge. One topic
  per branch, follow-ups on a new one, never commit to `main`. Squash merging is disabled,
  so each commit subject lands, never the PR title — which still carries the prefix a
  subject would, judged over the whole branch each push (only subjects are linted).
- `git worktree` when available. One commit per logical change: rewrite unmerged commits
  freely, folding review fixes in.
- **No-remote sandbox** (Codex cloud): continue from HEAD, on this task's own topic branch
  (unless HEAD is it, cut one from a base free of earlier work: clean local `main`, else
  ask for a synced checkout). Only fetch, push and PR are unavailable — say so plainly,
  claim nothing about unseen remote state, and end with "local, unpushed", not a link.
- **Check the PR before you push or branch**: none or open → push (`--force-with-lease`
  after a rebase, unasked); merged/closed → don't push, run merge-cue hygiene. A pinned
  branch already reset onto `origin/main` per the rule below is new work: push it with
  `--force-with-lease`.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene first**:
  `git fetch origin +refs/heads/main:refs/remotes/origin/main` (`git fetch origin main`
  leaves single-branch `origin/main` stale), cut a fresh `<agent>/<short-topic>` off
  `origin/main`, announce the switch. Without a remote, ask for a synced checkout.
- **After a merge take a fresh branch**, not the merged name reset (its remote ref keeps
  spanning merged commits). If a sandbox pins the name, **say so and ask before resetting
  it**: no short check tells merged from unmerged, a `--hard` reset erases uncommitted
  work, and a fetch defeats `--force-with-lease`.
- **Your `<agent>/` branches are yours** — create, push, `--force-with-lease`, rename,
  delete the ones this session created or was assigned (this file is the standing
  grant); don't fold unrelated work into a pinned one. Anyone else's, another session's,
  or `main`: ask.
- **Committer line**: the agent authors; merges rewrite the committer to the merger (you under drive) —
  never re-author, amend or mention it; it is not a finding. The git proxy can't delete branches (403):
  flag it, move on.
- **Report the SHA after every push and merge**: `pushed <short-sha>` or `merged at
  <short-sha>` — the commit the merge produced (from the merge API or PR), not your HEAD
  or a later `origin/main` tip.
- **Update the PR title and body before each push** (body first), then post the link; with
  no PR yet, push, then do it as soon as one is opened.
- **Unshallow before history-depth answers**: the session-start hook runs
  `scripts/unshallow.sh` only in Claude Code; elsewhere run it (or `git fetch
  --unshallow`) yourself. No remote: say the history is truncated.
- **End every reply with the open-PR link** (or `.../compare/main...<branch>`); never a
  closed or merged PR's.

## Autonomy

- **Open the PR without being asked** (the owner's standing request), unless told "just
  commit / no PR yet".
- **Watch your own PRs by subscription + one scheduled check.** Subscribe on open
  (automatic in Claude Code, or `subscribe_pr_activity` where `claude-code-remote` exposes
  it; a client with neither, like Antigravity, relies on the scheduled check alone). It
  misses CI success, pushes, the merge, Codex's `+1` and Codex's silence, so keep exactly
  one relative-delay check armed (`send_later` in Claude Code; `schedule` with
  `DurationSeconds` in Antigravity, canceled via `manage_task` `kill`): minutes while CI
  or the verdict is out or after a push, longer once only a human is left. Settle a fired
  check first (update a survivor, replace a retired one); if the fire time isn't what you
  asked, re-time it or say the watch isn't armed; name the PR, not a SHA. Under drive, arm
  auto-merge only where the ruleset requires the Codex verdict AND resolved conversations.
- **Read `mergeable_state` at every check, wake and drive step**: `dirty`, or `behind`
  where required → fetch base and head by refspec, unshallow, rebase onto the fetched
  `origin/<base>` (not always `main`), `--force-with-lease` push unasked — once sure your
  branch has every remote head commit and the head hasn't moved since the tip you noted
  before fetching; otherwise stop and ask.
- **Wake PRs a merge leaves behind.** First turn after your PR merges, message every other
  open PR on that base whose body ends with a session URL: name that PR, say only that its
  base now points at `<sha>`, whatever its state reads (no merge, no other PR named). On
  receipt, fetch base and PR head by refspec (unshallow) and test that head against the
  fetched tip, not `<sha>`: `behind` if `git merge-base --is-ancestor <tip> <head>` exits
  1, `dirty` if `git merge-tree --write-tree` (Git 2.38+) exits 1; any other exit is a
  failure to report. Skip with no session URL or only local subagent messaging; don't
  retry.
- **On merge or close**, one last reply-and-resolve pass; real work on a merged PR goes to
  a follow-up PR named on the thread (closed-unmerged: open nothing). Then cancel the check
  and unsubscribe, if subscribed, matching this session and PR (`list_triggers` spans the
  account).
- **A scheduler or GitHub prompt is said once, then carry on.**
- **"Drive"**: take the next actionable `TODO.md` item (not deferred or awaiting a product
  decision), implement, open the PR, wait for Codex, address every comment, merge on
  green CI plus the head's verdict (*drive to merge*), repeat until done or stopped.
- **A red baseline is the next task**: `npm test`, `npm run lint`, `npm run typecheck`
  green before pulling from `TODO.md`, fixed in its own first commit.
- **"Autopilot"**: drive without blocking — take the cheapest-to-undo guess and log it
  under `TODO.md` *Decisions needing review* (decision, alternative, why reversible); it
  outranks stop-and-wait. The loop's steps (commit, push, PR, reading CI/review, arming
  the check, merging green) are authorized. Still waiting for a real answer: destructive
  or irreversible actions outside the loop, anything reaching beyond this repo (a Supabase
  migration or deploy included), resetting a pinned merged branch, *Safe vs. risky*'s
  ask-first list, guardrail 13's copy, skipping a red baseline, and privacy uncertainty
  (an email, `auth.uid()`, key, `secret_url`).

## Pull requests and Codex reviews

- Prefer `mcp__github__*` tools where mounted (Claude Code requires them); else `gh`. Open
  PRs ready for review unless asked otherwise. Link every open PR in a feature, one per
  line.
- **Codex is the automated reviewer** (not Copilot), triggered automatically; request it
  only to confirm a rebutted false positive or as the verdict rule allows.
- **Address every comment unasked**, any reviewer's: fix and fold into its commit (group
  same-topic fixes), or reply declining with reasons. Push, reply citing the sha, then
  resolve (`resolve_review_thread` with the `PRRT_*` from `review_threads[].id`, not a
  `PRRC_*`; `gh api graphql` `resolveReviewThread` without MCP). A thread ends answered
  and, once fixed or rebutted, resolved, one thread at a time; anything still to do stays
  open. An acknowledgment is fine but isn't an answer.
- **Judge comments on merit.** A cited rule is a reading — check what it says; Codex
  over-reads privacy rules, quietly costing capability. Quote and decline rather than
  narrow the code; a genuine conflict is the maintainer's call. Then poke as the verdict
  rule allows (or let the next push); escalate if it re-raises.
- **A second verified finding in one mechanism is a design question**: would an existing
  design (guardrail 12) or a new one delete the class? Say so on the thread; the
  maintainer decides, autopilot included.
- **Defer a real-but-out-of-scope finding**: push a `TODO.md` entry, reply citing the sha,
  resolve (a threadless finding skips only the resolve); escalate if the re-review
  re-raises it.
- **Read the Codex verdict, don't infer it**: its PR-body reaction (`eyes` reading, `+1`
  clean, revoked on push; `+1` + green CI = merge; leave body reactions to Codex). A
  no-findings review naming the head says the same, but the reaction clears the status.
  Read review comments, top-level comments and reviews to the last page; findings block
  until fixed, rebutted or deferred. Pending `codex`: address findings; a clean review
  with no reaction or an unanswered rebuttal → `@codex review` five minutes on; nothing
  at all five minutes after the push, or a review stuck at running (👀) ten minutes on →
  poke. A poke that hangs the same way gets a second an hour later; escalate only if
  that one hangs too, never after one (maintainer, 2026-10-22).
- **Once Codex +1s a head, make no unnecessary change without asking** (maintainer,
  2026-10-13); rebases for `dirty`/required `behind`, red-CI fixes and drive/autopilot
  steps proceed. Don't merge ahead of the verdict, and don't ask whether to merge.
- **Report each review in your next message** (any reviewer's, even past *keep replies
  short*): commit read (say if no longer the head), finding count, one bullet per finding,
  most blocking first; ask only the most blocking question.
- **Ordered work ("next", "then", "after that", "follow-up")** may open in parallel but
  merges only after every earlier session item and named PR has merged (any repo, no time
  cap; hold and ask if one stalls, autopilot included; no auto-merge until then). Read the
  list from the session's record, not memory.
- Skip your own webhook echoes silently (did *I* just post this body?).

## Node version

- **The Node major lives in `.nvmrc`, `engines.node` and `@types/node`; move them together**
  in one commit. `nodeVersion.test.ts` asserts the lockfile-**resolved** `@types/node`
  (vite/vitest/msw ranges float). Currently **24**.
- **`.claude/hooks/session-start.sh` provisions it** each run, best-effort (auto-invoked
  only in Claude Code; other agents run it or match `.nvmrc`). It's byte-identical across
  gedmap/newshacker/readmo and tested end to end (`scripts/session-start-hook.test.ts`):
  change it everywhere. Its PATH-shim fallback and refusals: `AGENTS-REFERENCE.md`.

## Dependency updates

- **The weekly batch lives in mikelward/npm-update** (thin caller; `regenerate` runs the
  local `npm run import-map:sync`): fix the mechanism there; no batch PR → check its run
  log. Renovate is off (`renovate.test.ts`; config dormant) and can't bump Node.
  Dependabot security updates are off: an advisory is a hand bump with any peer-pinned
  partner, unless the batch carried it.
- **Auto-merge only minors and patches on green CI**; majors and `0.x` wait for review; a
  red or skipped check is a stop sign.
- **`.npmrc` `min-release-age` (5 days)** covers transitive deps and lockfile
  regeneration; it needs npm ≥ 11.10.0, pinned exactly (`engines.npm`, `constraints.npm`)
  — raise it only if genuinely required, checking what Node 24 bundles.
  `min-release-age-exclude` admits an urgent `npm audit fix`.
- **`supabase/functions/import_map.json` must match `package.json`** (`import_map.test.ts`).

## CI

- **Wait for CI** before claiming a change works where you can't test locally; don't
  busy-poll. Report regressions >25% or >30 s on a job under ~5 min, naming the cause.
