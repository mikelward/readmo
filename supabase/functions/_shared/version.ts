// Readmo server build number → outbound User-Agent.
//
// Every server-side fetch to a publisher (poller, refresh, image proxy, the
// SSRF helper's default, discovery + full-text via that default) sends a
// descriptive, contactable User-Agent. We stamp it with the SAME build number
// the client carries — `commitCount`, i.e. `git rev-list --count HEAD` — so a
// publisher (or our own logs) can tell which build of Readmo made a request,
// exactly as the browser stamps `x-readmo-build` on Supabase calls
// (clientVersion.ts / vite.config.ts).
//
// Deno Edge Functions have no git at runtime, so the number is injected at
// deploy time as the `READMO_BUILD` secret (set by `make deploy`, computed with
// the same unshallow-then-`rev-list --count` dance as vite.config.ts). When the
// secret is absent — a function deployed before the secret was set, local
// `supabase functions serve`, or the vitest/node test run where `Deno` doesn't
// exist — we fall back to the unversioned UA, so nothing breaks and the change
// is backward-safe (guardrail #11).
//
// Pure (`formatUserAgent`) + env-reading (`readBuildFromEnv`) are split so the
// formatting is unit-testable without touching the environment.

const APP = 'Readmo';
const CONTACT = '+https://readmo.app';

/**
 * Build the User-Agent string for a given build number (the commit count), or
 * the unversioned fallback when it's unknown (`null`). The build number rides
 * as the patch component so the recognizable `Readmo/1.0` prefix is preserved
 * (e.g. `Readmo/1.0.365 (+https://readmo.app)`).
 */
export function formatUserAgent(build: number | null): string {
  const version = build === null ? '1.0' : `1.0.${build}`;
  return `${APP}/${version} (${CONTACT})`;
}

/**
 * Read the deploy-time build number from the `READMO_BUILD` env var (the commit
 * count the client also stamps as `x-readmo-build`). Returns null when unset,
 * non-numeric, or when running outside Deno (node/vitest) — callers fall back to
 * the unversioned UA. Wrapped so the module imports cleanly under node, where
 * `Deno` is undefined.
 */
export function readBuildFromEnv(): number | null {
  const D = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno;
  try {
    return parseBuild(D?.env?.get?.('READMO_BUILD'));
  } catch {
    // Deno throws PermissionDenied when env access isn't granted — e.g. the
    // edge CI job runs `deno test --allow-net …` (no `--allow-env`) and imports
    // ssrf.ts → this module at load. Treat "can't read env" as "build unknown"
    // and fall back to the unversioned UA rather than aborting the import.
    return null;
  }
}

/** Parse a build-number string into a non-negative integer, or null. */
export function parseBuild(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null; // Number('') is 0, not NaN — guard it.
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The User-Agent every server-side publisher fetch should send. Computed once
 * at module load from `READMO_BUILD`; stable for the life of the isolate.
 */
export const USER_AGENT = formatUserAgent(readBuildFromEnv());
