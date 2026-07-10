import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { ItemRows } from '../components/ItemRows';
import { ListPage } from '../components/ListPage';

/** `/search` — search over feed + item titles (SPEC.md *Search*; MVP is title
 * search, body search deferred). */
export function SearchPage() {
  const ds = useDataSource();
  const [query, setQuery] = useState('');
  usePageTitle('Search');

  // Every keystroke is a new query key with no data until its fetch settles.
  // keepPreviousData holds the prior keystroke's results on screen through the
  // refetch, and isLoading gates the very first search — without both, the page
  // affirmatively shows "No matches." while the request is still in flight.
  const { data: results = [], isLoading, isFetching, isPlaceholderData } = useQuery({
    queryKey: ['search', query],
    queryFn: () => ds.search(query),
    enabled: query.trim().length > 0,
    placeholderData: keepPreviousData,
  });
  // An empty SETTLED result carried forward as the placeholder reads as a
  // successful non-loading query (isLoading false), which would show
  // "No matches." for the next search while it's still in flight. A non-empty
  // placeholder stays visible (not the spinner) — that's the point of keeping
  // the previous results.
  const searching =
    isLoading || (isFetching && isPlaceholderData && results.length === 0);

  return (
    <ListPage
      header={
        <input
          type="search"
          className="search-input"
          placeholder="Search titles and feeds"
          value={query}
          autoFocus
          aria-label="Search"
          onChange={(e) => setQuery(e.target.value)}
        />
      }
    >
      {query.trim() ? (
        <ItemRows items={results} isLoading={searching} emptyLabel="No matches." />
      ) : null}
    </ListPage>
  );
}
