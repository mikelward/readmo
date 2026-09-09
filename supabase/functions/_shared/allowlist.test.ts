// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isAllowed,
  loadAllowlistFromDb,
  type AllowlistDbClient,
} from './allowlist.ts';

/** Build a stub Supabase client whose `from('allowlist').select('email')`
 * resolves to the given rows (or an error). */
function stubClient(result: {
  data?: Array<{ email: string | null }> | null;
  error?: unknown;
}): AllowlistDbClient {
  return {
    from() {
      return {
        select: () =>
          Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
      };
    },
  };
}

describe('isAllowed', () => {
  it('is open to all when the allowlist is empty (gate disarmed)', () => {
    const empty = new Set<string>();
    expect(isAllowed({ id: 'anyone', email: 'x@y.z' }, empty)).toBe(true);
    expect(isAllowed({}, empty)).toBe(true);
  });

  it('allows a caller matched by email (case-insensitive)', () => {
    const list = new Set(['me@example.com']);
    expect(isAllowed({ email: 'ME@example.com' }, list)).toBe(true);
  });

  it('allows a caller matched by user id', () => {
    const list = new Set(['user-123']);
    expect(isAllowed({ id: 'user-123' }, list)).toBe(true);
  });

  it('blocks a caller on neither list once the gate is armed', () => {
    const list = new Set(['me@example.com']);
    expect(isAllowed({ id: 'someone', email: 'other@example.com' }, list)).toBe(
      false,
    );
  });

  it('blocks a caller with no identity once armed', () => {
    const list = new Set(['me@example.com']);
    expect(isAllowed({}, list)).toBe(false);
    expect(isAllowed({ id: null, email: null }, list)).toBe(false);
  });

  it('does not match on empty-string identity fields', () => {
    // An empty id/email must never match a real allowlist entry.
    const list = new Set(['me@example.com']);
    expect(isAllowed({ id: '', email: '' }, list)).toBe(false);
  });
});

describe('loadAllowlistFromDb', () => {
  it('builds a trimmed, lowercased Set of emails from the table', async () => {
    const set = await loadAllowlistFromDb(
      stubClient({ data: [{ email: '  Family@Example.COM ' }, { email: 'b@example.com' }] }),
    );
    expect(set.has('family@example.com')).toBe(true);
    expect(set.has('b@example.com')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns an empty Set (disarmed → open to all) for no rows', async () => {
    expect((await loadAllowlistFromDb(stubClient({ data: [] }))).size).toBe(0);
    expect((await loadAllowlistFromDb(stubClient({ data: null }))).size).toBe(0);
  });

  it('drops null/blank emails', async () => {
    const set = await loadAllowlistFromDb(
      stubClient({ data: [{ email: null }, { email: '   ' }, { email: 'ok@example.com' }] }),
    );
    expect(set.size).toBe(1);
    expect(set.has('ok@example.com')).toBe(true);
  });

  it('THROWS on a read error so the gate can fail closed (never silently opens)', async () => {
    await expect(
      loadAllowlistFromDb(stubClient({ error: { message: 'db down' } })),
    ).rejects.toThrow('db down');
  });
});
