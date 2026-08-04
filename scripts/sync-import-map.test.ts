// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs helper, no type declarations by design
import { syncImportMap } from './sync-import-map.mjs';

// import_map.test.ts asserts the map and the lockfile agree; this asserts the
// thing that MAKES them agree. Renovate's custom manager used to do it and is
// now disabled, so this script is the only automation left on that path — the
// monthly dependency-update workflow runs it after `npm update`.
//
// Fixtures are hand-written rather than derived from the real files: a test
// built from the repo's own current state passes trivially and would keep
// passing if the function became a no-op.

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const lockOf = (versions: Record<string, string>): string =>
  JSON.stringify({
    packages: Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [
        `node_modules/${name}`,
        { version },
      ]),
    ),
  });

const mapOf = (targets: Record<string, string>): string =>
  JSON.stringify({ imports: targets }, null, 2) + '\n';

describe('syncImportMap', () => {
  it('rewrites a stale version to what the lockfile installs', () => {
    const { source, changed } = syncImportMap({
      mapSource: mapOf({ entities: 'npm:entities@8.0.0' }),
      lockSource: lockOf({ entities: '8.1.2' }),
    });

    expect(changed).toEqual([{ name: 'entities', from: '8.0.0', to: '8.1.2' }]);
    expect(JSON.parse(source).imports.entities).toBe('npm:entities@8.1.2');
  });

  it('leaves a version that already matches alone', () => {
    const { source, changed } = syncImportMap({
      mapSource: mapOf({ entities: 'npm:entities@8.1.2' }),
      lockSource: lockOf({ entities: '8.1.2' }),
    });

    expect(changed).toEqual([]);
    expect(source).toBe(mapOf({ entities: 'npm:entities@8.1.2' }));
  });

  it('splits a scoped name on the last @, not the first', () => {
    // `@scope/pkg@1.0.0` carries two @s. Splitting on the first yields an empty
    // package name and a version of `scope/pkg@1.0.0`, which silently matches
    // nothing in the lockfile and leaves the pin stale.
    const { changed } = syncImportMap({
      mapSource: mapOf({ '@mozilla/readability': 'npm:@mozilla/readability@0.6.0' }),
      lockSource: lockOf({ '@mozilla/readability': '0.6.1' }),
    });

    expect(changed).toEqual([
      { name: '@mozilla/readability', from: '0.6.0', to: '0.6.1' },
    ]);
  });

  it('reports a mapping with nothing installed instead of rewriting it', () => {
    const { source, changed, missing } = syncImportMap({
      mapSource: mapOf({ ghost: 'npm:ghost@1.0.0' }),
      lockSource: lockOf({ entities: '8.1.2' }),
    });

    expect(missing).toEqual(['ghost']);
    expect(changed).toEqual([]);
    expect(source).toBe(mapOf({ ghost: 'npm:ghost@1.0.0' }));
  });

  it('preserves formatting and rewrites only the versions that moved', () => {
    // A JSON round-trip would reformat the whole file, burying one version bump
    // in a full-file diff. The replacement is targeted for that reason.
    const mapSource = [
      '{',
      '  "imports": {',
      '    "entities": "npm:entities@8.0.0",',
      '    "sanitize-html": "npm:sanitize-html@2.17.6"',
      '  }',
      '}',
      '',
    ].join('\n');

    const { source } = syncImportMap({
      mapSource,
      lockSource: lockOf({ entities: '8.1.2', 'sanitize-html': '2.17.6' }),
    });

    expect(source).toBe(mapSource.replace('entities@8.0.0', 'entities@8.1.2'));
  });

  it('leaves a non-npm specifier untouched', () => {
    const mapSource = mapOf({ 'std/': 'https://deno.land/std@0.224.0/' });
    const { source, changed } = syncImportMap({
      mapSource,
      lockSource: lockOf({ entities: '8.1.2' }),
    });

    expect(changed).toEqual([]);
    expect(source).toBe(mapSource);
  });

  it('is a no-op against the repo as it stands', () => {
    // The parity test would already be red otherwise, but this ties the two
    // together: whatever import_map.test.ts demands, running the script
    // produces.
    const { changed, missing } = syncImportMap({
      mapSource: read('../supabase/functions/import_map.json'),
      lockSource: read('../package-lock.json'),
    });

    expect(missing).toEqual([]);
    expect(changed).toEqual([]);
  });
});
