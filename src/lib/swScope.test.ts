// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  isRuntimeWorkboxCache,
  jwtSubject,
  scopedWorkboxCacheName,
  supabaseItemStatePattern,
  supabaseRestCachePattern,
  WORKBOX_RUNTIME_CACHE_BASES,
} from './swScope';

/** A syntactically valid unsigned JWT with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

describe('scopedWorkboxCacheName', () => {
  it('partitions by uid, with an anon bucket when signed out', () => {
    expect(scopedWorkboxCacheName('readmo-data', 'u-1')).toBe('readmo-data:u-1');
    expect(scopedWorkboxCacheName('readmo-data', null)).toBe('readmo-data:anon');
  });
});

describe('isRuntimeWorkboxCache', () => {
  it('matches scoped buckets and legacy unscoped names, nothing else', () => {
    for (const base of WORKBOX_RUNTIME_CACHE_BASES) {
      expect(isRuntimeWorkboxCache(base)).toBe(true); // legacy
      expect(isRuntimeWorkboxCache(`${base}:u-1`)).toBe(true);
      expect(isRuntimeWorkboxCache(`${base}:anon`)).toBe(true);
    }
    // The fonts cache is a shared bucket and must survive sweeps.
    expect(isRuntimeWorkboxCache('readmo-fonts')).toBe(false);
    // Workbox's own precache must never be swept.
    expect(isRuntimeWorkboxCache('workbox-precache-v2-https://x/')).toBe(false);
    expect(isRuntimeWorkboxCache('readmo-database')).toBe(false);
  });
});

describe('jwtSubject', () => {
  it('extracts the sub claim from a Bearer token', () => {
    expect(jwtSubject(`Bearer ${jwt({ sub: 'user-123', role: 'authenticated' })}`)).toBe(
      'user-123',
    );
  });

  it('returns null for the anon key (no sub), garbage, and absent headers', () => {
    // Supabase's anon key is a JWT whose payload has no sub claim.
    expect(jwtSubject(`Bearer ${jwt({ role: 'anon' })}`)).toBeNull();
    expect(jwtSubject('Bearer not-a-jwt')).toBeNull();
    expect(jwtSubject('Bearer a.%%%.c')).toBeNull();
    expect(jwtSubject('Basic dXNlcjpwYXNz')).toBeNull();
    expect(jwtSubject('')).toBeNull();
    expect(jwtSubject(null)).toBeNull();
  });

  it('handles base64url payloads (the - and _ alphabet)', () => {
    // '??>' byte runs force '+'/'/' into plain base64, which the base64url
    // alphabet rewrites to '-'/'_' — the decode must map them back.
    const sub = '??>??>??>subject';
    const token = jwt({ sub });
    expect(token).toMatch(/[-_]/); // the test only proves something if so
    expect(jwtSubject(`Bearer ${token}`)).toBe(sub);
  });
});

describe('supabase cache patterns', () => {
  it('derives the REST pattern from the configured origin', () => {
    const p = supabaseRestCachePattern('https://api.readmo.app');
    expect(p.test('https://api.readmo.app/rest/v1/feeds?select=*')).toBe(true);
    expect(p.test('https://other.example/rest/v1/feeds')).toBe(false);
  });

  it('falls back to any supabase.co project when the URL is unset/malformed', () => {
    for (const p of [
      supabaseRestCachePattern(undefined),
      supabaseRestCachePattern('not a url'),
    ]) {
      expect(p.test('https://abc.supabase.co/rest/v1/items?select=*')).toBe(true);
      expect(p.test('https://evil.example/rest/v1/items')).toBe(false);
    }
  });

  it('matches item_state reads (and only those) for the NetworkOnly route', () => {
    const p = supabaseItemStatePattern('https://abc.supabase.co');
    expect(p.test('https://abc.supabase.co/rest/v1/item_state?select=*')).toBe(true);
    expect(p.test('https://abc.supabase.co/rest/v1/item_state')).toBe(true);
    expect(p.test('https://abc.supabase.co/rest/v1/items?select=*')).toBe(false);
  });
});
