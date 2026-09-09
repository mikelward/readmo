// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Edge Functions' shared modules (_shared/parser.ts, sanitize.ts,
// fulltext.ts, …) import their npm deps with BARE specifiers so vitest can load
// them straight out of node_modules. Deno can't resolve a bare specifier, so
// import_map.json rewrites each to an `npm:` specifier at deploy time — which
// means THE IMPORT MAP, NOT package.json, IS WHAT THE DEPLOYED RUNTIME
// RESOLVES. If it disagrees with what the tests load, the code under test is
// not the code that runs.
//
// Nothing enforced that, and it drifted: a dependency bump moved `entities` to
// ^8.0.0 in package.json while the map stayed on ^7.0.1, so the entity-decoding
// tests for feed titles ran against 8.x while production served 7.x. The same
// gap left `fast-xml-parser` on a floor that still admitted the versions
// vulnerable to GHSA-8r6m-32jq-jx6q after package.json had moved past them.
//
// So the map is pinned to EXACT versions and compared against the version
// package-lock.json actually installs — not against package.json's range. A
// range would be too weak in both directions: there is no deno.lock, and
// `supabase functions deploy --import-map` re-resolves on every deploy, so
// `^5.10.1` lets the Edge runtime pick up a newer 5.x the tests never executed.
// Matching the lockfile is what makes "tests and Deno runtime parse
// identically" an enforced invariant instead of a comment.
//
// Neither Dependabot nor Renovate can see this file — bespoke JSON shape, no
// ecosystem behind it — so an automated bump edits package.json and the
// lockfile and silently leaves the map behind. This test is the backstop that
// turns that into a CI failure, whichever bot does the bump; the assertion
// message names the version to write.

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

interface Lockfile {
  packages: Record<string, { version?: string }>;
}

const lock = JSON.parse(read('../../package-lock.json')) as Lockfile;
const importMapSource = read('./import_map.json');
const imports = (
  JSON.parse(importMapSource) as { imports: Record<string, string> }
).imports;

/** The version npm actually installed for `name` (what vitest loads). */
function installedVersion(name: string): string | undefined {
  return lock.packages[`node_modules/${name}`]?.version;
}

describe('supabase/functions/import_map.json', () => {
  const entries = Object.entries(imports);

  it('maps at least one specifier', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)(
    'pins %s to the exact version the lockfile installs',
    (specifier, target) => {
      expect(target, `${specifier} must map to an npm: specifier`).toMatch(/^npm:/);

      // `npm:<name>@<version>` — the name may be scoped (@scope/pkg), so split
      // on the LAST '@' rather than the first.
      const withoutScheme = target.replace(/^npm:/, '');
      const at = withoutScheme.lastIndexOf('@');
      expect(at, `${target} carries no version`).toBeGreaterThan(0);
      const name = withoutScheme.slice(0, at);
      const version = withoutScheme.slice(at + 1);

      expect(name, `${specifier} maps to a different package`).toBe(specifier);

      // Exact, not a range: `^x.y.z` re-resolves on every deploy (there is no
      // deno.lock), so the runtime could run a version CI never executed.
      expect(
        version,
        `${name} is pinned as "${version}" — the import map must use an EXACT ` +
          'version, not a range, or the Edge runtime can resolve a version the ' +
          'tests never ran',
      ).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

      const installed = installedVersion(name);
      expect(
        installed,
        `${name} is in the import map but not installed — add it to package.json, or drop the mapping`,
      ).toBeDefined();
      expect(
        version,
        `${name} is ${version} in the import map but the lockfile installs ${installed}; ` +
          `the deployed Deno runtime would run a different version than the tests. ` +
          `Update supabase/functions/import_map.json to ${installed}.`,
      ).toBe(installed);
    },
  );
});

// The guard above only fails AFTER a bump has already landed the two files out
// of step. Renovate's custom manager (renovate.json → customManagers) is what
// keeps them in step in the first place, by editing the map in the same PR as
// package.json. That manager reaches this file through a hand-written regex, so
// it can silently stop matching — add a mapping in a shape the regex misses and
// Renovate just stops managing it, with no signal until the parity test fires
// on some later bump. Assert the regex still sees exactly what we pin.

interface RenovateConfig {
  customManagers?: Array<{
    managerFilePatterns?: string[];
    matchStrings?: string[];
  }>;
}

describe('renovate.json custom manager for the import map', () => {
  const renovate = JSON.parse(read('../../renovate.json')) as RenovateConfig;
  const manager = renovate.customManagers?.find((m) =>
    m.managerFilePatterns?.some((p) => p.includes('import_map')),
  );

  it('is configured', () => {
    expect(
      manager,
      'renovate.json has no customManager targeting supabase/functions/import_map.json — ' +
        'without it a dependency bump updates package.json but not the map, and CI goes ' +
        'red on the parity assertion above',
    ).toBeDefined();
    expect(manager?.matchStrings?.length ?? 0).toBeGreaterThan(0);
  });

  it('still matches every pin in the import map', () => {
    const found = new Map<string, string>();
    for (const source of manager?.matchStrings ?? []) {
      const re = new RegExp(source, 'g');
      for (const m of importMapSource.matchAll(re)) {
        const { depName, currentValue } = m.groups ?? {};
        if (depName && currentValue) found.set(depName, currentValue);
      }
    }
    // Every mapped specifier must be visible to Renovate, at the same version.
    const expected = Object.fromEntries(
      Object.entries(imports).map(([specifier, target]) => {
        const withoutScheme = target.replace(/^npm:/, '');
        return [specifier, withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1)];
      }),
    );
    expect(
      Object.fromEntries(found),
      "the customManager regex no longer captures every import-map pin, so Renovate " +
        'would stop bumping the ones it misses',
    ).toEqual(expected);
  });
});
