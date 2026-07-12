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
  /** The summary already delivered ON the item row (the allowlisted ride-along
   * from `feed_items`, 0058). When present it renders instantly — no Edge call,
   * no "Summarizing…" placeholder. Null → fall back to the on-demand
   * `useSummary` flow (just-pinned, old backend, off-allowlist). */
  cachedSummary?: string | null;
}

/**
 * AI summary card shown at the top of the reader — below the toolbar, above the
 * article — for an allowlisted user. Generates automatically only for an article
 * pinned before opening; otherwise it offers a "Generate summary" button.
 * Renders nothing when there's nothing to show (off-allowlist, nothing to
 * summarize, service not configured), so it stays silent like reading mode —
 * except for the two cases where the user was promised a summary: a transient
 * failure of a requested generation shows a Retry, and a pinned article opened
 * offline with nothing cached says so (both ported from newshacker's summary
 * card). Always mounted by the reader (hook order stays stable); the gating
 * lives in `useSummary`.
 */
export function ArticleSummary({
  id,
  online,
  autoGenerate,
  cachedSummary,
}: ArticleSummaryProps) {
  const { summary, loading, canGenerate, generate, failed, retry, offlineWithoutCache } =
    useSummary(id, {
      online,
      autoGenerate,
      initialSummary: cachedSummary,
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
  if (failed) {
    return (
      <section
        className="article-summary"
        aria-label="AI summary"
        data-testid="article-summary-error"
      >
        <p className="article-summary__error">Could not summarize.</p>
        <button
          type="button"
          className="article-summary__generate article-summary__retry"
          data-testid="article-summary-retry"
          onClick={retry}
        >
          Retry
        </button>
      </section>
    );
  }
  if (offlineWithoutCache) {
    return (
      <section
        className="article-summary"
        aria-label="AI summary"
        data-testid="article-summary-offline"
      >
        <p className="article-summary__error">Summary not available offline.</p>
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
