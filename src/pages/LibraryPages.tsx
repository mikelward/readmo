import type { ReactNode } from 'react';
import { useDataSource } from '../lib/data/context';
import { useStateBucket } from '../hooks/useItemState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { LibraryItemList } from '../components/LibraryItemList';
import { ListPage } from '../components/ListPage';
import {
  CheckCircleFilled,
  FavoriteFilled,
  MarkUnread,
  PushPinFilled,
} from '../components/icons';
import type { ItemStateField } from '../lib/types';

interface LibraryPageProps {
  title: string;
  field: ItemStateField;
  actionLabel: string;
  actionIcon: ReactNode;
  emptyLabel: string;
  /** Library views that accumulate (done/opened/hidden) get a "Forget all"
   * toolbar; permanent collections (pinned/favorites) do not. */
  forgettable?: boolean;
}

function LibraryPage({
  title,
  field,
  actionLabel,
  actionIcon,
  emptyLabel,
  forgettable,
}: LibraryPageProps) {
  const ds = useDataSource();
  const ids = useStateBucket(field);
  useDocumentTitle(`${title} · readmo`);

  return (
    <ListPage
      header={
        <>
          <h1 className="page-header__title">{title}</h1>
          {forgettable && ids.length > 0 ? (
            <button
              type="button"
              className="page-header__badge"
              style={{ background: 'var(--rm-meta)' }}
              onClick={() => ids.forEach((id) => ds.stateStore.set(id, field, false))}
            >
              Forget all
            </button>
          ) : null}
        </>
      }
    >
      <LibraryItemList
        field={field}
        actionLabel={actionLabel}
        actionIcon={actionIcon}
        emptyLabel={emptyLabel}
      />
    </ListPage>
  );
}

export function PinnedPage() {
  return (
    <LibraryPage
      title="Pinned"
      field="pinned"
      actionLabel="Unpin"
      actionIcon={<PushPinFilled />}
      emptyLabel="Your reading list is empty. Pin items to read later."
    />
  );
}

export function FavoritesPage() {
  return (
    <LibraryPage
      title="Favorites"
      field="favorite"
      actionLabel="Unfavorite"
      actionIcon={<FavoriteFilled />}
      emptyLabel="No favorites yet. Favorite an article from the reader to keep it."
    />
  );
}

export function DonePage() {
  return (
    <LibraryPage
      title="Done"
      field="done"
      actionLabel="Unmark done"
      actionIcon={<CheckCircleFilled />}
      emptyLabel="Nothing completed yet."
      forgettable
    />
  );
}

export function OpenedPage() {
  return (
    <LibraryPage
      title="Opened"
      field="opened"
      actionLabel="Mark unread"
      actionIcon={<MarkUnread />}
      emptyLabel="Nothing opened in the last 7 days."
      forgettable
    />
  );
}
