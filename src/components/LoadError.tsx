import './LoadError.css';

interface Props {
  /** Friendly summary naming the action that failed. */
  headline: string;
  /** Curated one-line pointer at the cause, shown behind a "Details" disclosure.
   *  Omit/null for plain connectivity states (offline/unreachable) where there's
   *  nothing technical to add. */
  detail?: string | null;
  /** Retry handler. Omit to render no button (e.g. the offline reader state,
   *  where retrying can't help). */
  onRetry?: () => void;
  retryLabel?: string;
}

/** The one load-failure panel every view uses, so a failed read looks and reads
 * the same everywhere: a friendly headline, an optional expandable "Details"
 * with the curated underlying message (reachable on mobile, where the console
 * isn't), and an optional Retry. Pair with `loadFailureCopy` for the strings. */
export function LoadError({ headline, detail, onRetry, retryLabel = 'Retry' }: Props) {
  return (
    <div className="load-error" role="alert">
      <p className="load-error__headline">{headline}</p>
      {detail ? (
        <details className="load-error__details">
          <summary>Details</summary>
          <p className="load-error__detail-text">{detail}</p>
        </details>
      ) : null}
      {onRetry ? (
        <button type="button" className="load-error__retry" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
