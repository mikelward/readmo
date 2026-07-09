// Internal (database-initiated) calls to the gated Edge Functions — pure logic.
//
// The pin trigger in Postgres (0053/0054_pin_triggers_*.sql) kicks the
// `summary` function when a pin commits (which in turn kicks `fulltext`), so
// pinned articles are summarized and fully downloaded even if the app closes
// right after the pin. The database can't mint a user JWT, so those calls
// authenticate with the service-role bearer and name the pinning user
// explicitly in the body; this module classifies such requests and gates them.
//
// Dependency-free (no Deno globals) so the same code runs under vitest for
// unit tests; the entrypoints pass in env values.

import { isAllowed } from './allowlist.ts';

/** Who is asking. Normal requests carry the user's JWT (RLS scopes the item
 * read; `auth.getUser()` identifies them for the allowlist). INTERNAL requests
 * come from the DB pin trigger: service-role bearer + explicit user identity. */
export interface InternalCaller {
  /** True only for the DB pin trigger's call: the service-role key as the
   * bearer AND an explicit `userId` in the body. */
  internal: boolean;
  /** The pinning user's id (internal calls only; null on the user path, which
   * identifies the caller from the JWT instead). */
  userId: string | null;
  /** The pinning user's account email (internal calls only) — the key the
   * allowlist matches on. */
  email: string | null;
}

/**
 * Classify a request as the pin trigger's internal call or a normal user call.
 * Internal requires BOTH the service-role bearer and a non-empty `userId`: a
 * client passing `userId` with its own JWT stays on the user path (the field is
 * ignored, not trusted), and a service-bearer call without a `userId` also
 * falls through to the user path (where its `auth.getUser()` fails) rather than
 * becoming an anonymous privileged read. An unset/empty `serviceRoleKey` can
 * never match, so a missing env var fails closed.
 */
export function resolveInternalCaller(args: {
  authHeader: string | null | undefined;
  serviceRoleKey: string | null | undefined;
  userId?: unknown;
  email?: unknown;
}): InternalCaller {
  const userId =
    typeof args.userId === 'string' && args.userId.length > 0 ? args.userId : null;
  const email =
    typeof args.email === 'string' && args.email.length > 0 ? args.email : null;
  const internal =
    typeof args.serviceRoleKey === 'string' &&
    args.serviceRoleKey.length > 0 &&
    args.authHeader === `Bearer ${args.serviceRoleKey}` &&
    userId !== null;
  if (!internal) return { internal: false, userId: null, email: null };
  return { internal: true, userId, email };
}

/**
 * Allowlist gate for an internal (trigger-initiated) caller. Server-INITIATED
 * generation follows the poller's convention, not the client paths': an EMPTY
 * allowlist means the trigger works for NO ONE — the cost guard against an
 * unseeded deploy spending Jina/Gemini/publisher fetches on every pin (same
 * rationale as the spoiler-title pass; see AGENTS.md Gemini row). Client-
 * initiated calls keep their "empty = open to all" semantics — those only run
 * when a signed-in user acts, which is its own natural bound.
 */
export function isInternalCallerAllowed(
  caller: InternalCaller,
  allowlist: Set<string>,
): boolean {
  if (!caller.internal) return false;
  return (
    allowlist.size > 0 &&
    isAllowed({ id: caller.userId, email: caller.email }, allowlist)
  );
}
