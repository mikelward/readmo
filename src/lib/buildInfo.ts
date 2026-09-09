// Build/deploy metadata for the /debug page. The concrete values are baked
// into the bundle by Vite's `define` (see vite.config.ts); this module wraps
// the injected global so callers import a typed value and the display logic
// stays pure + unit-testable.

import { formatTimeAgoLong } from './format';

export interface BuildInfo {
  /** 'production' | 'preview' | 'development' (Vercel) or 'local'. */
  environment: string;
  /** Short commit SHA, or '' when git metadata is unavailable. */
  shortSha: string;
  /** Branch ref the bundle was built from, or ''. */
  branch: string;
  /** Commits reachable from HEAD (≈ "commits on main" for production), or 0. */
  commitCount: number;
  /** ISO commit timestamp of the deployed bundle, or ''. */
  commitTime: string;
  /** First line of the deployed commit's message, or ''. */
  commitSubject: string;
  /** ISO timestamp of when this bundle was built. */
  buildTime: string;
}

/** The metadata for the running bundle, injected at build time. */
export const buildInfo: BuildInfo = __BUILD_INFO__;

/**
 * The leaf of a branch ref — the part after the last slash. Branches are
 * often namespaced (e.g. "claude/debug-page-build-info"); the leaf keeps the
 * headline compact while staying recognizable.
 */
export function shortBranch(branch: string): string {
  const parts = branch.split('/');
  return parts[parts.length - 1];
}

/**
 * One-line headline for the current build, e.g. `main 100 (abcdef)` or
 * `foo-branch 100 (deadbe)` — branch leaf, commit count, short SHA. Each
 * piece is dropped when its metadata is missing so a shallow checkout still
 * renders something useful; falls back to the environment when there's no
 * branch.
 */
export function summarizeBuild(info: BuildInfo): string {
  const name = shortBranch(info.branch) || info.environment || 'unknown';
  let out = name;
  if (info.commitCount > 0) out += ` ${info.commitCount}`;
  if (info.shortSha) out += ` (${info.shortSha})`;
  return out;
}

/**
 * Build sequence number and age for the About section, e.g.
 * `Build 100 · 2 days ago`. The sequence number is the commit count
 * (≈ "build number"); the age uses the verbose `formatTimeAgoLong`. Either
 * piece is dropped when its metadata is missing (shallow checkout); falls
 * back to `Build info unavailable` when neither is present. Pass `now` in
 * tests to keep relative-time assertions deterministic.
 */
export function summarizeBuildAge(info: BuildInfo, now: Date = new Date()): string {
  const parts: string[] = [];
  if (info.commitCount > 0) parts.push(`Build ${info.commitCount}`);
  if (info.buildTime) {
    const seconds = Math.floor(new Date(info.buildTime).getTime() / 1000);
    parts.push(formatTimeAgoLong(seconds, now));
  }
  return parts.length > 0 ? parts.join(' · ') : 'Build info unavailable';
}

/**
 * Label/value rows for the build section of /debug. Rows whose value is
 * missing are omitted so a shallow checkout doesn't render blank fields.
 * Pass `now` in tests to keep relative-time assertions deterministic.
 */
export function buildInfoRows(
  info: BuildInfo,
  now: Date = new Date(),
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Environment', value: info.environment || 'unknown' },
  ];
  if (info.branch) rows.push({ label: 'Branch', value: info.branch });
  if (info.shortSha) rows.push({ label: 'Commit', value: info.shortSha });
  if (info.commitCount > 0) {
    rows.push({ label: 'Commits on branch', value: String(info.commitCount) });
  }
  if (info.commitSubject) {
    rows.push({ label: 'Message', value: info.commitSubject });
  }
  if (info.commitTime) {
    rows.push({
      label: 'Committed',
      value: formatTimeAgoLong(Math.floor(new Date(info.commitTime).getTime() / 1000), now),
    });
  }
  if (info.buildTime) {
    rows.push({
      label: 'Built',
      value: formatTimeAgoLong(Math.floor(new Date(info.buildTime).getTime() / 1000), now),
    });
  }
  return rows;
}
