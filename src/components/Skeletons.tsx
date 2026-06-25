import './Skeletons.css';

export function StoryRowSkeleton() {
  return (
    <div className="skeleton-row" role="presentation" aria-hidden="true">
      <div className="skeleton-row__body">
        <div className="skeleton-row__title" />
        <div className="skeleton-row__title skeleton-row__title--short" />
        <div className="skeleton-row__domain" />
      </div>
      <div className="skeleton-row__btn" />
    </div>
  );
}

export function ThreadSkeleton() {
  return (
    <div className="skeleton-thread" role="presentation" aria-hidden="true">
      <div className="skeleton-thread__title" />
      <div className="skeleton-thread__article" />
      <div className="skeleton-thread__meta" />
      <div className="skeleton-thread__comment" />
      <div className="skeleton-thread__comment" />
      <div className="skeleton-thread__comment" />
    </div>
  );
}

/** Article-reader placeholder: a source line, a two-line title, a byline, then
 * a run of body lines. Mirrors the reader header + body so a loading article
 * reads as content arriving (newshacker shows ThreadSkeleton here; readmo has no
 * comments, so the body is prose lines instead of comment blocks). */
export function ReaderSkeleton() {
  return (
    <div className="skeleton-reader" role="presentation" aria-hidden="true">
      <div className="skeleton-reader__source" />
      <div className="skeleton-reader__title" />
      <div className="skeleton-reader__title skeleton-reader__title--short" />
      <div className="skeleton-reader__byline" />
      <div className="skeleton-reader__body">
        <div className="skeleton-reader__line" />
        <div className="skeleton-reader__line" />
        <div className="skeleton-reader__line skeleton-reader__line--short" />
        <div className="skeleton-reader__line" />
        <div className="skeleton-reader__line skeleton-reader__line--short" />
        <div className="skeleton-reader__line" />
      </div>
    </div>
  );
}

export function UserSkeleton() {
  return (
    <div className="skeleton-user" role="presentation" aria-hidden="true">
      <div className="skeleton-user__id" />
      <div className="skeleton-user__stats" />
      <div className="skeleton-user__about" />
    </div>
  );
}
