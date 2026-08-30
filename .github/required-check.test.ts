// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Pins the one job whose name the branch ruleset requires.
//
// The failure mode is silent and total: the ruleset waits on a status by
// NAME, so renaming the job, renaming its `name:`, or deleting it leaves
// every pull request pending on a check nothing reports -- and nothing else
// in the repo notices, because a workflow that never runs the job is still
// valid YAML and the suite is still green. This file is what makes that edit
// fail here instead of on the next PR that tries to merge.
//
// It also pins the wiring, not just the name: the check's whole value is
// that it re-derives the lane verdict itself (`mode: gate`) after the heavy
// jobs report, so a `lanes` job that ran without `needs` or with classify's
// output trusted in place of its own re-derivation would report green
// under the required name while gating nothing.
//
// Read as regexes over YAML, the same tradeoff the sibling
// lanes-policy.test.ts makes: a real parser is unnecessary weight for
// pinning exact strings a human wrote and a human will edit.
//
// Replaced workflow-check-rename.test.ts, which pinned `gate` and `lanes`
// to each other through the rename overlap (mikelward/lanes#9) and had
// nothing to say once `gate` was deleted.

const workflow = readFileSync(fileURLToPath(new URL('./workflows/ci.yml', import.meta.url)), 'utf8');

// A job block runs from its "  <key>:" line to the line before the next one
// at the same (two-space) indent, or EOF.
function jobBlock(text: string, key: string): string {
  const start = text.indexOf(`\n  ${key}:\n`);
  expect(start, `job "${key}" not found in ci.yml`).not.toBe(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(rest.indexOf('\n') + 1).search(/\n {2}\S/);
  const end = next === -1 ? text.length : start + 1 + rest.indexOf('\n') + 1 + next;
  return text.slice(start + 1, end);
}

describe('the required lanes check', () => {
  it('is defined, and reports under the name the ruleset requires', () => {
    expect(
      workflow,
      'the ruleset requires a status named `lanes`; renaming or deleting this job leaves every PR pending on a check nothing reports',
    ).toMatch(/\n {2}lanes:\n {4}name: lanes\n/);
  });

  it('runs the gate mode after the heavy jobs, and always reports', () => {
    const block = jobBlock(workflow, 'lanes');
    // `if: always()` is what makes it report on a skipped or failed heavy
    // job instead of being skipped itself -- and GitHub counts a SKIPPED
    // required check as satisfied, so losing this line turns a red verdict
    // into a silent pass.
    expect(block).toMatch(/\n {4}if: always\(\)\n/);
    expect(block).toMatch(/\n {4}needs: \[classify, build, edge\]\n/);
    expect(block).toMatch(/\n {6}- uses: mikelward\/lanes@main\n/);
    expect(block).toMatch(/\n {10}mode: gate\n/);
    // Every heavy job's result reaches the gate; one dropped from here is a
    // job whose failure the required check would stop seeing.
    expect(block).toMatch(/build=\$\{\{ needs\.build\.result \}\}/);
    expect(block).toMatch(/edge=\$\{\{ needs\.edge\.result \}\}/);
  });

  it('is the only job reporting under that name', () => {
    expect(workflow.match(/\n {4}name: lanes\n/g)).toHaveLength(1);
  });
});
