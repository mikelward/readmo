// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Renovate is deliberately unscheduled and in full mode: it may open a PR the
// moment an update clears its minimumReleaseAge cooldown, instead of waiting
// for a weekly window. Every failure mode here is silent — a bot that opens
// nothing looks exactly like a repo with nothing to update, which is how this
// config sat inert from July 12 with zero PRs and zero dashboard issue.
//
//  - reintroducing a `schedule` string parks every cooled-down update until the
//    next window, so a security patch that cleared its cooldown on Sunday sits
//    for six days;
//  - DELETING `lockFileMaintenance.schedule` does not mean "any time" — that
//    option's Renovate default is `before 4am on monday`, so dropping the key
//    silently restores a weekly window rather than removing one;
//  - `mode` defaults to "full" in Renovate itself, but the Mend-hosted app
//    defaults an "All repositories" install to "silent", which suppresses PRs
//    AND the dependency dashboard. Stating it here is the repo-side half of
//    that override; the Mend UI setting is the other half and can't be tested.
//
// "at any time" is Renovate's own spelling for an unrestricted schedule; a
// typo'd variant is rejected by the schema, not silently ignored.

interface RenovateConfig {
  mode?: string;
  schedule?: string[];
  lockFileMaintenance?: { enabled?: boolean; schedule?: string[] };
}

const config = JSON.parse(
  readFileSync(new URL('./renovate.json', import.meta.url), 'utf8'),
) as RenovateConfig;

describe('renovate.json schedule', () => {
  it('opts out of silent mode', () => {
    expect(config.mode).toBe('full');
  });

  it('lets Renovate run at any time', () => {
    expect(config.schedule).toEqual(['at any time']);
  });

  it('lets lock file maintenance run at any time', () => {
    expect(config.lockFileMaintenance?.enabled).toBe(true);
    expect(config.lockFileMaintenance?.schedule).toEqual(['at any time']);
  });
});
