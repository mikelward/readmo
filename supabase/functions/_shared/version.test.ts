// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { formatUserAgent, parseBuild, readBuildFromEnv } from './version.ts';

describe('formatUserAgent', () => {
  it('embeds the build number as the patch component', () => {
    expect(formatUserAgent(365)).toBe('Readmo/1.0.365 (+https://readmo.app)');
    expect(formatUserAgent(0)).toBe('Readmo/1.0.0 (+https://readmo.app)');
  });

  it('falls back to the unversioned UA when the build is unknown', () => {
    expect(formatUserAgent(null)).toBe('Readmo/1.0 (+https://readmo.app)');
  });

  it('keeps the recognizable `Readmo/1.0` prefix either way', () => {
    expect(formatUserAgent(365)).toContain('Readmo/1.0');
    expect(formatUserAgent(null)).toContain('Readmo/1.0');
  });
});

describe('parseBuild', () => {
  it('parses a non-negative integer', () => {
    expect(parseBuild('365')).toBe(365);
    expect(parseBuild('0')).toBe(0);
    expect(parseBuild('  42 ')).toBe(42);
  });

  it('returns null for absent, empty, or non-integer input', () => {
    expect(parseBuild(null)).toBeNull();
    expect(parseBuild(undefined)).toBeNull();
    expect(parseBuild('')).toBeNull();
    expect(parseBuild('   ')).toBeNull();
    expect(parseBuild('1.5')).toBeNull();
    expect(parseBuild('-3')).toBeNull();
    expect(parseBuild('abc')).toBeNull();
  });
});

describe('readBuildFromEnv', () => {
  const original = (globalThis as { Deno?: unknown }).Deno;
  afterEach(() => {
    (globalThis as { Deno?: unknown }).Deno = original;
  });

  it('returns null when Deno is absent (node/vitest)', () => {
    delete (globalThis as { Deno?: unknown }).Deno;
    expect(readBuildFromEnv()).toBeNull();
  });

  it('reads READMO_BUILD from Deno.env when present', () => {
    (globalThis as { Deno?: unknown }).Deno = {
      env: { get: (k: string) => (k === 'READMO_BUILD' ? '365' : undefined) },
    };
    expect(readBuildFromEnv()).toBe(365);
  });

  it('returns null when Deno.env.get throws (env permission denied)', () => {
    // `deno test` without `--allow-env` throws PermissionDenied on env access;
    // readBuildFromEnv must swallow it and fall back rather than abort the import.
    (globalThis as { Deno?: unknown }).Deno = {
      env: {
        get: () => {
          throw new Error('Requires env access to "READMO_BUILD"');
        },
      },
    };
    expect(readBuildFromEnv()).toBeNull();
  });

  it('returns null when READMO_BUILD is unset or garbage', () => {
    (globalThis as { Deno?: unknown }).Deno = {
      env: { get: (k: string) => (k === 'READMO_BUILD' ? 'nope' : undefined) },
    };
    expect(readBuildFromEnv()).toBeNull();
    (globalThis as { Deno?: unknown }).Deno = { env: { get: () => undefined } };
    expect(readBuildFromEnv()).toBeNull();
  });
});
