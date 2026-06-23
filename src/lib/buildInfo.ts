// Build identity for the /debug page (and any "which build am I on?" need).
// Values come from Vite `define` (see vite.config.ts), baked in at build time.

/** Headline build label: the commit COUNT as a build number on production
 * (monotonic, human-friendly), and the short SHA everywhere else (preview /
 * local), matching what's actually useful per environment. Falls back to the
 * short SHA when the count is unavailable (shallow clone). */
export function buildLabel(
  env: string,
  shortSha: string,
  commitCount: string,
): string {
  if (env === 'production' && commitCount) return `#${commitCount}`;
  return shortSha || 'dev';
}

// `typeof` guards keep this from throwing if a define is ever missing.
const sha = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : '';
const commitCount =
  typeof __BUILD_COMMIT_COUNT__ !== 'undefined' ? __BUILD_COMMIT_COUNT__ : '';
const env = typeof __BUILD_ENV__ !== 'undefined' ? __BUILD_ENV__ : 'development';
const ref = typeof __BUILD_REF__ !== 'undefined' ? __BUILD_REF__ : '';
const commitTime =
  typeof __BUILD_COMMIT_TIME__ !== 'undefined' ? __BUILD_COMMIT_TIME__ : '';

export interface BuildInfo {
  /** Full commit SHA ('' if unknown). */
  sha: string;
  /** First 7 chars of the SHA, or 'unknown'. */
  shortSha: string;
  /** Commit count on the built ref ('' if unknown). */
  commitCount: string;
  /** 'production' | 'preview' | 'development' | 'test'. */
  env: string;
  /** Branch/ref the bundle was built from. */
  ref: string;
  /** ISO commit timestamp ('' if unknown). */
  commitTime: string;
  /** Headline label (see buildLabel). */
  label: string;
}

export const buildInfo: BuildInfo = {
  sha,
  shortSha: sha ? sha.slice(0, 7) : 'unknown',
  commitCount,
  env,
  ref,
  commitTime,
  label: buildLabel(env, sha ? sha.slice(0, 7) : '', commitCount),
};
