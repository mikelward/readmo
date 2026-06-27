// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIMIT,
  DEFAULT_THRESHOLDS,
  classifyDiagnostics,
  redactQuery,
  resolveLimit,
  resolveThresholds,
  sanitizeQueryText,
  type Diagnostics,
} from './dbPerf';

describe('resolveThresholds', () => {
  it('uses defaults when nothing is set', () => {
    expect(resolveThresholds({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it('honors valid overrides per field', () => {
    const t = resolveThresholds({
      DB_PERF_ACTIVE_MS: '5000',
      DB_PERF_CRITICAL_MS: '20000',
      DB_PERF_SLOW_MEAN_MS: '500',
    });
    expect(t).toEqual({ activeMs: 5000, criticalMs: 20000, slowMeanMs: 500 });
  });

  it('ignores blank, non-numeric, zero, and negative overrides', () => {
    expect(resolveThresholds({ DB_PERF_ACTIVE_MS: '   ' }).activeMs).toBe(
      DEFAULT_THRESHOLDS.activeMs,
    );
    expect(resolveThresholds({ DB_PERF_CRITICAL_MS: 'soon' }).criticalMs).toBe(
      DEFAULT_THRESHOLDS.criticalMs,
    );
    expect(resolveThresholds({ DB_PERF_SLOW_MEAN_MS: '0' }).slowMeanMs).toBe(
      DEFAULT_THRESHOLDS.slowMeanMs,
    );
    expect(resolveThresholds({ DB_PERF_ACTIVE_MS: '-3' }).activeMs).toBe(
      DEFAULT_THRESHOLDS.activeMs,
    );
  });
});

describe('resolveLimit', () => {
  it('defaults and rounds a valid override', () => {
    expect(resolveLimit({})).toBe(DEFAULT_LIMIT);
    expect(resolveLimit({ DB_PERF_LIMIT: '25' })).toBe(25);
    expect(resolveLimit({ DB_PERF_LIMIT: '7.6' })).toBe(8);
  });

  it('falls back on junk', () => {
    expect(resolveLimit({ DB_PERF_LIMIT: 'lots' })).toBe(DEFAULT_LIMIT);
  });
});

describe('redactQuery', () => {
  it('collapses whitespace/control chars to a single line', () => {
    expect(redactQuery('select\n\t*  from   feeds')).toBe('select * from feeds');
  });

  it('truncates overly long text with an ellipsis', () => {
    const out = redactQuery('a'.repeat(200), 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for null/undefined', () => {
    expect(redactQuery(null)).toBe('');
    expect(redactQuery(undefined)).toBe('');
  });
});

describe('sanitizeQueryText', () => {
  it('collapses an embedded URL to scheme://host, keeping the rest of the query', () => {
    expect(
      sanitizeQueryText("select * from feeds where url = 'https://ex.com/a/SECRETTOKEN?token=x'"),
    ).toBe("select * from feeds where url = 'https://ex.com'");
  });

  it('leaves non-URL literals intact (the operator already has DB access)', () => {
    expect(sanitizeQueryText('update items set done = true where id = 99')).toBe(
      'update items set done = true where id = 99',
    );
  });

  it('collapses multiple URLs independently', () => {
    expect(
      sanitizeQueryText("a 'http://one.test/p/TOKEN' b 'https://two.test/q?k=v' c"),
    ).toBe("a 'http://one.test' b 'https://two.test' c");
  });

  it('truncates and returns empty for null', () => {
    expect(sanitizeQueryText('x'.repeat(200), 50).endsWith('…')).toBe(true);
    expect(sanitizeQueryText(null)).toBe('');
  });
});

describe('classifyDiagnostics', () => {
  const empty: Diagnostics = { active: [], top: [] };

  it('returns ok on an empty snapshot', () => {
    const v = classifyDiagnostics(empty);
    expect(v.severity).toBe('ok');
    expect(v.activeBreaches).toEqual([]);
    expect(v.slowGroups).toEqual([]);
    expect(v.summary).toContain('ok');
  });

  it('treats null active/top arrays like empty', () => {
    expect(classifyDiagnostics({ active: null, top: null }).severity).toBe('ok');
    expect(classifyDiagnostics({}).severity).toBe('ok');
  });

  it('warns on a long-running query below the critical threshold', () => {
    const v = classifyDiagnostics({
      active: [{ pid: 1, duration_ms: 12_000, query: 'select * from feed_items' }],
      top: [],
    });
    expect(v.severity).toBe('warn');
    expect(v.activeBreaches).toHaveLength(1);
    expect(v.summary).toContain('long-running');
  });

  it('escalates to critical when a query exceeds the critical threshold', () => {
    const v = classifyDiagnostics({
      active: [{ pid: 9, duration_ms: 45_000, query: 'vacuum full items' }],
      top: [],
    });
    expect(v.severity).toBe('critical');
    expect(v.summary).toContain('critical');
  });

  it('warns on a chronically slow query group with no active long-runner', () => {
    const v = classifyDiagnostics({
      active: [{ pid: 2, duration_ms: 200 }], // below activeMs → not a breach
      top: [
        { queryid: 'q1', calls: 5000, mean_exec_ms: 1500, total_exec_ms: 7_500_000, query: 'select $1' },
        { queryid: 'q2', calls: 10, mean_exec_ms: 50, total_exec_ms: 500, query: 'select $1' },
      ],
    });
    expect(v.severity).toBe('warn');
    expect(v.slowGroups).toHaveLength(1);
    expect(v.slowGroups[0].queryid).toBe('q1');
    expect(v.summary).toContain('slow query group');
  });

  it('sorts active breaches by duration and slow groups by total time, worst first', () => {
    const v = classifyDiagnostics({
      active: [
        { pid: 1, duration_ms: 11_000, query: 'a' },
        { pid: 2, duration_ms: 25_000, query: 'b' },
      ],
      top: [
        { queryid: 'low', mean_exec_ms: 1100, total_exec_ms: 2_000, query: 'x' },
        { queryid: 'high', mean_exec_ms: 1100, total_exec_ms: 9_000, query: 'y' },
      ],
    });
    expect(v.activeBreaches[0].pid).toBe(2);
    expect(v.slowGroups[0].queryid).toBe('high');
  });

  it('respects custom thresholds', () => {
    const diag: Diagnostics = {
      active: [{ pid: 1, duration_ms: 6_000, query: 'select 1' }],
      top: [],
    };
    // Default activeMs is 10s → ok; tightening to 5s makes the 6s query a breach.
    expect(classifyDiagnostics(diag).severity).toBe('ok');
    expect(
      classifyDiagnostics(diag, { activeMs: 5_000, criticalMs: 30_000, slowMeanMs: 1_000 })
        .severity,
    ).toBe('warn');
  });

  it('builds a summary that identifies each offender (pid / queryid) and its query head', () => {
    const v = classifyDiagnostics({
      active: [{ pid: 1, duration_ms: 40_000, query: 'select * from items where body ~ $1' }],
      top: [{ queryid: 'q', mean_exec_ms: 2200, total_exec_ms: 99_000, query: 'select count(*)' }],
    });
    expect(v.summary).toContain('40s');
    expect(v.summary).toContain('2200ms');
    // names the offenders…
    expect(v.summary).toContain('pid 1');
    expect(v.summary).toContain('queryid q');
    // …and shows which query each is
    expect(v.summary).toContain('items where body');
    expect(v.summary).toContain('select count(*)');
  });

  it('keeps the active query identifiable but strips a feed token from its URL', () => {
    const v = classifyDiagnostics({
      active: [
        {
          pid: 42,
          duration_ms: 20_000,
          query:
            "select * from feeds where secret_url = 'https://pub.example.com/feed/abcdef0123456789abcdef?token=SECRET123'",
        },
      ],
      top: [],
    });
    expect(v.summary).toContain('pid 42');
    // still says WHICH query (availability/usefulness over log purity)…
    expect(v.summary).toContain('select * from feeds');
    // …but the token is gone (URL reduced to scheme://host).
    expect(v.summary).toContain('https://pub.example.com');
    expect(v.summary).not.toContain('SECRET123');
    expect(v.summary).not.toContain('token=');
  });
});
