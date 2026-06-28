// Trusted-user allowlist for Readmo's higher copyright/ToS-exposure features.
//
// Two surfaces are gated on this one list:
//   - Full-text reading mode (the `fulltext` function) — fetches the article
//     *beyond* the feed and stores a shared copy on `items`.
//   - Google News RSS feeds (the `discover` function) — adding `news.google.com`
//     feeds, a Google-ToS gray area.
// Plain feed reading stays open to everyone; only these two surfaces consult the
// list, so the operator can keep them to themselves and family.
//
// The list lives in the Postgres `allowlist` table (emails), managed from the
// /admin UI; the gate functions read it via {@link loadAllowlistFromDb} with
// their service-role client. (It used to be the `READMO_ALLOWLIST` env var;
// `parseAllowlist` is retained for unit tests and any transitional use.)
//
// Semantics — arming is a deliberate operator action:
//   - EMPTY list   → OPEN to every authenticated caller, so an unseeded deploy
//     changes nothing (backwards compatible, guardrail #11).
//   - non-empty    → only listed callers may use the gated surfaces; everyone
//     else is turned away (reading mode falls back silently to the feed body; a
//     Google News add is rejected). Matching is on email, case-insensitive.
//
// Cost/reliability (guardrail #5): negligible — one small indexed read of the
// `allowlist` table per gated call (the table holds a handful of family emails),
// plus the existing `auth.getUser()` identity round-trip, only while armed.

/** Parse a `READMO_ALLOWLIST` value into a normalized lookup set. An unset or
 * blank value yields an empty set, which {@link isAllowed} treats as "gate
 * disarmed → open to all". */
export function parseAllowlist(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export interface AllowlistIdentity {
  /** The caller's `auth.users` id (JWT `sub`). */
  id?: string | null;
  /** The caller's account email, if any. */
  email?: string | null;
}

/**
 * Whether a caller may use a gated surface.
 *
 * An empty allowlist (the secret is unset) is "open to all" — arming the gate is
 * a deliberate operator action, so an unconfigured deploy never sheds a feature
 * from existing users. Once the allowlist names anyone, a caller is allowed only
 * when their id or email is listed; matching mirrors {@link parseAllowlist}
 * (trimmed, case-insensitive).
 */
export function isAllowed(
  identity: AllowlistIdentity,
  allowlist: Set<string>,
): boolean {
  if (allowlist.size === 0) return true; // disarmed → open to every caller
  const id = identity.id?.trim().toLowerCase();
  const email = identity.email?.trim().toLowerCase();
  return (!!id && allowlist.has(id)) || (!!email && allowlist.has(email));
}

/** Minimal shape of the Supabase client the gate functions pass in — just the
 * `from('allowlist').select('email')` read. Typed structurally so this module
 * stays free of the supabase-js types (it's shared with vitest unit tests). */
export interface AllowlistDbClient {
  from(table: string): {
    select(columns: string): PromiseLike<{
      data: Array<{ email: string | null }> | null;
      error: unknown;
    }>;
  };
}

/**
 * Load the trusted-user allowlist (emails) from the `allowlist` table, returning
 * a lowercased Set ready for {@link isAllowed}. An empty Set means "disarmed →
 * open to all", same as an unset env var used to.
 *
 * THROWS on a read error rather than returning an empty Set, so the gate can
 * fail CLOSED on a transient DB failure (an empty Set would silently open the
 * gate to everyone). Callers decide the fail-closed response (fulltext →
 * retryable `unreachable`; discover → treat as not-allowed).
 */
export async function loadAllowlistFromDb(
  client: AllowlistDbClient,
): Promise<Set<string>> {
  const { data, error } = await client.from('allowlist').select('email');
  if (error) {
    // supabase-js returns a plain `{ message, code, ... }` object, not an Error;
    // surface its message so a failure is diagnosable in the function log.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error);
    throw new Error(message);
  }
  return new Set(
    (data ?? [])
      .map((row) => (row.email ?? '').trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}
