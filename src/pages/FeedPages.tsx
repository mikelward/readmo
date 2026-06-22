import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useHomeFeed } from '../hooks/useHomeFeed';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ItemList } from '../components/ItemList';
import './PageHeader.css';

/** `/` — the aggregate river across all non-muted subscriptions, or a chosen
 * folder when the drawer Home picker has swapped it (URL stays `/`). */
export function HomePage() {
  const ds = useDataSource();
  const { homeFeed } = useHomeFeed();
  useDocumentTitle('readmo');

  if (homeFeed.kind === 'folder') {
    const name = homeFeed.name;
    return (
      <ItemList
        viewKey={`home-folder:${name}`}
        fetchPage={(cursor) => ds.getFolderItems(name, { cursor })}
        emptyLabel={`No items in ${name}.`}
      />
    );
  }
  return (
    <ItemList
      viewKey="home-all"
      fetchPage={(cursor) => ds.getHomeItems({ cursor })}
      emptyLabel="You’re all caught up."
    />
  );
}

/** `/folder/:name` — a folder's aggregate. */
export function FolderPage() {
  const { name = '' } = useParams();
  const ds = useDataSource();
  useDocumentTitle(`${name} · readmo`);
  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">{name}</h1>
      </div>
      <ItemList
        viewKey={`folder:${name}`}
        fetchPage={(cursor) => ds.getFolderItems(name, { cursor })}
        emptyLabel={`No items in ${name}.`}
      />
    </>
  );
}

/** `/feed/:feedId` — a single feed (includes a muted feed's own items). */
export function FeedPage() {
  const { feedId = '' } = useParams();
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { data: feed } = useQuery({
    queryKey: ['feed-meta', feedId],
    queryFn: () => ds.getFeed(feedId),
  });
  useDocumentTitle(feed ? `${feed.title} · readmo` : 'readmo');

  // Un-park, then refetch the badge's own query plus the drawer's feed-health
  // list (both read a cloned Feed, so they go stale until invalidated).
  const retry = useMutation({
    mutationFn: () => ds.retryParkedFeed(feedId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feed-meta', feedId] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    },
  });

  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">{feed?.title ?? 'Feed'}</h1>
        {feed?.parked ? (
          <button
            type="button"
            className="page-header__badge"
            title={feed.lastError ?? 'Feed parked after repeated failures'}
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            Feed has errors · Retry now
          </button>
        ) : null}
      </div>
      <ItemList
        viewKey={`feed:${feedId}`}
        fetchPage={(cursor) => ds.getFeedItems(feedId, { cursor })}
        emptyLabel="No items in this feed yet."
      />
    </>
  );
}
