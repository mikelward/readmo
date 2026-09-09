// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { pickAllowOrigin, checkClientBuild, isGatedPath } from './worker.js';

const ORIGINS = ['https://readmo.app', 'https://www.readmo.app'];

describe('pickAllowOrigin', () => {
  it('echoes the caller origin when allow-listed', () => {
    expect(pickAllowOrigin('https://readmo.app', ORIGINS)).toBe('https://readmo.app');
    expect(pickAllowOrigin('https://www.readmo.app', ORIGINS)).toBe('https://www.readmo.app');
  });

  it('falls back to the first allowed origin for unknown / empty origins', () => {
    expect(pickAllowOrigin('https://evil.example', ORIGINS)).toBe('https://readmo.app');
    expect(pickAllowOrigin('', ORIGINS)).toBe('https://readmo.app');
  });

  it('returns empty string when nothing is configured', () => {
    expect(pickAllowOrigin('https://readmo.app', [])).toBe('');
  });
});

describe('isGatedPath', () => {
  it('gates the stamped data paths (REST/RPC + functions)', () => {
    expect(isGatedPath('/rest/v1/rpc/feed_items')).toBe(true);
    expect(isGatedPath('/functions/v1/refresh')).toBe(true);
  });

  it('never gates auth navigations or storage (no x-readmo-build header on those)', () => {
    expect(isGatedPath('/auth/v1/authorize')).toBe(false);
    expect(isGatedPath('/auth/v1/token')).toBe(false);
    expect(isGatedPath('/storage/v1/object/public/x')).toBe(false);
    expect(isGatedPath('/')).toBe(false);
  });
});

describe('checkClientBuild', () => {
  it('is disarmed at floor <= 0 — allows everything, even header-less', () => {
    expect(checkClientBuild('5', 0).allowed).toBe(true);
    expect(checkClientBuild(null, 0).allowed).toBe(true);
    expect(checkClientBuild(null, Number.NaN).allowed).toBe(true);
  });

  it('once armed, allows builds at or above the floor', () => {
    expect(checkClientBuild('150', 150)).toEqual({ allowed: true });
    expect(checkClientBuild('151', 150)).toEqual({ allowed: true });
  });

  it('once armed, blocks builds below the floor and reports it', () => {
    expect(checkClientBuild('149', 150)).toEqual({ allowed: false, floor: 150 });
  });

  it('once armed, blocks header-less / garbage callers (a build predating the stamp)', () => {
    expect(checkClientBuild(null, 150)).toEqual({ allowed: false, floor: 150 });
    expect(checkClientBuild('', 150)).toEqual({ allowed: false, floor: 150 });
    expect(checkClientBuild('nope', 150)).toEqual({ allowed: false, floor: 150 });
  });
});
