// @vitest-environment node
//
// The client and the Edge runtime each get their own copy of the title
// normalizer, and the whole design rests on them producing the same string:
// the poller writes items.title_normalized with one copy, the feed list filters
// with the other, and a divergence shows up as the badge and the list
// disagreeing about a row — invisible until someone notices an article missing.
//
// Copies rather than an import for the reason AGENTS.md records under the
// Vercel `api/` gotcha: cross-tree imports pass every local check and fail at
// deploy. This test is what makes the copy safe, so it compares BYTES rather
// than behavior — a behavioral test would pass while the two files drifted in a
// case it didn't cover.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CLIENT = new URL('./titleFilterCore.ts', import.meta.url);
const EDGE = new URL(
  '../../supabase/functions/_shared/titleFilterCore.ts',
  import.meta.url,
);

describe('titleFilterCore copies', () => {
  it('are byte-identical', () => {
    const client = readFileSync(CLIENT);
    const edge = readFileSync(EDGE);
    expect(
      edge.equals(client),
      'src/lib/titleFilterCore.ts and supabase/functions/_shared/titleFilterCore.ts have ' +
        'diverged. Copy one over the other — they are duplicated on purpose ' +
        '(see the module header), and the feed RPCs match against a value the ' +
        'Edge copy produced.',
    ).toBe(true);
  });

  it('has no imports, so the copies can stay byte-identical', () => {
    // Deno needs `.ts` extensions and the bundler must not; any import at all
    // would make one of the two copies wrong. Asserted here rather than left to
    // whoever next adds a helper.
    const source = readFileSync(CLIENT, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
