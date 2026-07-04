import { useSummary } from '../hooks/useSummary';
import { MarkdownText } from './MarkdownText';
import type { ItemId } from '../lib/types';
import './ArticleSummary.css';

interface ArticleSummaryProps {
  id: ItemId;
  online: boolean;
  /** Whether the article was pinned before opening. Pinned → summarize
   * automatically (it's the "I'll read this" signal the prewarm acts on);
   * unpinned → offer a "Generate summary" button instead, so a casual open
   * doesn't spend a Gemini/Jina call. */
  autoGenerate: boolean;
}

/**
 * AI summary card shown at the top of the reader — below the toolbar, above the
 * article — for an allowlisted user. Generates automatically only for an article
 * pinned before opening; otherwise it offers a "Generate summary" button.
 * Renders nothing when there's nothing to show (off-allowlist, offline with
 * nothing cached, nothing to summarize, or a soft failure), so it stays silent
 * like reading mode. Always mounted by the reader (hook order stays stable); the
 * gating lives in `useSummary`.
 */
export function ArticleSummary({ id, online, autoGenerate }: ArticleSummaryProps) {
  const { summary, loading, canGenerate, generate } = useSummary(id, {
    online,
    autoGenerate,
  });

  if (loading) {
    return (
      <section
        className="article-summary"
        aria-label="AI summary"
        aria-busy="true"
        data-testid="article-summary"
      >
        <span className="article-summary__loading" data-testid="article-summary-loading">
          Summarizing…
        </span>
      </section>
    );
  }
  if (canGenerate) {
    return (
      <div className="article-summary article-summary--prompt">
        <button
          type="button"
          className="article-summary__generate"
          data-testid="article-summary-generate"
          onClick={generate}
        >
          Generate summary
        </button>
      </div>
    );
  }
  if (!summary) return null;

  return (
    <section
      className="article-summary"
      aria-label="AI summary"
      data-testid="article-summary"
    >
      <div className="article-summary__body" data-testid="article-summary-body">
        <MarkdownText text={summary} />
      </div>
      <p className="article-summary__footer">Summary by Gemini</p>
    </section>
  );
}
