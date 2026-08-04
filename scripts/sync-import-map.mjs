// Rewrites the exact versions in supabase/functions/import_map.json to match
// what package-lock.json installs.
//
// import_map.test.ts asserts those two agree, because the map — not
// package.json — is what the deployed Deno runtime resolves. Renovate's custom
// regex manager used to keep them in step by editing the map in the same PR as
// package.json; Renovate is disabled now (see AGENTS.md "Dependency updates"),
// so nothing did that automatically and every bump of a mapped package would
// land the parity test red.
//
// The monthly dependency-update workflow runs this after `npm update`. Run it
// by hand after any manual bump that touches a mapped package:
//
//   npm run import-map:sync
//
// Versions are patched as targeted string replacements rather than by
// round-tripping the JSON, so the file's formatting and key order survive
// untouched and the diff shows only the versions that actually moved.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const MAP = path('../supabase/functions/import_map.json');
const LOCK = path('../package-lock.json');

/**
 * Splits an `npm:` target into package name and version. The separator is the
 * LAST `@`, since a scoped name carries one of its own (`npm:@scope/pkg@1.2.3`).
 */
const parseTarget = (target) => {
  const spec = target.slice('npm:'.length);
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
};

export function syncImportMap({ mapSource, lockSource }) {
  const lock = JSON.parse(lockSource);
  const { imports } = JSON.parse(mapSource);

  let out = mapSource;
  const changed = [];
  const missing = [];

  for (const target of Object.values(imports)) {
    if (!target.startsWith('npm:')) continue;
    const parsed = parseTarget(target);
    if (!parsed) continue;

    const installed = lock.packages?.[`node_modules/${parsed.name}`]?.version;
    if (!installed) {
      // Mapped but not installed. Not this script's call to make — dropping the
      // mapping or adding the dependency is a real decision — so surface it and
      // let import_map.test.ts fail loudly rather than silently rewriting.
      missing.push(parsed.name);
      continue;
    }
    if (installed === parsed.version) continue;

    const next = `npm:${parsed.name}@${installed}`;
    // Whole-string match including the quotes: a bare version substring could
    // appear inside another package's version or name.
    const before = out;
    out = out.replaceAll(`"${target}"`, `"${next}"`);
    if (out === before) {
      throw new Error(`could not locate ${target} in import_map.json to rewrite`);
    }
    changed.push({ name: parsed.name, from: parsed.version, to: installed });
  }

  return { source: out, changed, missing };
}

// Only run when invoked directly, so the test can import the pure function.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { source, changed, missing } = syncImportMap({
    mapSource: readFileSync(MAP, 'utf8'),
    lockSource: readFileSync(LOCK, 'utf8'),
  });

  for (const name of missing) {
    console.warn(
      `warning: ${name} is in the import map but not in the lockfile — ` +
        'add it to package.json or drop the mapping',
    );
  }

  if (changed.length === 0) {
    console.log('import_map.json already matches the lockfile.');
  } else {
    writeFileSync(MAP, source);
    for (const { name, from, to } of changed) {
      console.log(`${name} ${from} -> ${to}`);
    }
  }

  // A mapping with nothing installed behind it is a real problem, and exiting 0
  // here would let the workflow open a PR that fails the parity test anyway.
  process.exitCode = missing.length > 0 ? 1 : 0;
}
