import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useHomeFeed } from '../hooks/useHomeFeed';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useItemSort, useGroupByFeed } from '../hooks/useReadingPrefs';
import { ItemList } from '../components/ItemList';
import { HomeEmptyCoach } from '../components/HomeEmptyCoach';
import { PER_FEED_WINDOW } from '../lib/types';
import './PageHeader.css';

/** `/` — the aggregate river across all non-muted subscriptions, or a chosen
 * folder when the drawer Home picker has swapped it (URL stays `/`). */
export function HomePage() {
  const ds = useDataSource();
  const { homeFeed } = useHomeFeed();
  const { itemSort } = useItemSort();
  const { groupByFeed } = useGroupByFeed();
  useDocumentTitle('readmo');

  // The drawer's ['subscriptions'] query, but forced to re-read on mount
  // (`refetchOnMount: 'always'`, same pattern as FeedPage's feed-meta) so a
  // persisted/within-staleTime *empty* array can't strand a user on the coach
  // after they add their first feed on another device. We treat the result as
  // authoritative only when a *successful* read has landed this mount:
  // `isSuccess` excludes a failed refetch (which keeps the stale data but flips
  // the result to status 'error'), and `isFetchedAfterMount` excludes the
  // pre-refetch cached value. Until then the feed view mounts and does its own
  // fresh read, so a stale or offline-failed empty cache never suppresses real
  // items.
  const { data: subs, isSuccess, isFetchedAfterMount } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
    refetchOnMount: 'always',
    // While the coach is up the feed ItemList (and its pull-to-refresh) is
    // unmounted, so this is the only observer left for ['subscriptions']. Opt
    // it out of the app-wide refetchOnWindowFocus/Reconnect: false so a user
    // who adds their first feed on another tab/device and returns to a
    // long-open coach gets a refresh on focus/reconnect once the empty result
    // goes stale — without it they'd be stuck on the coach until reload.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const subsFresh = isSuccess && isFetchedAfterMount;

  // Brand-new account with no subscriptions: coach them to add a feed rather
  // than show an empty feed (which implies they had items and read them).
  // Checked before the folder override because with zero subscriptions every
  // folder view is empty too, so a stale per-device "Home = folder" preference
  // would otherwise strand a fresh account on a dead-end folder empty state.
  // Gated on a fresh read (not just any cached success) so a slow load doesn't
  // flash the coach and a stale empty cache doesn't suppress the feed; a user
  // with only muted feeds still has subscriptions, so they get the normal
  // caught-up state, not this.
  if (subsFresh && subs?.length === 0) {
    return <HomeEmptyCoach />;
  }
  // Fold the sort/group prefs into both the query key (so a change refetches
  // from page 1 with the new ordering) and the fetch options. Grouping windows
  // each feed section to PER_FEED_WINDOW rows up front; the per-section "More"
  // pages deeper into one feed via getFeedItems. The read overfetches ONE extra
  // row per feed (PER_FEED_WINDOW + 1) as a has-more probe — the client renders
  // only the window and uses the surviving extra to decide whether to show a
  // section "More", so an exactly-full feed shows none instead of a dead button.
  const opts = {
    sort: itemSort,
    groupByFeed,
    ...(groupByFeed ? { perFeedLimit: PER_FEED_WINDOW + 1 } : {}),
  };
  const prefKey = `${itemSort}:${groupByFeed ? 'grouped' : 'flat'}`;
  const fetchFeedPage = groupByFeed
    ? (feedId: string, cursor: string | null) =>
        ds.getFeedItems(feedId, { cursor, sort: itemSort, limit: PER_FEED_WINDOW })
    : undefined;
  if (homeFeed.kind === 'folder') {
    const name = homeFeed.name;
    return (
      <ItemList
        viewKey={`home-folder:${name}:${prefKey}`}
        fetchPage={(cursor) => ds.getFolderItems(name, { cursor, ...opts })}
        emptyLabel={`No items in ${name}.`}
        groupByFeed={groupByFeed}
        fetchFeedPage={fetchFeedPage}
        perFeedLimit={groupByFeed ? PER_FEED_WINDOW : undefined}
      />
    );
  }
  return (
    <ItemList
      viewKey={`home-all:${prefKey}`}
      fetchPage={(cursor) => ds.getHomeItems({ cursor, ...opts })}
      emptyLabel="You’re all caught up."
      groupByFeed={groupByFeed}
      fetchFeedPage={fetchFeedPage}
      perFeedLimit={groupByFeed ? PER_FEED_WINDOW : undefined}
    />
  );
}

/** `/folder/:name` — a folder's aggregate. */
export function FolderPage() {
  const { name = '' } = useParams();
  const ds = useDataSource();
  const { itemSort } = useItemSort();
  const { groupByFeed } = useGroupByFeed();
  useDocumentTitle(`${name} · readmo`);
  const prefKey = `${itemSort}:${groupByFeed ? 'grouped' : 'flat'}`;
  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">{name}</h1>
      </div>
      <ItemList
        viewKey={`folder:${name}:${prefKey}`}
        fetchPage={(cursor) =>
          ds.getFolderItems(name, {
            cursor,
            sort: itemSort,
            groupByFeed,
            // +1 = overfetch one row per feed as a has-more probe (see HomePage).
            ...(groupByFeed ? { perFeedLimit: PER_FEED_WINDOW + 1 } : {}),
          })
        }
        emptyLabel={`No items in ${name}.`}
        groupByFeed={groupByFeed}
        fetchFeedPage={
          groupByFeed
            ? (feedId, cursor) =>
                ds.getFeedItems(feedId, {
                  cursor,
                  sort: itemSort,
                  limit: PER_FEED_WINDOW,
                })
            : undefined
        }
        perFeedLimit={groupByFeed ? PER_FEED_WINDOW : undefined}
      />
    </>
  );
}

/** `/feed/:feedId` — a single feed (includes a muted feed's own items). */
export function FeedPage() {
  const { feedId = '' } = useParams();
  const ds = useDataSource();
  const { itemSort } = useItemSort();
  const queryClient = useQueryClient();
  const { data: feed } = useQuery({
    queryKey: ['feed-meta', feedId],
    queryFn: () => ds.getFeed(feedId),
    // Always re-fetch on mount so a title override applied during subscribe (or
    // any server-side rename) is reflected immediately on navigation, rather
    // than waiting out the default 5-minute staleTime from the persisted cache.
    refetchOnMount: 'always',
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
      {/* Single feed: sort order applies; grouping-by-feed is a no-op (one
          feed), so no section headers. */}
      <ItemList
        viewKey={`feed:${feedId}:${itemSort}`}
        fetchPage={(cursor) => ds.getFeedItems(feedId, { cursor, sort: itemSort })}
        emptyLabel="No items in this feed yet."
      />
    </>
  );
}
