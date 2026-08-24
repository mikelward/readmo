import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useHomeFeed } from '../hooks/useHomeFeed';
import { usePageTitle } from '../hooks/useDocumentTitle';
import {
  useItemSort,
  useGroupByFeed,
  useArticlesPerPage,
  useArticlesPerSection,
} from '../hooks/useReadingPrefs';
import { ItemList } from '../components/ItemList';
import { HomeEmptyCoach } from '../components/HomeEmptyCoach';
import { Edit } from '../components/icons';
import { FeedFavicon } from '../components/FeedFavicon';
import {
  DEFAULT_ARTICLES_PER_PAGE,
  type ArticleLoadCount,
} from '../lib/types';
import './PageHeader.css';

/** The size's contribution to a view key — EMPTY at the default size, so a
 * default-sized view keeps the exact key it had before the sizes were
 * configurable. The key is what the persisted query cache is stored under
 * (`['feed', viewKey]`, see useFeedItems), so suffixing it unconditionally
 * would orphan every entry a pre-upgrade client wrote: a PWA that upgrades and
 * opens OFFLINE would meet an empty query and no articles, instead of its
 * cached list under a failed refresh (guardrail 11 — Codex P2 on #667). Both
 * defaults are the values that shipped before, so almost every reader keeps
 * their cache; only someone who has actually chosen a size takes the one-time
 * miss, which is the trade a different page size implies anyway. */
function sizeKey(size: ArticleLoadCount, defaultSize: ArticleLoadCount): string {
  return size === defaultSize ? '' : `:${size}`;
}

/** `/` — the aggregate river across all non-muted subscriptions, or a chosen
 * folder when the drawer Home picker has swapped it (URL stays `/`). */
export function HomePage() {
  const ds = useDataSource();
  const { homeFeed } = useHomeFeed();
  const { itemSort, setItemSort } = useItemSort();
  const { groupByFeed, setGroupByFeed } = useGroupByFeed();
  const { articlesPerPage } = useArticlesPerPage();
  const { articlesPerSection } = useArticlesPerSection();
  const toggleGroupByFeed = () => setGroupByFeed(!groupByFeed);
  const toggleSort = () => setItemSort(itemSort === 'newest' ? 'oldest' : 'newest');
  usePageTitle();

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
  // from page 1 with the new ordering) and the fetch options. The page size
  // joins them on the flat path only — there it decides what's fetched. The
  // section size never does; see the key below.
  //
  // Grouping fetches each feed's whole listable set in the one deep read — the
  // client sends NO fetch cap, so `limit` must be left off entirely here; the
  // server decides how much each section carries and the view accepts all of
  // it. Each section then opens at `articlesPerSection` and its "More" reveals
  // the next `articlesPerSection` from those already-fetched rows until they're
  // spent — a section's fetched run IS the feed, so an exhausted section shows
  // no dead "More" button.
  const opts = groupByFeed
    ? { sort: itemSort, groupByFeed }
    : { sort: itemSort, groupByFeed, limit: articlesPerPage };
  // Grouped carries NO size: the section window is display-only over a read
  // that already fetched every section in full, so keying the query on it would
  // discard the cached response and re-read the server to re-window rows
  // already in hand (and offline, replace a good cached list with an error).
  // ItemList re-seeds its windows off the `perFeedLimit` prop instead.
  const prefKey = `${itemSort}:${
    groupByFeed
      ? 'grouped'
      : `flat${sizeKey(articlesPerPage, DEFAULT_ARTICLES_PER_PAGE)}`
  }`;
  if (homeFeed.kind === 'folder') {
    const name = homeFeed.name;
    return (
      <ItemList
        viewKey={`home-folder:${name}:${prefKey}`}
        fetchPage={(cursor) => ds.getFolderItems(name, { cursor, ...opts })}
        emptyLabel={`No items in ${name}.`}
        groupByFeed={groupByFeed}
        perFeedLimit={groupByFeed ? articlesPerSection : undefined}
        onToggleGroupByFeed={toggleGroupByFeed}
        itemSort={itemSort}
        onToggleSort={toggleSort}
      />
    );
  }
  return (
    <ItemList
      viewKey={`home-all:${prefKey}`}
      fetchPage={(cursor) => ds.getHomeItems({ cursor, ...opts })}
      emptyLabel="You’re all caught up."
      groupByFeed={groupByFeed}
      perFeedLimit={groupByFeed ? articlesPerSection : undefined}
      onToggleGroupByFeed={toggleGroupByFeed}
      itemSort={itemSort}
      onToggleSort={toggleSort}
    />
  );
}

/** `/folder/:name` — a folder's aggregate. */
export function FolderPage() {
  const { name = '' } = useParams();
  const ds = useDataSource();
  const { itemSort, setItemSort } = useItemSort();
  const { groupByFeed, setGroupByFeed } = useGroupByFeed();
  const { articlesPerPage } = useArticlesPerPage();
  const { articlesPerSection } = useArticlesPerSection();
  usePageTitle(name);
  // Grouped carries NO size: the section window is display-only over a read
  // that already fetched every section in full, so keying the query on it would
  // discard the cached response and re-read the server to re-window rows
  // already in hand (and offline, replace a good cached list with an error).
  // ItemList re-seeds its windows off the `perFeedLimit` prop instead.
  const prefKey = `${itemSort}:${
    groupByFeed
      ? 'grouped'
      : `flat${sizeKey(articlesPerPage, DEFAULT_ARTICLES_PER_PAGE)}`
  }`;
  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">{name}</h1>
      </div>
      <ItemList
        viewKey={`folder:${name}:${prefKey}`}
        fetchPage={(cursor) =>
          // Grouped: one deep read with NO client fetch cap, windowed for
          // display at `articlesPerSection`; flat: `limit` is the page size
          // (see HomePage).
          ds.getFolderItems(name, {
            cursor,
            sort: itemSort,
            groupByFeed,
            ...(groupByFeed ? null : { limit: articlesPerPage }),
          })
        }
        emptyLabel={`No items in ${name}.`}
        groupByFeed={groupByFeed}
        perFeedLimit={groupByFeed ? articlesPerSection : undefined}
        onToggleGroupByFeed={() => setGroupByFeed(!groupByFeed)}
        itemSort={itemSort}
        onToggleSort={() =>
          setItemSort(itemSort === 'newest' ? 'oldest' : 'newest')
        }
      />
    </>
  );
}

/** `/feed/:feedId` — a single feed (includes a muted feed's own items). */
export function FeedPage() {
  const { feedId = '' } = useParams();
  const ds = useDataSource();
  const { itemSort, setItemSort } = useItemSort();
  const { articlesPerPage } = useArticlesPerPage();
  const queryClient = useQueryClient();
  const { data: feed } = useQuery({
    queryKey: ['feed-meta', feedId],
    queryFn: () => ds.getFeed(feedId),
    // Always re-fetch on mount so a title override applied during subscribe (or
    // any server-side rename) is reflected immediately on navigation, rather
    // than waiting out the default 5-minute staleTime from the persisted cache.
    refetchOnMount: 'always',
  });
  usePageTitle(feed?.title);

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
        <h1 className="page-header__title">
          {/* Feed favicon left of the name, matching the reader bars and rows. */}
          <FeedFavicon
            url={feed?.faviconUrl}
            name={feed?.title}
            className="page-header__favicon"
            size={20}
            testId="feed-header-favicon"
          />
          {feed?.title ?? 'Feed'}
        </h1>
        {/* Pencil to the feed-management page, where this feed can be renamed,
            muted, or unsubscribed. Sits immediately after the title; any parked
            badge floats to the far right past it. The `feed` query param tells
            the Feeds page which row to scroll to and briefly highlight. */}
        <Link
          to={`/feeds?feed=${encodeURIComponent(feedId)}`}
          className="page-header__edit"
          aria-label="Feed settings"
          title="Feed settings"
          data-testid="feed-settings-link"
        >
          <Edit width={20} height={20} />
        </Link>
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
        viewKey={`feed:${feedId}:${itemSort}${sizeKey(
          articlesPerPage,
          DEFAULT_ARTICLES_PER_PAGE,
        )}`}
        fetchPage={(cursor) =>
          ds.getFeedItems(feedId, {
            cursor,
            sort: itemSort,
            limit: articlesPerPage,
          })
        }
        emptyLabel="No items in this feed yet."
        itemSort={itemSort}
        onToggleSort={() =>
          setItemSort(itemSort === 'newest' ? 'oldest' : 'newest')
        }
      />
    </>
  );
}
