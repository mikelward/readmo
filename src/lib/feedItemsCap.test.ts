// @vitest-environment node
//
// The server-side page-size ceiling and the client's largest offered page size
// are one number in two places, and a split is silent in the worst way: a new
// *Articles per page* option above the cap would look right in Settings, pass
// every UI test, and then be quietly truncated by the RPC — the reader gets a
// short page and a "More" that pages from the wrong offset, with nothing
// failing anywhere. So assert the SQL against the TypeScript.
//
// Read from the migration rather than a hand-copied constant: the migration is
// what actually runs. Whichever migration most recently defines `feed_items`
// wins, so a later redefinition that forgets the clamp fails here too.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARTICLES_PER_PAGE_OPTIONS } from './types';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations');

/** The SQL of the last migration that (re)defines `public.feed_items`. */
function latestFeedItemsSql(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (sql.includes('function public.feed_items(\n')) return { file, sql };
  }
  throw new Error('no migration defines public.feed_items');
}

describe('feed_items page-size clamp', () => {
  it('caps the flat page at the largest size the picker offers', () => {
    const { sql } = latestFeedItemsSql();
    const largest = Math.max(...ARTICLES_PER_PAGE_OPTIONS);
    // The flat arm of the shape-dependent ceiling.
    expect(sql).toMatch(
      new RegExp(
        `case when coalesce\\(p_group_by_feed, false\\) then \\d+ else ${largest} end`,
      ),
    );
  });

  it('bounds p_limit from above, not just below', () => {
    const { sql } = latestFeedItemsSql();
    // `greatest(...)` alone is a floor; the ceiling is the `least(...)` around
    // it. Asserted separately so removing the clamp fails even if someone
    // leaves a matching literal elsewhere in the file.
    expect(sql).toMatch(/limit\s+least\(\s*greatest\(coalesce\(p_limit/);
  });

  it('leaves the grouped read its own, larger ceiling', () => {
    const { sql } = latestFeedItemsSql();
    // The grouped read deliberately asks for every section in one deep page,
    // so it must not be clamped to the flat page size.
    const grouped = sql.match(
      /case when coalesce\(p_group_by_feed, false\) then (\d+) else (\d+) end/,
    );
    expect(grouped).not.toBeNull();
    expect(Number(grouped![1])).toBeGreaterThan(Number(grouped![2]));
  });
});
