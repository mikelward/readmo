---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# Readmo — Contributor guide

Readmo is a mobile-first RSS/Atom/JSON-feed reader PWA (React + TypeScript + Vite, Supabase
backend) reusing *newshacker*'s UX (guardrail 9). The normative spec is
[`SPEC.md`](./SPEC.md). `CLAUDE.md` and `GEMINI.md` are symlinks to this file; edit
`AGENTS.md` and bump `last_modified`.

**At the start of every session, print the full absolute path of the `AGENTS.md` you
loaded and its `last_modified` date**, so a stale or wrong copy is caught first.

Keep this file short — one-liners over essays, **under 22,000 bytes** (`wc -c AGENTS.md`):
Antigravity caps rule files at 24 KB and silently truncates the tail. Incident narratives
belong in commits, tables and background in `AGENTS-REFERENCE.md`. Add a rule the first
time something bites, rewrite/trim rather than append, delete rules that stopped biting.

## Guardrails

1. **Always add tests; run `npm test`, `npm run lint` and `npm run typecheck` before
   reporting done**, plus `npm run build` when touching build, routing or deploy config.
   Docs-only diffs (root-level markdown and `docs/`; markdown elsewhere is code) ride the
   docs lane and skip Vercel; the required `lanes` check re-verifies it. 80% coverage
   floor for `src/lib/` and server handlers (`npm run test:coverage`; Deno-only Edge
   entries and `ssrf.ts`: the `edge` CI job).
2. **Fewer, larger tap targets.** At most **3 tap zones per row, two shipped** (row-body
   stretched link + right-side icon button; the middle slot stays reserved). **44×44px**
   touch floor, **≥8px gaps**, pressed state on every zone. Flag anything adding a fourth
   tappable or filling the reserved slot.
3. **US English everywhere** — copy, identifiers, CSS classes, DB columns, comments, docs.
4. **Keep `SPEC.md` in sync, in the same commit** as any reversed/extended decision or new
   user-visible behavior, tap target, storage surface, route or layout reorder. SPEC holds
   product intent, not mechanics (identifiers, CSS, timing constants, formulas go in code
   comments and tests): text an unobservable change would force you to edit is misplaced.
   Trim accumulated mechanism as a *net deletion*.
5. **Call out cost and reliability up front** for any new infra or external call — free
   tier vs paid, rough $/mo, failure modes, rate limits, latency; say "negligible" rather
   than omit it. Current services: `AGENTS-REFERENCE.md` § External services (keep it
   current).
6. **Publisher content and user-supplied URLs are untrusted.** Sanitize all publisher HTML
   server-side (strip scripts/handlers/disallowed tags, absolutize URLs, force
   `rel="noopener"`) before storing; never serve it raw. Every server-side fetch
   (`/api/discover`, poller, image proxy, any full-text fetch) goes through the
   SSRF-hardened helper: http/https only, resolved-IP denylist (private, loopback,
   link-local incl. `169.254.169.254`, reserved), every redirect re-validated, timeouts,
   size caps, no credential forwarding; a unit test asserts each rejection.
7. **RLS is the per-user boundary.** `subscriptions`, `item_state`, `folders` are gated on
   `auth.uid()`, failing closed. The client never gets the service-role key (poller only).
   `feeds`/`items` are shared but not world-readable: a row shows only with a matching
   `subscriptions` row or a permanent (`pinned`/`favorite`/`done`) `item_state` row.
   `secret_url`/tokenized feed URLs stay server-only. **Sharing carve-out:** `/item/:id`
   opens for any signed-in recipient via `get_shared_item` (`SECURITY DEFINER`, display-safe
   columns of public feeds, never `secret_url` or a tokenized `url`), not wider RLS; full
   text/summary stay allowlist-gated (SPEC *Sharing an article*).
8. **Scope client caches by `auth.uid()`**: on sign-out or sign-in as someone else, purge
   the previous user's IndexedDB store and Workbox caches before the new session paints.
9. **Match newshacker's UX by default**; diverge only for the data source (your
   subscriptions) and its plumbing: no comments/votes, server-side fetch/parse,
   accounts/sync.
10. **Branching:** one topic per `<agent>/<short-topic>` branch (see *Branching*).
11. **Ship a backwards-compatible client; flag manual deploys.** Never merge a client that
    *requires* an unshipped server change (see *Deploying*).
12. **Look at how the repo already does it** before adding a client store of server state
    or a second home for a fact: `lib/settingsSync` and the item-state store + outbox
    (local-first, async reconcile) are fine; a **redundant fallback authority** (a
    write-less second copy of a server-read fact to choose between) is not — the open-mode
    snapshot (#700) was one and cost nine review rounds.
13. **Ask before adding wordy in-product copy** — the label is the copy: no blurb or aside
    beside a control without a yes; propose the wording and wait.

## Code

- **Build against `src/lib/data/DataSource.ts`**, not a concrete source
  (`main.tsx` picks `SupabaseDataSource` when configured, else `MockDataSource`). Live
  writes land **asynchronously** via the outbox, so reading server truth right after one
  must tolerate the lag. Use the `--rm-*` tokens, not hard-coded colors. Layout and
  commands: `AGENTS-REFERENCE.md`.
- Vitest + jsdom; a Node-only test opts in with `// @vitest-environment node`. **Never
  disable a failing check**, the coverage floor included. **No sleeps, retries or bumped
  `findBy*` timeouts**: controlled promises, fake timers, `act(...)`, or a gated fetch.
  `npm run feeds:check` fetches every popular feed: manual/CI only (offline, all fail).

## Vercel `api/` gotchas

- **No shared modules for `api/*.ts`** — inline helpers, duplicated, with a comment naming
  the siblings (other layouts fail only at deploy; why: `AGENTS-REFERENCE.md`).
  `api/imports.test.ts` enforces it; delete it only after verifying on a Vercel preview.

## Deploying & client/server compatibility

- **Two halves, two clocks.** The frontend auto-deploys to Vercel on every merge to `main`
  (a Vercel env var change needs a redeploy). Edge Functions (incl. `_shared/`),
  migrations and Supabase secrets go live only by hand (`make deploy`, `make migrate`,
  `make deploy-<fn>`, an operator setting the secret; table in `AGENTS-REFERENCE.md`):
  name any one required in the PR and end-of-turn summary.
- **Both directions must work.** A new client may hit the old backend: feature-detect and
  fall back on a missing function/RPC/column (404, `PGRST` not found, odd shape), or
  deploy the backend first. Old cached clients meet the new backend: keep server changes
  **additive**, never removing or renaming what a shipped client calls. The
  `MIN_CLIENT_BUILD` 426 gate sheds a harmful old client, not compatibility in general.

## Talking to the user

- **One question at a time**, in plain chat or your client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity), never while the user
  is typing. **Then stop and wait** — no assumed answer, self-picked "recommended" option,
  or work on the part it affects.
- **Answer a mid-turn message first**, before any further tool call — except a merge cue,
  whose hygiene runs first and whose announced switch is the answer. **Claude Code only**
  (maintainer, 2026-10-25): its app reliably shows just a turn's last message, so reply
  only there, answering a mid-turn message at a stopping point soon.
- **Message only when the user needs to see it** (maintainer, 2026-10-15; each notifies
  their phone): a question/blocker, something to merge or act on, a merge, an autopilot
  decision (to review, never waited on), or a change from the plan, `SPEC.md` or their
  instructions (review-prompted included). Never progress (a client's nudge doesn't
  count), a review or push alone (its report rides the next message), routine machinery,
  or a mistake fixed before reaching the repo. The session-start line still opens every
  session.
- **Keep replies short**: lead with the most important point; ask before unloading more.
- **End the turn by restating any pending decision** as its last line (the open-PR link
  just above), every turn until answered; nothing pending, no line. A scheduled check
  finding nothing new re-arms silently, no reply.

## Error handling

- **Don't silently swallow exceptions.** Log the error with sanitized context ("poll of
  feed 42 failed: 403"), clean up what `try` acquired (abort controllers, fetches, outbox
  entries, partial writes, UI state), and pick explicitly what the caller sees. Narrow the
  type: a blanket `catch` swallows a deliberate `AbortError`, and a swallowed Supabase/Edge
  error turns a feature-detect fallback into a silently lost write. Ignoring one on
  purpose: say why, still log at debug.

## Privacy

- **Never put user data in any artifact leaving this machine** (commits, PRs, comments,
  issues, branches, fixtures, logs): emails, `auth.uid()`s, the service-role key,
  `JINA_API_KEY`/`GOOGLE_API_KEY`/`SMTP_*`, allowlist membership, and — easiest to miss —
  `secret_url`/tokenized feed URLs. Use placeholders (`alice@example.com`,
  `https://example.com/feed.xml`, `sk-example`); paraphrase bug reports; ask when unsure.

## Safe vs. risky actions

- **Safe:** edits, dependencies, tests, the dev server, and what *Branching* and the
  review loop grant.
- **Ask first:** force-pushing `main` or a merged branch (resetting a merged name too),
  rewriting shared history, deleting any branch but this session's own, changing
  Vercel/Supabase settings or CI secrets, adding paid/third-party services.

## Commit messages

- **Title like a changelog line** (maintainer, 2026-10-23): after any prefix, an imperative
  verb, then the change in the user's plain words, sentence case, ≤ ~70 chars incl.
  prefix, e.g. `Fix …`, `Improve …`, `Add …`; an optional parenthetical says how.
  Scenario, mechanism and file:line go in the body, if any (the weekly batch needs none).
  PR titles match.
- **Prefix a subject that changes nothing a user could notice** (bare means behavior
  changed): `docs:` prose, `todo:` `TODO.md` alone, `test:` tests only, `build:`
  toolchain/CI/lint/build config/`scripts/`, `refactor:` behavior-preserving. No
  `feat:`/`fix:`/`deps:` — a dependency bump is bare, the weekly batch included (one taken
  for a behavior change says what changed).
- `TODO.md` and `SPEC.md` ride along, deciding the prefix only when they are the whole
  change (`docs:`). A mixed commit is bare if any part changes behavior (`src/` +
  `supabase/` is one change); below that the prefix names why it exists (a toolchain pin
  editing its guides is `build:`). Independent categories are two commits.
- **No model identifier** — never name the coding agent's model or version (`Opus 4.8`,
  `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR, comment, or pushed
  artifact; keep it to chat. A model the product calls (readmo's Gemini model) is not
  covered. Generic attribution (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`,
  "Generated with Claude Code") is fine.

## Branching

- `<agent>/<short-topic>` (`claude/…` Claude Code, `gemini/…` Gemini / Antigravity,
  `codex/…` Codex; humans pick their own) off `origin/main` → PR → rebase-merge, in a `git
  worktree` when available. One topic per branch, follow-ups on a new one, never commit to
  `main`. One commit per logical change: rewrite unmerged commits freely, folding review
  fixes in. Squash merging is disabled, so each subject lands, never the PR title — which
  still carries the prefix a subject would, judged over the whole branch each push.
- **No-remote sandbox** (Codex cloud): work from HEAD on this task's own branch, cut from
  a base free of earlier work (clean local `main`, else ask for a synced checkout); say
  fetch/push/PR were unavailable, claim nothing about the remote, end with "local,
  unpushed".
- **Check the PR before you push or branch**: none or open → push (`--force-with-lease`
  after a rebase, unasked); merged/closed → don't push, run merge-cue hygiene (a pinned
  name already reset onto `origin/main`, per below, is new work: push it).
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
- **Committer line**: the agent authors; merges rewrite the committer to the merger (you
  under drive) — never re-author, amend or mention it; not a finding. The git proxy can't
  delete branches (403): flag it, move on.
- **Report the SHA after every push and merge**: `pushed <short-sha>` or `merged at
  <short-sha>` (the merge's own commit per the merge API or PR, not HEAD or a later
  `origin/main`).
- **Unshallow before history-depth answers** (`scripts/unshallow.sh`, or `git fetch
  --unshallow`; the session-start hook runs it only in Claude Code). No remote: say
  history is truncated.
- **Update the PR title and body before each push** (body first; no PR yet: push, then
  update once one opens). **End every reply with the open-PR link** (or
  `.../compare/main...<branch>`), never a closed or merged PR's.

## Autonomy

- **Open the PR unasked** (the owner's standing request) unless told "just commit / no PR
  yet".
- **Watch your own PRs by subscription + one scheduled check.** Subscribe on open
  (automatic in Claude Code, else `subscribe_pr_activity` where `claude-code-remote` has
  it; Antigravity relies on the check alone). It misses CI success, pushes, the merge,
  Codex's `+1` and its silence, so keep exactly one relative-delay check armed
  (`send_later`; in Antigravity `schedule` with `DurationSeconds`, canceled via
  `manage_task` `kill`): minutes while CI or the verdict is out or after a push, longer
  once only a human is left. Settle a fired check first (update a survivor, replace a
  retired one); re-time a wrong fire time or say the watch isn't armed; name the PR, not
  a SHA. Under drive, arm auto-merge only where the ruleset requires the Codex verdict AND
  resolved conversations.
- **Read `mergeable_state` at every check, wake and drive step**: `dirty`, or `behind`
  where required → fetch base and head by refspec, unshallow, rebase onto the fetched
  `origin/<base>` (not always `main`), `--force-with-lease` push unasked — once sure your
  branch has every remote head commit and the head hasn't moved since the tip you noted
  before fetching; otherwise stop and ask.
- **Wake PRs a merge leaves behind.** First turn after your PR merges, message every other
  open PR on that base whose body ends with a session URL: name that PR, say only that its
  base now points at `<sha>`, whatever its state reads (name no merge or other PR). Skip
  with no session URL or only local subagent messaging; don't retry. Receiving one: test
  and rebase per `AGENTS-REFERENCE.md` § Waking PRs.
- **On merge or close**, one last reply-and-resolve pass; real work on a merged PR goes to
  a follow-up PR named on the thread (closed-unmerged: open nothing). Then cancel the check
  and unsubscribe, if subscribed, matching this session and PR (`list_triggers` spans the
  account).
- **A scheduler or GitHub prompt is said once, then carry on.**
- **"Drive"**: take the next actionable `TODO.md` item (not deferred or awaiting a product
  decision), implement, open the PR, wait for Codex, address every comment, merge on
  green CI plus the head's verdict (*drive to merge*), repeat until done or stopped.
- **A red baseline is the next task**: `npm test`, `npm run lint`, `npm run typecheck`
  green before pulling from `TODO.md`, fixed in its own first commit; skipping a failure
  as unrelated needs the user's confirmation.
- **"Autopilot"**: drive without blocking — take the cheapest-to-undo guess and log it
  under `TODO.md` *Decisions needing review* (decision, alternative, why reversible); it
  outranks stop-and-wait. The loop's steps (commit, push, PR, reading CI/review, arming
  the check, merging green) are authorized. Still waiting for a real answer: destructive
  or irreversible actions outside the loop, anything reaching beyond this repo (a Supabase
  migration or deploy included), *Safe vs. risky*'s ask-first list, guardrail 13's
  copy, skipping a red baseline, and privacy uncertainty (an email, `auth.uid()`, key,
  `secret_url`).

## Pull requests and Codex reviews

- Prefer `mcp__github__*` tools where mounted (Claude Code requires them); else `gh`. Open
  PRs ready for review. Link every open PR in a feature, one per line.
- **Codex is the automated reviewer** (not Copilot), triggered automatically; request it
  only to confirm a rebutted false positive or as the verdict rule allows. **Address
  every comment unasked**, any reviewer's: fix and fold into its commit (group
  same-topic fixes), or decline with reasons. Push, reply citing the sha, then resolve
  once fixed or rebutted, one thread at a time (`resolve_review_thread`, or `gh api
  graphql` `resolveReviewThread`, takes `PRRT_*` from `review_threads[].id`, not
  `PRRC_*`); anything still to do stays open. An acknowledgment isn't an answer.
- **Judge comments on merit.** A cited rule is a reading — check what it says; Codex
  over-reads privacy rules, quietly costing capability: quote and decline rather than
  narrow the code (a genuine conflict is the maintainer's call), then poke as the verdict
  rule allows or let the next push; escalate if it re-raises.
- **A second verified finding in one mechanism is a design question**: would an existing
  design (guardrail 12) or a new one delete the class? Say so on the thread; the
  maintainer decides, autopilot included.
- **Defer a real-but-out-of-scope finding**: push a `TODO.md` entry, reply citing the sha,
  resolve (a threadless finding skips only the resolve); escalate if the re-review
  re-raises it.
- **Read the Codex verdict, don't infer it**: its PR-body reaction (`eyes` reading, `+1`
  clean, revoked on push; `+1` + green CI = merge; leave body reactions to Codex); a
  no-findings review of the head says the same, but only the reaction clears the status.
  Read review comments, top-level comments and reviews to the last page; findings block
  until fixed, rebutted or deferred. A clean review with no reaction, or an unanswered
  rebuttal → `@codex review` five minutes on; nothing five minutes after the push, or
  stuck at running (👀) ten minutes → poke. A poke that hangs the same way gets a second
  an hour later; escalate only if that one hangs too, never after one (maintainer,
  2026-10-22).
- **Once Codex +1s a head, make no unnecessary change without asking** (maintainer,
  2026-10-13); rebases for `dirty`/required `behind`, red-CI fixes and drive/autopilot
  steps proceed. Don't merge ahead of the verdict, and don't ask whether to merge.
- **Report each review in your next message**, any reviewer's, past *keep replies short*:
  commit read (say if no longer the head), finding count, one bullet per finding, most
  blocking first; ask only the most blocking question.
- **Ordered work ("next", "then", "after that", "follow-up")** may open in parallel but
  merges only after every earlier session item and named PR has merged (any repo, no time
  cap; hold and ask if one stalls, autopilot included; no auto-merge until then; read the
  list from the session's record).
- Skip your own webhook echoes silently (did *I* just post this body?).

## Node version

- **The Node major (24) in `.nvmrc`, `engines.node` and `@types/node` moves together**,
  in one commit (`nodeVersion.test.ts` reads the lockfile-**resolved** `@types/node`).
  `.claude/hooks/session-start.sh` provisions it, best-effort (auto-invoked only in Claude
  Code; others run it or match `.nvmrc`); it and its test are byte-identical across
  gedmap/newshacker/readmo: change all three. Detail: `AGENTS-REFERENCE.md`.

## Dependency updates

- **The weekly batch lives in mikelward/npm-update** (thin caller; `regenerate` runs
  `npm run import-map:sync`): fix the mechanism there; no batch PR → read its run log.
  **Auto-merge only minors and patches on green CI**; majors and `0.x` wait for review; a
  red or skipped check is a stop sign. Renovate is off (`renovate.test.ts`; config
  dormant) and can't bump Node. Dependabot security updates are off: an advisory is a
  hand bump with any peer-pinned partner, unless the batch carried it.
- **`.npmrc` `min-release-age` (5 days)** covers transitive deps and lockfile
  regeneration; it needs npm 11.10.0, pinned exactly (`engines.npm`, `constraints.npm`;
  raise only if required and Node 24 bundles it); `min-release-age-exclude` admits an
  urgent `npm audit fix`.
- **`supabase/functions/import_map.json` must match `package.json`** (`import_map.test.ts`).

## CI

- **Wait for CI** before claiming a change works where you can't test locally; don't
  busy-poll. Report regressions >25% or >30 s on a job under ~5 min, naming the cause.
