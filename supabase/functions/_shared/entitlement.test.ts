// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  FREE_ENTITLEMENT,
  GRACE_PERIOD_MS,
  loadEntitlement,
  resolveEntitlement,
  type EntitlementDbClient,
  type EntitlementRow,
} from './entitlement.ts';

const NOW = Date.parse('2026-09-03T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** Build a stub client whose entitlements read resolves to the given row (or
 * an error). Records the arguments so a test can assert the query is scoped to
 * one user rather than reading the table. */
function stubClient(result: { data?: EntitlementRow | null; error?: unknown }) {
  const calls: Array<{ table: string; columns: string; column: string; value: string }> = [];
  const client: EntitlementDbClient = {
    from(table: string) {
      return {
        select: (columns: string) => ({
          eq: (column: string, value: string) => ({
            maybeSingle: () => {
              calls.push({ table, columns, column, value });
              return Promise.resolve({
                data: result.data ?? null,
                error: result.error ?? null,
              });
            },
          }),
        }),
      };
    },
  };
  return { client, calls };
}

describe('resolveEntitlement', () => {
  // The distinction the whole spine turns on. Once the table exists and is
  // backfilled, an absent row is a NEW SIGNUP, not an old backend — reading it
  // as "current behavior" would hand every future free account the legacy
  // allowance permanently, and the backfill would mask it.
  it('treats a missing row as the free tier, not as legacy behavior', () => {
    expect(resolveEntitlement(null, NOW)).toEqual(FREE_ENTITLEMENT);
    expect(resolveEntitlement(undefined, NOW)).toEqual(FREE_ENTITLEMENT);
  });

  it('keeps the free tier on today’s feed cap so the spine is a no-op on deploy', () => {
    // subscribe_to_feed hard-codes 100 (0059); a lower free cap would shrink
    // what a new account may do the moment the migration applies.
    expect(FREE_ENTITLEMENT.feedCap).toBe(100);
    expect(resolveEntitlement({ tier: 'free' }, NOW).feedCap).toBe(100);
  });

  it('resolves a live paid row to paid', () => {
    const row = { tier: 'paid', status: 'active', current_period_end: iso(60_000) };
    expect(resolveEntitlement(row, NOW)).toEqual({
      tier: 'paid',
      feedCap: 100,
      inGrace: false,
    });
  });

  it('carries a per-account feed cap', () => {
    expect(resolveEntitlement({ tier: 'paid', feed_cap: 500 }, NOW).feedCap).toBe(500);
    expect(resolveEntitlement({ tier: 'free', feed_cap: 25 }, NOW).feedCap).toBe(25);
  });

  it('falls back to the default cap when the stored one is unusable', () => {
    for (const feed_cap of [0, -1, Number.NaN, null, undefined]) {
      expect(resolveEntitlement({ tier: 'free', feed_cap }, NOW).feedCap).toBe(100);
    }
  });

  // A dropped webhook or a slow renewal must not lock out someone who paid.
  it('holds a just-lapsed paid row open, and says it is in grace', () => {
    const row = { tier: 'paid', current_period_end: iso(-GRACE_PERIOD_MS + 1000) };
    expect(resolveEntitlement(row, NOW)).toEqual({
      tier: 'paid',
      feedCap: 100,
      inGrace: true,
    });
  });

  it('drops to free once the grace window has passed', () => {
    const row = { tier: 'paid', current_period_end: iso(-GRACE_PERIOD_MS - 1000) };
    expect(resolveEntitlement(row, NOW)).toEqual(FREE_ENTITLEMENT);
  });

  // The raised cap belongs to the tier that bought it. Keeping it would leave
  // a lapsed account on its paid limit forever — most likely precisely when a
  // renewal webhook never arrived, the case least likely to be noticed.
  it('drops the raised cap too, not just the tier', () => {
    const row = {
      tier: 'paid',
      feed_cap: 500,
      current_period_end: iso(-GRACE_PERIOD_MS - 1000),
    };
    expect(resolveEntitlement(row, NOW)).toEqual(FREE_ENTITLEMENT);
    expect(resolveEntitlement(row, NOW).feedCap).toBe(100);
  });

  // ...which is why an override for someone who is not subscribed lives on a
  // FREE row: there the cap is the operator's and nothing expires it.
  it('keeps a raised cap on a free row, which is how an override is expressed', () => {
    expect(resolveEntitlement({ tier: 'free', feed_cap: 500 }, NOW)).toEqual({
      tier: 'free',
      feedCap: 500,
      inGrace: false,
    });
  });

  it('treats a paid row with no period as open-ended rather than lapsed', () => {
    // A comp, or a plan not yet given a period. Nothing has ended, so there is
    // nothing to forgive — and it must not read as expired.
    expect(resolveEntitlement({ tier: 'paid', current_period_end: null }, NOW)).toEqual({
      tier: 'paid',
      feedCap: 100,
      inGrace: false,
    });
    expect(
      resolveEntitlement({ tier: 'paid', current_period_end: 'not a date' }, NOW),
    ).toEqual({ tier: 'paid', feedCap: 100, inGrace: false });
  });

  it('does not honor an unknown tier', () => {
    // The column has a CHECK constraint, but the helper must not be the thing
    // that trusts it — a future tier name reaching an old function should
    // degrade to free rather than silently granting paid.
    expect(resolveEntitlement({ tier: 'enterprise' }, NOW).tier).toBe('free');
  });
});

describe('loadEntitlement', () => {
  it('reads only the caller’s own row, and only the enforcement columns', async () => {
    const { client, calls } = stubClient({ data: { tier: 'paid' } });
    await loadEntitlement(client, 'user-1', NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('entitlements');
    expect(calls[0].column).toBe('user_id');
    expect(calls[0].value).toBe('user-1');
    // Provider ids never reach an enforcement path.
    expect(calls[0].columns).not.toContain('stripe');
  });

  it('resolves an absent row to the free tier without erroring', async () => {
    const { client } = stubClient({ data: null });
    await expect(loadEntitlement(client, 'user-1', NOW)).resolves.toEqual(FREE_ENTITLEMENT);
  });

  // Guardrail 7. An unreadable row means the status is UNKNOWN. Returning the
  // free tier would silently downgrade a paying customer mid-outage; returning
  // paid would hand out uncontrolled Gemini/Jina work exactly when the backend
  // is degraded. Neither — throw, and let the caller surface a retryable error.
  it('throws on a read error rather than guessing a tier', async () => {
    const { client } = stubClient({ error: { message: 'connection reset' } });
    await expect(loadEntitlement(client, 'user-1', NOW)).rejects.toThrow(
      /entitlement read failed: connection reset/,
    );
  });

  it('surfaces a non-Error failure shape without stringifying to [object Object]', async () => {
    // supabase-js returns a plain object, not an Error.
    const { client } = stubClient({ error: { message: 'permission denied' } });
    await expect(loadEntitlement(client, 'user-1', NOW)).rejects.toThrow(/permission denied/);
  });

  it('never puts the user id in the error message', async () => {
    // An auth.uid() is user data (AGENTS.md Privacy) and function logs leave
    // the machine.
    const { client } = stubClient({ error: { message: 'boom' } });
    await expect(loadEntitlement(client, 'secret-uid-1234', NOW)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secret-uid-1234') as unknown as string,
      }),
    );
  });
});
