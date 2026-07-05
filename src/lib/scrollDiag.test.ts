import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDiag,
  diagHeadline,
  formatDiagEntry,
  formatDiagReport,
  freezeDiagReport,
  getDiagBuffer,
  getDiagReport,
  recordDiag,
  summarizeDiag,
} from './scrollDiag';

describe('scrollDiag', () => {
  afterEach(() => clearDiag());

  it('records entries with a relative, monotonic timeline clock', () => {
    recordDiag({ kind: 'scroll', y: 100, delta: 100 });
    recordDiag({ kind: 'done', y: 100, id: 'a' });
    const buf = getDiagBuffer();
    expect(buf).toHaveLength(2);
    // First entry anchors the clock at 0; later entries are >= it.
    expect(buf[0].t).toBe(0);
    expect(buf[1].t).toBeGreaterThanOrEqual(0);
    expect(buf[1]).toMatchObject({ kind: 'done', y: 100, id: 'a' });
  });

  it('caps the buffer so a long session cannot grow it without bound', () => {
    for (let i = 0; i < 250; i++) recordDiag({ kind: 'scroll', y: i, delta: 1 });
    const buf = getDiagBuffer();
    expect(buf).toHaveLength(200);
    // The oldest entries are dropped, newest kept.
    expect(buf[buf.length - 1].y).toBe(249);
  });

  it('freezes a report independent of later recording', () => {
    recordDiag({ kind: 'scroll', y: 500, delta: -700 });
    const frozen = freezeDiagReport();
    expect(frozen).toHaveLength(1);
    // Scrolling after the freeze must not mutate the captured report.
    recordDiag({ kind: 'scroll', y: 0, delta: -500 });
    expect(getDiagReport()).toHaveLength(1);
    expect(getDiagBuffer()).toHaveLength(2);
  });

  it('clears the buffer, clock, and frozen report', () => {
    recordDiag({ kind: 'scroll', y: 10, delta: 10 });
    freezeDiagReport();
    clearDiag();
    expect(getDiagBuffer()).toHaveLength(0);
    expect(getDiagReport()).toBeNull();
    // Clock re-anchors after a clear.
    recordDiag({ kind: 'scroll', y: 5, delta: 5 });
    expect(getDiagBuffer()[0].t).toBe(0);
  });

  describe('summarizeDiag', () => {
    it('reports the biggest toward-top jump and that it followed a Done', () => {
      const summary = summarizeDiag([
        { t: 0, kind: 'scroll', y: 1200, delta: 40 },
        { t: 10, kind: 'done', y: 1200, id: 'x' },
        { t: 60, kind: 'scroll', y: 400, delta: -800 },
        { t: 70, kind: 'scroll', y: 0, delta: -400 },
      ]);
      expect(summary.entries).toBe(4);
      expect(summary.biggestJump?.delta).toBe(-800);
      expect(summary.lastDone?.id).toBe('x');
      expect(summary.jumpAfterDoneMs).toBe(50);
    });

    it('times the jump against the Done that precedes it, not the final Done', () => {
      // Done A → big jump → Done B (a second dismiss before Report bug). The jump
      // followed Done A, so jumpAfterDoneMs must measure from A even though B is
      // the last Done in the buffer.
      const summary = summarizeDiag([
        { t: 0, kind: 'done', y: 1200, id: 'A' },
        { t: 40, kind: 'scroll', y: 0, delta: -1200 },
        { t: 500, kind: 'done', y: 0, id: 'B' },
      ]);
      expect(summary.biggestJump?.delta).toBe(-1200);
      expect(summary.jumpAfterDoneMs).toBe(40);
      expect(summary.lastDone?.id).toBe('B');
    });

    it('leaves jumpAfterDoneMs null when the jump preceded the last Done', () => {
      const summary = summarizeDiag([
        { t: 0, kind: 'scroll', y: 0, delta: -900 },
        { t: 50, kind: 'done', y: 0, id: 'x' },
      ]);
      expect(summary.biggestJump?.delta).toBe(-900);
      expect(summary.jumpAfterDoneMs).toBeNull();
    });

    it('reports no jump when nothing scrolled toward the top', () => {
      const summary = summarizeDiag([
        { t: 0, kind: 'scroll', y: 100, delta: 100 },
        { t: 10, kind: 'scroll', y: 300, delta: 200 },
      ]);
      expect(summary.biggestJump).toBeNull();
      expect(summary.jumpAfterDoneMs).toBeNull();
    });
  });

  describe('formatting', () => {
    it('formats a Done row and a scroll row with a signed delta', () => {
      expect(formatDiagEntry({ t: 0, kind: 'done', y: 10, id: 'abc' })).toBe(
        'Done abc',
      );
      expect(
        formatDiagEntry({ t: 0, kind: 'done', y: 10, id: 'abc', title: 'Big news' }),
      ).toBe('Done abc — Big news');
      expect(formatDiagEntry({ t: 0, kind: 'scroll', y: 400, delta: 40 })).toBe(
        'scroll y=400 (+40)',
      );
      expect(formatDiagEntry({ t: 0, kind: 'scroll', y: 0, delta: -800 })).toBe(
        'scroll y=0 (-800)',
      );
    });

    it('appends the scroll ceiling and lock state when present', () => {
      expect(
        formatDiagEntry({
          t: 0,
          kind: 'scroll',
          y: 534,
          delta: -622,
          max: 534,
          locked: false,
        }),
      ).toBe('scroll y=534 (-622) max=534 lock=off');
      expect(
        formatDiagEntry({ t: 0, kind: 'done', y: 1156, id: 'z', title: 'T', max: 1178 }),
      ).toBe('Done z — T max=1178');
    });

    it('headlines a jump that followed a Done', () => {
      const headline = diagHeadline(
        summarizeDiag([
          { t: 0, kind: 'done', y: 1200, id: 'x' },
          { t: 40, kind: 'scroll', y: 0, delta: -1200 },
        ]),
      );
      expect(headline).toBe('Jumped -1200px toward the top 40ms after Done.');
    });

    it('serializes the whole report as pasteable text: headline then rows', () => {
      const text = formatDiagReport([
        { t: 0, kind: 'done', y: 1200, id: 'x' },
        { t: 40, kind: 'scroll', y: 0, delta: -1200 },
      ]);
      expect(text).toBe(
        [
          'Jumped -1200px toward the top 40ms after Done.',
          '0ms\tDone x',
          '40ms\tscroll y=0 (-1200)',
        ].join('\n'),
      );
    });
  });
});
