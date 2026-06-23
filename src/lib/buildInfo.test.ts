// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type BuildInfo,
  buildInfoRows,
  shortBranch,
  summarizeBuild,
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

describe('buildInfoRows', () => {
  it('includes every populated field', () => {
    const rows = buildInfoRows(makeInfo());
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
    );
    expect(rows.map((r) => r.label)).toEqual(['Environment']);
  });

  it('shows "unknown" when the environment is blank', () => {
    const rows = buildInfoRows(makeInfo({ environment: '' }));
    expect(rows[0]).toEqual({ label: 'Environment', value: 'unknown' });
  });
});
