// Duplicate-migration-id guard for supabase/migrations/.
//
// Every migration file is named `<id>_<slug>.sql` where `<id>` is a 4-digit,
// zero-padded, monotonically increasing version (0001, 0002, …). Supabase
// tracks applied migrations by that version in
// `supabase_migrations.schema_migrations`, whose primary key is the version —
// so two files sharing an id cannot both be applied: `supabase db push`
// applies one, then the second collides with
// `duplicate key value violates unique constraint "schema_migrations_pkey"`.
//
// The collision is easy to create and invisible until deploy: two branches
// each cut from the same latest migration pick the same next number, both
// merge, and nothing complains until someone runs `make migrate`. This guard
// catches it at PR time (checkMigrationIds.test.ts asserts no duplicates) and
// at commit time (the .githooks/pre-commit hook runs this script).
//
//   node scripts/checkMigrationIds.mjs        (exit 1 on duplicate/invalid ids)
//
// Cost/reliability (guardrail #5): no network, no third-party service — it only
// reads filenames off disk. Negligible.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

/** A migration filename must be `<4+ digits>_<slug>.sql`. */
const MIGRATION_RE = /^(\d{4,})_.+\.sql$/;

/**
 * Inspect a list of migration filenames (not paths) and report problems.
 * Pure so it can be unit-tested without touching the filesystem.
 *
 * @param {string[]} filenames
 * @returns {{ duplicates: Array<{ id: string, files: string[] }>, invalid: string[] }}
 *   `duplicates` — one entry per id used by more than one file, files sorted.
 *   `invalid`    — filenames that don't match the `<id>_<slug>.sql` convention.
 */
export function findMigrationIdProblems(filenames) {
  const byId = new Map();
  const invalid = [];

  for (const name of filenames) {
    const m = MIGRATION_RE.exec(name);
    if (!m) {
      invalid.push(name);
      continue;
    }
    const id = m[1];
    const files = byId.get(id);
    if (files) files.push(name);
    else byId.set(id, [name]);
  }

  const duplicates = [];
  for (const [id, files] of byId) {
    if (files.length > 1) {
      duplicates.push({ id, files: [...files].sort() });
    }
  }
  duplicates.sort((a, b) => a.id.localeCompare(b.id));

  return { duplicates, invalid: invalid.sort() };
}

/** Read the real migrations directory and run the check over it. */
export function checkMigrationsDir(dir = MIGRATIONS_DIR) {
  const filenames = readdirSync(dir).filter((n) => n.endsWith('.sql'));
  return findMigrationIdProblems(filenames);
}

// CLI: exit non-zero on any problem so a commit hook or CI job can gate on it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { duplicates, invalid } = checkMigrationsDir();

  if (duplicates.length === 0 && invalid.length === 0) {
    console.log('migration ids: OK (no duplicates)');
    process.exit(0);
  }

  for (const { id, files } of duplicates) {
    console.error(
      `Duplicate migration id ${id} used by ${files.length} files:\n` +
        files.map((f) => `  - ${f}`).join('\n') +
        `\nRenumber the not-yet-applied one to the next free id.`,
    );
  }
  for (const name of invalid) {
    console.error(`Malformed migration filename (expected <NNNN>_<slug>.sql): ${name}`);
  }
  process.exit(1);
}
