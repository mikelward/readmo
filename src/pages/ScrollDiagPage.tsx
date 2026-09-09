import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import {
  clearDiag,
  diagHeadline,
  formatDiagEntry,
  formatDiagReport,
  getDiagBuffer,
  getDiagReport,
  summarizeDiag,
} from '../lib/scrollDiag';
import './DebugPage.css';
import './PageHeader.css';

// A scroll delta this far toward the top in a single event reads as a jump
// rather than ordinary momentum — highlighted in the timeline.
const JUMP_HIGHLIGHT_PX = 150;

/** `/debug/scroll` — the frozen scroll-jump timeline captured when the reader
 * taps "Report bug" on a Done toast (see useScrollDiag). Open to everyone (no
 * auth gate); the timeline is a per-device in-memory buffer (scroll offsets +
 * the dismissed article's id/headline — the caller's own content, never server
 * data or another user's). */
export function ScrollDiagPage() {
  usePageTitle('Scroll diagnostics');
  const { showToast } = useToast();
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

  const copyReport = useCallback(async () => {
    const text = formatDiagReport(entries);
    try {
      // navigator.clipboard is HTTPS/localhost-only and absent in some webviews;
      // fall through to the error toast rather than throwing when it's missing.
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      showToast({ message: 'Copied timeline' });
    } catch {
      showToast({
        message: "Couldn't copy — select the text manually",
        detail: text,
      });
    }
  }, [entries, showToast]);

  return (
    <div className="debug">
      <div className="page-header">
        <h1 className="page-header__title">Scroll diagnostics</h1>
      </div>

      <p className="debug__summary">{diagHeadline(summary)}</p>

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
                <span className="scroll-diag__desc">{formatDiagEntry(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="debug__section scroll-diag__actions">
        <button
          type="button"
          className="scroll-diag__button"
          disabled={entries.length === 0}
          onClick={copyReport}
        >
          Copy timeline
        </button>
        <button
          type="button"
          className="scroll-diag__button"
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
