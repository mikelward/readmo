// Trusted-user allowlist for Readmo's higher copyright/ToS-exposure features.
//
// Two surfaces are gated on this one list (`READMO_ALLOWLIST`):
//   - Full-text reading mode (the `fulltext` function) — fetches the article
//     *beyond* the feed and stores a shared copy on `items`.
//   - Google News RSS feeds (the `discover` function) — adding `news.google.com`
//     feeds, a Google-ToS gray area.
// Plain feed reading stays open to everyone; only these two surfaces consult the
// list, so the operator can keep them to themselves and family.
//
// Semantics — arming is a deliberate operator action (mirrors MIN_CLIENT_BUILD):
//   - UNSET / empty  → OPEN to every authenticated caller. Deploying the gated
//     functions therefore changes nothing until the secret is set, so the change
//     is backwards compatible (guardrail #11).
//   - non-empty      → only callers whose auth user id OR email is listed may use
//     the gated surfaces; everyone else is turned away (reading mode falls back
//     silently to the feed body; a Google News add is rejected with a message).
//
// Entries are separated by commas and/or whitespace (newlines included) and may
// be `auth.users` UUIDs or account emails, mixed freely. Matching trims
// surrounding space and is case-insensitive.
//
// Cost/reliability (guardrail #5): negligible — a string split and a Set lookup,
// no network, no DB. When armed, the gated function pays one extra
// `auth.getUser()` round-trip to resolve identity; off the happy path and only
// while armed.

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
