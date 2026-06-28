// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from './allowlist.ts';

describe('parseAllowlist', () => {
  it('treats unset / blank as an empty set', () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist(null).size).toBe(0);
    expect(parseAllowlist('').size).toBe(0);
    expect(parseAllowlist('   \n  ,  ').size).toBe(0);
  });

  it('splits on commas and arbitrary whitespace', () => {
    const set = parseAllowlist('a@example.com, b@example.com\n c@example.com');
    expect(set.has('a@example.com')).toBe(true);
    expect(set.has('b@example.com')).toBe(true);
    expect(set.has('c@example.com')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('trims and lowercases entries so matching is case-insensitive', () => {
    const set = parseAllowlist('  Family@Example.COM  ');
    expect(set.has('family@example.com')).toBe(true);
    expect(set.size).toBe(1);
  });

  it('keeps uuids and emails side by side', () => {
    const set = parseAllowlist(
      '11111111-1111-4111-8111-111111111111, me@example.com',
    );
    expect(set.has('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(set.has('me@example.com')).toBe(true);
  });
});

describe('isAllowed', () => {
  it('is open to all when the allowlist is empty (gate disarmed)', () => {
    const empty = parseAllowlist('');
    expect(isAllowed({ id: 'anyone', email: 'x@y.z' }, empty)).toBe(true);
    expect(isAllowed({}, empty)).toBe(true);
  });

  it('allows a caller matched by email (case-insensitive)', () => {
    const list = parseAllowlist('me@example.com');
    expect(isAllowed({ email: 'ME@example.com' }, list)).toBe(true);
  });

  it('allows a caller matched by user id', () => {
    const list = parseAllowlist('user-123');
    expect(isAllowed({ id: 'user-123' }, list)).toBe(true);
  });

  it('blocks a caller on neither list once the gate is armed', () => {
    const list = parseAllowlist('me@example.com');
    expect(isAllowed({ id: 'someone', email: 'other@example.com' }, list)).toBe(
      false,
    );
  });

  it('blocks a caller with no identity once armed', () => {
    const list = parseAllowlist('me@example.com');
    expect(isAllowed({}, list)).toBe(false);
    expect(isAllowed({ id: null, email: null }, list)).toBe(false);
  });

  it('does not match on empty-string identity fields against blank entries', () => {
    // Blank entries are dropped at parse time, so an empty id/email can never
    // accidentally match an "empty" allowlist entry.
    const list = parseAllowlist('me@example.com');
    expect(isAllowed({ id: '', email: '' }, list)).toBe(false);
  });
});
