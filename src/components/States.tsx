import './States.css';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert" data-testid="error-state">
      <p className="state__message">{message}</p>
      {onRetry ? (
        <button type="button" className="retry-btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="state state--empty" data-testid="empty-state">
      <p className="state__message">{message}</p>
    </div>
  );
}

interface LoadingStateProps {
  /** Visually hidden label announced to assistive tech. */
  label?: string;
}

export function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div
      className="state state--loading"
      role="status"
      aria-live="polite"
      data-testid="loading-state"
    >
      <span className="state__spinner" aria-hidden="true" />
      <span className="state__sr-only">{label}</span>
    </div>
  );
}
