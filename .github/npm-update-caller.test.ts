// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The weekly npm-update workflow is the only automation left on the
// dependency path now that Renovate is disabled (AGENTS.md "Dependency
// updates"), and it runs unattended every week — a workflow that has
// silently stopped doing its job looks exactly like a week with no updates
// available.
//
// workflows/npm-update.yml is now a thin caller into
// mikelward/npm-update's reusable workflow (see AGENTS.md "Dependency
// updates"): the update/publish mechanism itself is tested in that
// repository, not here. What's left to guard here is what this repo still
// owns — the schedule, the manual trigger, the permission grant, which
// reusable workflow it calls, the regenerate wiring that keeps the Deno
// import map in sync, and the ci.yml/codex-review-check.yml dispatch
// contracts the hub's publish job depends on — since nothing in
// mikelward/npm-update's own suite can see this file. Ported from
// newshacker's equivalent test (same migration, same gaps its own review
// found).

const workflow = readFileSync(fileURLToPath(new URL('./workflows/npm-update.yml', import.meta.url)), 'utf8');
const ci = readFileSync(fileURLToPath(new URL('./workflows/ci.yml', import.meta.url)), 'utf8');
const consumerCheck = readFileSync(
  fileURLToPath(new URL('./workflows/codex-review-check.yml', import.meta.url)),
  'utf8',
);
const zizmor = readFileSync(fileURLToPath(new URL('./workflows/zizmor.yml', import.meta.url)), 'utf8');

describe('npm-update caller', () => {
  it('can be run by hand as well as on the schedule', () => {
    // Without workflow_dispatch the only way to run it is to wait for
    // Saturday, or push a commit editing the cron — which is how a
    // scheduled job becomes a job nobody can test.
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('runs on a schedule, on Saturdays', () => {
    // The DAY is the decision and is asserted; the hour and the
    // deliberately off-the-hour minute are tuning, so they stay free.
    const cron = workflow.match(/^\s*- cron: '(.+)'/m);
    expect(cron).not.toBeNull();
    expect(cron![1].trim().split(/\s+/)[4]).toBe('6');
  });

  it('calls the hub reusable workflow at @main', () => {
    expect(workflow).toContain(
      'uses: mikelward/npm-update/.github/workflows/npm-update.yml@main',
    );
  });

  it('grants exactly the permissions the hub jobs need, no more, no less', () => {
    // The hub's own workflow_call block carries no top-level permissions —
    // this caller's grant is the ceiling every job downscopes from. Not
    // anchored to end-of-file here (unlike newshacker's equivalent test):
    // this workflow's permissions block is followed by the `with:` block,
    // not EOF, so the anchor is the start of `with:` instead — a fourth
    // scope appended after `actions: write` still fails this either way.
    const jobs = workflow.slice(workflow.indexOf('\njobs:'));
    expect(jobs).toMatch(
      /permissions:\n {6}contents: write\n {6}pull-requests: write\n {6}actions: write\n {4}with:/,
    );
  });

  it('serializes runs so a slow run cannot overlap the next schedule', () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: npm-update\n {2}cancel-in-progress: false\n/m);
  });

  it('keeps the Deno import map in sync with the lockfile', () => {
    // The Edge runtime resolves supabase/functions/import_map.json, not
    // package.json, and import_map.test.ts (run by the dispatched ci.yml)
    // fails when the two disagree — the Renovate custom manager that used
    // to keep them in step is gone (AGENTS.md "Dependency updates"), so
    // without this hook every bump of a mapped package opens a PR that's
    // red on arrival.
    expect(workflow).toContain('regenerate: npm run import-map:sync');
    expect(workflow).toContain('regenerated-files: supabase/functions/import_map.json');
  });

  it("keeps ci.yml dispatchable, naming the PR the hub's publish job reports for", () => {
    // The weekly PR is opened by GITHUB_TOKEN, which never fires
    // `on: pull_request` — the hub's publish job works around that by
    // dispatching ci.yml against the pushed branch with
    // `gh workflow run ci.yml -f pr="$pr"`, which *requires* ci.yml to
    // declare workflow_dispatch with a `pr` input (gh rejects an -f for an
    // input the target workflow never declared). Losing either one leaves
    // the weekly PR dispatched-but-uncovered while npm test stays green —
    // and here that PR is the only thing that runs the Deno edge checks
    // against a freshly regenerated import map.
    expect(ci).toMatch(/^\s*workflow_dispatch:/m);
    expect(ci).toMatch(/^\s*inputs:\n\s*pr:/m);
  });

  it('keeps codex-review-check.yml dispatchable too', () => {
    // Same class of gap as the sibling ci.yml check above, for the other
    // workflow the hub's publish job dispatches (`gh workflow run
    // codex-review-check.yml --ref "$branch"`, no `pr` input needed).
    // Losing this trigger leaves the weekly PR's Codex pin unverified with
    // no error anywhere: the dispatch just silently has nothing to start.
    expect(consumerCheck).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('declares zizmor.yml for dispatch, and keeps it dispatchable', () => {
    // The third required check, and the only one the hub does NOT dispatch
    // unconditionally — so both halves live here and both are load-bearing.
    // Drop the declaration and the weekly PR sits pending forever on a
    // required `zizmor` nothing starts; drop the trigger and the hub's
    // `gh workflow run zizmor.yml` finds nothing to run, which the batch
    // reports in its PR body but cannot fix. Neither half fails anything on
    // an ordinary PR, where `pull_request` still starts the scan — the gap
    // only opens on the GITHUB_TOKEN-authored batch, once a week,
    // unattended.
    expect(workflow).toContain('dispatch-workflows: zizmor.yml');
    expect(zizmor).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('keeps zizmor unfiltered by path, now that it is required', () => {
    // A workflow skipped by a `paths:` filter creates no check run at all,
    // and a ruleset waits on a missing required check rather than passing
    // it — so a filter here would make every PR touching only src/ or
    // supabase/ permanently unmergeable. Asserted because the filter was
    // removed by hand and nothing else would notice it coming back.
    expect(zizmor).not.toMatch(/^\s*paths:/m);
  });
});
