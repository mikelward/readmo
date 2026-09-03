// Per-account entitlement: which tier a caller is on, and what it allows.
//
// The commercial counterpart to `allowlist.ts`, and deliberately a separate
// module because the two answer different questions. The allowlist is a LEGAL
// gate on what Readmo may fetch and store; an entitlement is a COMMERCIAL gate
// on who has paid. A surface that needs both consults both — `summary` is
// entitlement AND allowlist — and neither ever replaces the other.
//
// The row lives in the `entitlements` table (0077), written only by the
// service role. Gate functions read it with their service-role client.
//
// Cost/reliability (guardrail #5): negligible — one primary-key read per gated
// call against a table with one row per account. No new external dependency.

/** Tiers, as stored in `entitlements.tier`. */
export type Tier = 'free' | 'paid';

/**
 * What a caller is allowed, resolved from their row.
 *
 * `tier` is what they are entitled to RIGHT NOW, which is not always what the
 * row's `tier` column says: a lapsed paid row inside the grace window still
 * resolves to `paid`, and one past it resolves to `free`.
 */
export interface Entitlement {
  tier: Tier;
  feedCap: number;
  /** True when `tier` is 'paid' only because the grace window is holding it
   * open — the period has ended and the renewal has not landed. Callers that
   * surface tier to a user can say so; enforcement treats it as paid. */
  inGrace: boolean;
}

/**
 * What the app does today, and therefore what a free account gets.
 *
 * `feedCap` matches the constant `subscribe_to_feed` hard-codes (0059). The
 * spine must be a no-op on deploy (guardrail #11): lowering the free cap to
 * create a paid differential is a separate, deliberate product decision.
 */
export const FREE_ENTITLEMENT: Entitlement = {
  tier: 'free',
  feedCap: 100,
  inGrace: false,
};

/**
 * How long a lapsed paid period keeps working.
 *
 * This covers a dropped webhook or a renewal that is merely slow — someone who
 * has paid must not be locked out because Stripe's delivery was late. It is
 * NOT a fallback for a failed read: "we couldn't check" fails closed (see
 * {@link loadEntitlement}), "we checked and it recently expired" gets this.
 * Keeping the two apart is the whole point; a single "be lenient" path would
 * hand out paid features during a database outage.
 */
export const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/* KEEP `resolveEntitlement` BELOW IN STEP WITH `get_entitlement()` in
 * `supabase/migrations/0077_entitlements.sql`, which applies the same window
 * so the tier the client displays matches the one the gates enforce. Nothing
 * can share an implementation across Deno and Postgres, so the rule is written
 * twice on purpose: change one, change the other. */

/** The columns the gate functions read. Provider ids are deliberately absent:
 * nothing on an enforcement path needs them. */
export interface EntitlementRow {
  tier?: string | null;
  status?: string | null;
  current_period_end?: string | null;
  feed_cap?: number | null;
}

/**
 * Resolve a row (or its absence) into what the caller may do now.
 *
 * A MISSING ROW IS THE FREE TIER, not legacy behavior. Once the table exists
 * and has been backfilled, an absent row means a new signup whose provisioning
 * trigger did not run — reading it as "carry on as before" would hand every
 * future free account the legacy allowance permanently, and the backfill would
 * mask it, since for the accounts that existed at deploy time it worked.
 *
 * The client's "old backend" case is a different thing entirely and is not
 * visible here: this code only runs where the table exists. That one is
 * feature-detected client-side.
 */
export function resolveEntitlement(
  row: EntitlementRow | null | undefined,
  now: number = Date.now(),
): Entitlement {
  if (!row) return FREE_ENTITLEMENT;

  const feedCap =
    typeof row.feed_cap === 'number' && Number.isFinite(row.feed_cap) && row.feed_cap > 0
      ? row.feed_cap
      : FREE_ENTITLEMENT.feedCap;

  if (row.tier !== 'paid') return { ...FREE_ENTITLEMENT, feedCap };

  // A paid row with no end date is open-ended (a comp, or a plan that has not
  // been given a period yet) — nothing has lapsed, so nothing to forgive.
  const endsAt = row.current_period_end ? Date.parse(row.current_period_end) : NaN;
  if (!Number.isFinite(endsAt)) return { tier: 'paid', feedCap, inGrace: false };

  if (now <= endsAt) return { tier: 'paid', feedCap, inGrace: false };
  if (now - endsAt <= GRACE_PERIOD_MS) return { tier: 'paid', feedCap, inGrace: true };
  // Expired past the grace window, so the raised cap goes with the tier that
  // bought it. Keeping `feedCap` here would leave a lapsed account on its paid
  // limit forever — most likely exactly when a renewal webhook never arrived,
  // which is the case least likely to be noticed.
  //
  // This is why a deliberate override for someone who is NOT subscribed is
  // expressed as a FREE row with a raised `feed_cap` (honored above), never as
  // a paid row: on a free row the cap is the operator's, on a paid row it is
  // the subscription's, and only the second expires.
  return FREE_ENTITLEMENT;
}

/** Minimal shape of the Supabase client a gate function passes in. Typed
 * structurally so this module stays free of the supabase-js types, matching
 * `allowlist.ts` — it is shared with the vitest unit tests. */
export interface EntitlementDbClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: EntitlementRow | null;
          error: unknown;
        }>;
      };
    };
  };
}

/**
 * Load one account's entitlement row.
 *
 * THROWS on a read error rather than returning the free tier, so callers fail
 * CLOSED — matching `loadAllowlistFromDb` and guardrail #7. An unreadable row
 * means the caller's status is unknown, and treating unknown as *paid* would
 * hand out the cap and uncontrolled Gemini/Jina work exactly while the backend
 * is degraded, which is the moment it is least affordable. Treating unknown as
 * *free* is the other failure and is nearly as bad in the other direction — it
 * silently downgrades a paying customer mid-outage. So neither: the caller
 * surfaces a retryable error and the user is told to try again.
 *
 * A row that is genuinely absent is not an error — that resolves to the free
 * tier, per {@link resolveEntitlement}.
 */
export async function loadEntitlement(
  client: EntitlementDbClient,
  userId: string,
  now: number = Date.now(),
): Promise<Entitlement> {
  const { data, error } = await client
    .from('entitlements')
    .select('tier, status, current_period_end, feed_cap')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    // supabase-js returns a plain `{ message, code, ... }` object, not an
    // Error; surface its message so a failure is diagnosable in the function
    // log. Never log the user id — that is an `auth.uid()` value, and the
    // Privacy rule keeps those out of anything that leaves the device.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error);
    throw new Error(`entitlement read failed: ${message}`);
  }

  return resolveEntitlement(data, now);
}
