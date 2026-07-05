import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  clearDiag,
  getDiagBuffer,
  getDiagReport,
  summarizeDiag,
  type DiagEntry,
} from '../lib/scrollDiag';
import './DebugPage.css';
import './PageHeader.css';

// A scroll delta this far toward the top in a single event reads as a jump
// rather than ordinary momentum — highlighted in the timeline.
const JUMP_HIGHLIGHT_PX = 150;

function describeEntry(e: DiagEntry): string {
  if (e.kind === 'done') return `Done ${e.id ?? ''}`.trim();
  const sign = (e.delta ?? 0) > 0 ? '+' : '';
  return `scroll y=${e.y} (${sign}${e.delta ?? 0})`;
}

/** `/debug/scroll` — the frozen scroll-jump timeline captured when the reader
 * taps "Report bug" on a Done toast (see useScrollDiag). Open to everyone (no
 * auth gate); shows only scroll offsets and item ids, no secrets. */
export function ScrollDiagPage() {
  useDocumentTitle('Scroll diagnostics · readmo');
  // Re-read on Clear. The frozen report (captured at Report-bug time) is what we
  // show; fall back to the live buffer when the page is opened directly.
  const [nonce, setNonce] = useState(0);
  // `nonce` (bumped by Clear) is the only trigger to re-read the module buffers,
  // which aren't reactive state.
  const { entries, live } = useMemo(() => {
    void nonce;
    const report = getDiagReport();
    return report
      ? { entries: report, live: false }
      : { entries: getDiagBuffer(), live: true };
  }, [nonce]);
  const summary = useMemo(() => summarizeDiag(entries), [entries]);

  return (
    <div className="debug">
      <div className="page-header">
        <h1 className="page-header__title">Scroll diagnostics</h1>
      </div>

      <p className="debug__summary">
        {summary.entries === 0
          ? 'No timeline recorded yet.'
          : summary.jumpAfterDoneMs != null && summary.biggestJump
            ? `Jumped ${summary.biggestJump.delta}px toward the top ${summary.jumpAfterDoneMs}ms after Done.`
            : summary.biggestJump
              ? `Biggest jump ${summary.biggestJump.delta}px (no Done before it).`
              : 'No upward jump recorded.'}
      </p>

      <section className="debug__section">
        <h2 className="debug__heading">
          Timeline{live ? ' (live)' : ''} · {entries.length}
        </h2>
        {entries.length === 0 ? (
          <>
            <p className="debug__value">
              Turn on “Scroll-jump diagnostics”, dismiss an article, then tap
              “Report bug” on the Done toast.
            </p>
            <Link to="/debug" className="debug__link">
              Debug page
            </Link>
          </>
        ) : (
          <ol className="scroll-diag__list">
            {entries.map((e, i) => (
              <li
                key={i}
                className="scroll-diag__row"
                data-kind={e.kind}
                data-jump={
                  e.kind === 'scroll' && (e.delta ?? 0) <= -JUMP_HIGHLIGHT_PX
                    ? ''
                    : undefined
                }
              >
                <span className="scroll-diag__t">{e.t}ms</span>
                <span className="scroll-diag__desc">{describeEntry(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="debug__section">
        <button
          type="button"
          className="scroll-diag__clear"
          onClick={() => {
            clearDiag();
            setNonce((n) => n + 1);
          }}
        >
          Clear timeline
        </button>
      </section>
    </div>
  );
}
