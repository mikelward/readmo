// @vitest-environment node
//
// Unit test for the Edge-side backfill pass. It imports the Deno module
// directly — the module is dependency-free apart from titleFilterCore.ts, and
// Vite resolves the `.ts` extension fine, so the pass is covered by `npm test`
// rather than only by a Deno job CI doesn't run over it.
//
// The compare-and-swap itself lives in SQL (apply_title_normalizations) and is
// exercised in supabase/tests/title_filters.sql against a real database. What
// is checked here is what this module decides: which rows it asks for, what it
// computes for them, and that it hands the RPC the title each value came from
// so the CAS has something to compare.
import { describe, expect, it, vi } from 'vitest';
import {
  runTitleNormalizeBackfill,
  BACKFILL_ITEMS_PER_RUN,
  type BackfillClient,
} from '../../supabase/functions/_shared/titleNormalizeBackfill.ts';
import { TITLE_NORMALIZED_VERSION } from './titleFilterCore';

interface Call {
  fn: string;
  rows: Array<Record<string, unknown>>;
}

function fakeClient(
  rows: Array<{ id: string; title: string | null }> | null,
  opts: { selectError?: string; writeError?: string; updated?: number } = {},
) {
  const calls: Call[] = [];
  let selectFilter = '';
  let limit = 0;
  const client = {
    from() {
      return {
        select() {
          return {
            or(filter: string) {
              selectFilter = filter;
              return {
                order() {
                  return {
                    limit: async (n: number) => {
                      limit = n;
                      return {
                        data: rows,
                        error: opts.selectError ? { message: opts.selectError } : null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, rows: args.p_rows as Array<Record<string, unknown>> });
      return {
        data: opts.writeError ? null : (opts.updated ?? (args.p_rows as unknown[]).length),
        error: opts.writeError ? { message: opts.writeError } : null,
      };
    },
  } as unknown as BackfillClient;
  return { client, calls, selectFilter: () => selectFilter, limit: () => limit };
}

describe('runTitleNormalizeBackfill', () => {
  it('sends the whole batch in one round trip', async () => {
    // 500 serial PostgREST updates would sit inside the poll's wall clock,
    // behind its feed loop and the spoiler pass.
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `i${i}`, title: `T ${i}` }));
    const { client, calls } = fakeClient(rows);
    const result = await runTitleNormalizeBackfill(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('apply_title_normalizations');
    expect(calls[0].rows).toHaveLength(500);
    expect(result).toEqual({ considered: 500, written: 500, failed: false });
  });

  it('computes the normalized title for each row', async () => {
    const { client, calls } = fakeClient([{ id: 'a', title: "Trump's tariffs" }]);
    await runTitleNormalizeBackfill(client);
    expect(calls[0].rows[0]).toMatchObject({
      id: 'a',
      title_normalized: ' trump s tariffs ',
      title_normalized_version: TITLE_NORMALIZED_VERSION,
    });
  });

  it('sends the title each value was computed from, for the CAS', async () => {
    // Without it the RPC has nothing to compare, and a title changing mid-pass
    // would get the OLD title's normalization written at the current version —
    // which no later batch revisits.
    const { client, calls } = fakeClient([{ id: 'a', title: 'Hello' }]);
    await runTitleNormalizeBackfill(client);
    expect(calls[0].rows[0].title).toBe('Hello');
  });

  it('passes a null title through as null so the CAS stays null-safe', async () => {
    const { client, calls } = fakeClient([{ id: 'a', title: null }]);
    await runTitleNormalizeBackfill(client);
    expect(calls[0].rows[0].title).toBeNull();
    // And it still stores the client's display fallback, not an empty string.
    expect(calls[0].rows[0].title_normalized).toBe(' untitled ');
  });

  it('stores a non-null value for a tokenless title', async () => {
    // The livelock: a NULL here keeps the row in a bounded ordered scan's
    // window every run, starving everything behind it.
    const { client, calls } = fakeClient([{ id: 'a', title: '!!! ???' }]);
    await runTitleNormalizeBackfill(client);
    expect(calls[0].rows[0].title_normalized).toBe('  ');
  });

  it('selects rows that are unnormalized OR behind the current version', async () => {
    // A version bump has to re-derive rows that already have a value. Selecting
    // only NULLs would leave every existing row on the old contract forever.
    const { client, selectFilter, limit } = fakeClient([]);
    await runTitleNormalizeBackfill(client);
    expect(selectFilter()).toContain('title_normalized_version.is.null');
    expect(selectFilter()).toContain('title_normalized_version.lt.');
    expect(limit()).toBe(BACKFILL_ITEMS_PER_RUN);
  });

  it('reports rows the RPC skipped as unwritten', async () => {
    // A title that moved under the pass fails its CAS and stays in the backlog.
    const { client } = fakeClient(
      [
        { id: 'a', title: 'One' },
        { id: 'b', title: 'Two' },
      ],
      { updated: 1 },
    );
    await expect(runTitleNormalizeBackfill(client)).resolves.toEqual({
      considered: 2,
      written: 1,
      failed: false,
    });
  });

  it('reports a write failure without throwing', async () => {
    // Soft by design, and this is also the shape of a poller deployed ahead of
    // its migration: the rows stay in the backlog and the next poll retries.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient([{ id: 'a', title: 'One' }], { writeError: 'nope' });
    await expect(runTitleNormalizeBackfill(client)).resolves.toEqual({
      considered: 1,
      written: 0,
      failed: true,
    });
    err.mockRestore();
  });

  it('reports a select failure without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(null, { selectError: 'boom' });
    await expect(runTitleNormalizeBackfill(client)).resolves.toEqual({
      considered: 0,
      written: 0,
      failed: true,
    });
    err.mockRestore();
  });

  it('makes no write call when the backlog is empty', async () => {
    const { client, calls } = fakeClient([]);
    const result = await runTitleNormalizeBackfill(client);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ considered: 0, written: 0, failed: false });
  });
});
