// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  CLIENT_BUILD_HEADER,
  parseClientBuild,
  checkClientBuild,
} from './clientVersion.ts';

describe('parseClientBuild', () => {
  it('parses a non-negative integer build number', () => {
    expect(parseClientBuild('100')).toBe(100);
    expect(parseClientBuild(' 42 ')).toBe(42);
    expect(parseClientBuild('0')).toBe(0);
  });

  it('rejects missing or non-integer values', () => {
    expect(parseClientBuild(null)).toBeNull();
    expect(parseClientBuild(undefined)).toBeNull();
    expect(parseClientBuild('')).toBeNull();
    expect(parseClientBuild('abc')).toBeNull();
    expect(parseClientBuild('1.5')).toBeNull();
    expect(parseClientBuild('-3')).toBeNull();
  });
});

describe('checkClientBuild', () => {
  it('is disarmed at floor 0 — allows everything, including header-less callers', () => {
    expect(checkClientBuild('1', 0).allowed).toBe(true);
    expect(checkClientBuild(null, 0).allowed).toBe(true);
    expect(checkClientBuild(undefined, 0).allowed).toBe(true);
  });

  it('treats a non-positive or non-finite floor as disarmed', () => {
    expect(checkClientBuild(null, -1).allowed).toBe(true);
    expect(checkClientBuild(null, Number.NaN).allowed).toBe(true);
  });

  it('once armed, allows builds at or above the floor', () => {
    expect(checkClientBuild('150', 150)).toEqual({ allowed: true });
    expect(checkClientBuild('151', 150)).toEqual({ allowed: true });
  });

  it('once armed, blocks builds below the floor and reports it', () => {
    expect(checkClientBuild('149', 150)).toEqual({ allowed: false, floor: 150 });
  });

  it('once armed, blocks a header-less caller — a build predating the header is old', () => {
    expect(checkClientBuild(null, 150)).toEqual({ allowed: false, floor: 150 });
    expect(checkClientBuild('garbage', 150)).toEqual({ allowed: false, floor: 150 });
  });
});

describe('CLIENT_BUILD_HEADER', () => {
  it('is the agreed contract header name', () => {
    // The client (src/lib/supabase/client.ts) hard-codes this same literal; the
    // two trees build separately, so this test pins the contract on this side.
    expect(CLIENT_BUILD_HEADER).toBe('x-readmo-build');
  });
});
