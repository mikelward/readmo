import { useSummary } from '../hooks/useSummary';
import { MarkdownText } from './MarkdownText';
import type { ItemId } from '../lib/types';
import './ArticleSummary.css';

interface ArticleSummaryProps {
  id: ItemId;
  /** The summary is a feature of pinned articles: it's generated when an
   * allowlisted user pins, and shown only while the item stays pinned. */
  pinned: boolean;
  online: boolean;
}

/**
 * AI summary card shown at the top of the reader — below the toolbar, above the
 * article — when an allowlisted user has pinned the article. Renders nothing
 * until there's something to show (not pinned, off-allowlist, nothing to
 * summarize, or a soft failure), so it stays silent like reading mode. Always
 * mounted by the reader (hook order stays stable); the gating lives in
 * `useSummary`.
 */
export function ArticleSummary({ id, pinned, online }: ArticleSummaryProps) {
  const { summary, loading } = useSummary(id, { pinned, online });

  if (!pinned) return null;
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
  if (!summary) return null;

  return (
    <section
      className="article-summary"
      aria-label="AI summary"
      data-testid="article-summary"
    >
      <p className="article-summary__body" data-testid="article-summary-body">
        <MarkdownText text={summary} />
      </p>
      <p className="article-summary__footer">Summary by Gemini</p>
    </section>
  );
}
