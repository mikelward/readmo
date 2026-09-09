// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type BuildInfo,
  buildInfoRows,
  shortBranch,
  summarizeBuild,
  summarizeBuildAge,
} from './buildInfo';

function makeInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    environment: 'production',
    shortSha: 'abcdef0',
    branch: 'main',
    commitCount: 100,
    commitTime: '2026-06-23T00:00:00.000Z',
    commitSubject: 'Add debug page',
    buildTime: '2026-06-23T01:00:00.000Z',
    ...overrides,
  };
}

describe('shortBranch', () => {
  it('returns the leaf after the last slash', () => {
    expect(shortBranch('claude/debug-page-build-info')).toBe(
      'debug-page-build-info',
    );
    expect(shortBranch('feature/foo/bar')).toBe('bar');
  });

  it('returns the name unchanged when there is no slash', () => {
    expect(shortBranch('main')).toBe('main');
  });
});

describe('summarizeBuild', () => {
  it('formats branch leaf, commit count, and short SHA', () => {
    expect(summarizeBuild(makeInfo({ branch: 'main', commitCount: 100, shortSha: 'abcdef' }))).toBe(
      'main 100 (abcdef)',
    );
  });

  it('uses the branch leaf for namespaced branches', () => {
    expect(
      summarizeBuild(
        makeInfo({ branch: 'claude/foo-branch', commitCount: 100, shortSha: 'deadbe' }),
      ),
    ).toBe('foo-branch 100 (deadbe)');
  });

  it('drops the count when unavailable', () => {
    expect(summarizeBuild(makeInfo({ commitCount: 0, branch: 'main', shortSha: 'abc1234' }))).toBe(
      'main (abc1234)',
    );
  });

  it('drops the SHA when unavailable', () => {
    expect(summarizeBuild(makeInfo({ shortSha: '', branch: 'main', commitCount: 5 }))).toBe(
      'main 5',
    );
  });

  it('falls back to the environment when there is no branch', () => {
    expect(
      summarizeBuild(
        makeInfo({ branch: '', environment: 'preview', commitCount: 0, shortSha: '' }),
      ),
    ).toBe('preview');
  });
});

describe('summarizeBuildAge', () => {
  it('shows the build sequence number and the spelled-out age', () => {
    expect(
      summarizeBuildAge(
        makeInfo({ commitCount: 100, buildTime: '2026-06-23T01:00:00.000Z' }),
        new Date('2026-06-23T01:02:00.000Z'),
      ),
    ).toBe('Build 100 · 2 minutes ago');
    expect(
      summarizeBuildAge(
        makeInfo({ commitCount: 100, buildTime: '2026-06-21T01:00:00.000Z' }),
        new Date('2026-06-23T01:00:00.000Z'),
      ),
    ).toBe('Build 100 · 2 days ago');
  });

  it('says "just now" for a fresh build', () => {
    expect(
      summarizeBuildAge(
        makeInfo({ commitCount: 100, buildTime: '2026-06-23T01:00:00.000Z' }),
        new Date('2026-06-23T01:00:30.000Z'),
      ),
    ).toBe('Build 100 · just now');
  });

  it('drops the sequence number when the commit count is unavailable', () => {
    expect(
      summarizeBuildAge(
        makeInfo({ commitCount: 0, buildTime: '2026-06-21T01:00:00.000Z' }),
        new Date('2026-06-23T01:00:00.000Z'),
      ),
    ).toBe('2 days ago');
  });

  it('drops the age when the build time is missing', () => {
    expect(summarizeBuildAge(makeInfo({ commitCount: 100, buildTime: '' }))).toBe('Build 100');
  });

  it('falls back when neither piece is available', () => {
    expect(summarizeBuildAge(makeInfo({ commitCount: 0, buildTime: '' }))).toBe(
      'Build info unavailable',
    );
  });
});

describe('buildInfoRows', () => {
  // now = 4h after commitTime, 3h after buildTime
  const now = new Date('2026-06-23T04:00:00.000Z');

  it('includes every populated field', () => {
    const rows = buildInfoRows(makeInfo(), now);
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual([
      'Environment',
      'Branch',
      'Commit',
      'Commits on branch',
      'Message',
      'Committed',
      'Built',
    ]);
  });

  it('formats commitTime and buildTime as verbose relative time', () => {
    const rows = buildInfoRows(makeInfo(), now);
    expect(rows.find((r) => r.label === 'Committed')?.value).toBe('4 hours ago');
    expect(rows.find((r) => r.label === 'Built')?.value).toBe('3 hours ago');
  });

  it('omits rows whose value is missing', () => {
    const rows = buildInfoRows(
      makeInfo({
        branch: '',
        shortSha: '',
        commitCount: 0,
        commitSubject: '',
        commitTime: '',
        buildTime: '',
      }),
      now,
    );
    expect(rows.map((r) => r.label)).toEqual(['Environment']);
  });

  it('shows "unknown" when the environment is blank', () => {
    const rows = buildInfoRows(makeInfo({ environment: '' }), now);
    expect(rows[0]).toEqual({ label: 'Environment', value: 'unknown' });
  });
});
