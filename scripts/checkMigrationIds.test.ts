// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { findMigrationIdProblems, checkMigrationsDir } from './checkMigrationIds.mjs';

describe('findMigrationIdProblems', () => {
  it('passes a clean, sequentially-numbered set', () => {
    const { duplicates, invalid } = findMigrationIdProblems([
      '0001_schema.sql',
      '0002_rls.sql',
      '0003_item_state_version.sql',
    ]);
    expect(duplicates).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it('flags two files that share an id', () => {
    // The exact collision this guard exists for: two branches both numbered
    // their migration 0027 off 0026 and both merged.
    const { duplicates } = findMigrationIdProblems([
      '0026_feed_items_omit_via_fallback.sql',
      '0027_allowlist_admin.sql',
      '0027_subscription_open_original.sql',
    ]);
    expect(duplicates).toEqual([
      {
        id: '0027',
        files: ['0027_allowlist_admin.sql', '0027_subscription_open_original.sql'],
      },
    ]);
  });

  it('reports each duplicated id once, with all colliding files sorted', () => {
    const { duplicates } = findMigrationIdProblems([
      '0002_b.sql',
      '0002_a.sql',
      '0002_c.sql',
      '0005_x.sql',
      '0005_y.sql',
    ]);
    expect(duplicates).toEqual([
      { id: '0002', files: ['0002_a.sql', '0002_b.sql', '0002_c.sql'] },
      { id: '0005', files: ['0005_x.sql', '0005_y.sql'] },
    ]);
  });

  it('flags filenames that break the <NNNN>_<slug>.sql convention', () => {
    const { invalid } = findMigrationIdProblems([
      '0001_schema.sql',
      '27_short_id.sql', // fewer than 4 digits
      'no_leading_number.sql',
      '0003-dash-not-underscore.sql',
    ]);
    expect(invalid).toEqual([
      '0003-dash-not-underscore.sql',
      '27_short_id.sql',
      'no_leading_number.sql',
    ]);
  });
});

describe('the real supabase/migrations directory', () => {
  it('has no duplicate or malformed migration ids', () => {
    const { duplicates, invalid } = checkMigrationsDir();
    expect({ duplicates, invalid }).toEqual({ duplicates: [], invalid: [] });
  });
});
