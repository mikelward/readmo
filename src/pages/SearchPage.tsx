import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ItemRows } from '../components/ItemRows';
import { ListPage } from '../components/ListPage';

/** `/search` — search over feed + item titles (SPEC.md *Search*; MVP is title
 * search, body search deferred). */
export function SearchPage() {
  const ds = useDataSource();
  const [query, setQuery] = useState('');
  useDocumentTitle('Search · readmo');

  const { data: results = [] } = useQuery({
    queryKey: ['search', query],
    queryFn: () => ds.search(query),
    enabled: query.trim().length > 0,
  });

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
        <ItemRows items={results} emptyLabel="No matches." />
      ) : null}
    </ListPage>
  );
}
