import { describe, expect, it } from 'vitest';
import { isInternalCallerAllowed, resolveInternalCaller } from './internalCaller';

describe('resolveInternalCaller', () => {
  const KEY = 'service-role-key-123';

  it('recognizes the pin trigger: service bearer + userId (+ email)', () => {
    expect(
      resolveInternalCaller({
        authHeader: `Bearer ${KEY}`,
        serviceRoleKey: KEY,
        userId: 'user-1',
        email: 'family@example.com',
      }),
    ).toEqual({ internal: true, userId: 'user-1', email: 'family@example.com' });
  });

  it('tolerates a missing email (allowlist then matches on id only)', () => {
    expect(
      resolveInternalCaller({
        authHeader: `Bearer ${KEY}`,
        serviceRoleKey: KEY,
        userId: 'user-1',
        email: null,
      }),
    ).toEqual({ internal: true, userId: 'user-1', email: null });
  });

  it('ignores a userId sent with an ordinary user JWT (no spoofing)', () => {
    expect(
      resolveInternalCaller({
        authHeader: 'Bearer some-user-jwt',
        serviceRoleKey: KEY,
        userId: 'victim-user',
        email: 'victim@example.com',
      }),
    ).toEqual({ internal: false, userId: null, email: null });
  });

  it('a service-bearer call without a userId stays on the user path', () => {
    expect(
      resolveInternalCaller({
        authHeader: `Bearer ${KEY}`,
        serviceRoleKey: KEY,
      }),
    ).toEqual({ internal: false, userId: null, email: null });
  });

  it('never matches when the service key env is unset or empty (fails closed)', () => {
    for (const serviceRoleKey of [undefined, null, '']) {
      expect(
        resolveInternalCaller({
          authHeader: 'Bearer ',
          serviceRoleKey,
          userId: 'user-1',
        }),
      ).toEqual({ internal: false, userId: null, email: null });
    }
  });

  it('normalizes non-string/empty identity fields to null', () => {
    expect(
      resolveInternalCaller({
        authHeader: `Bearer ${KEY}`,
        serviceRoleKey: KEY,
        userId: 42,
        email: {},
      }),
    ).toEqual({ internal: false, userId: null, email: null });
    expect(
      resolveInternalCaller({
        authHeader: `Bearer ${KEY}`,
        serviceRoleKey: KEY,
        userId: 'user-1',
        email: '',
      }),
    ).toEqual({ internal: true, userId: 'user-1', email: null });
  });
});

describe('isInternalCallerAllowed', () => {
  const listed = {
    internal: true,
    userId: 'user-1',
    email: 'family@example.com',
  } as const;

  it('allows a listed internal caller (by email or id)', () => {
    expect(isInternalCallerAllowed(listed, new Set(['family@example.com']))).toBe(true);
    expect(isInternalCallerAllowed(listed, new Set(['user-1']))).toBe(true);
  });

  it('denies an unlisted internal caller', () => {
    expect(
      isInternalCallerAllowed(listed, new Set(['someone-else@example.com'])),
    ).toBe(false);
  });

  it('denies EVERYONE on an empty allowlist (server-initiated cost guard)', () => {
    // The opposite of the client paths' "empty = open": the trigger must
    // generate for no one until the operator seeds the allowlist, like the
    // poller's spoiler-title pass.
    expect(isInternalCallerAllowed(listed, new Set())).toBe(false);
  });

  it('denies a non-internal caller outright', () => {
    expect(
      isInternalCallerAllowed(
        { internal: false, userId: null, email: null },
        new Set(['family@example.com']),
      ),
    ).toBe(false);
  });
});
