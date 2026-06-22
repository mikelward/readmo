import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useShareItem } from '../hooks/useShareItem';
import { ItemRow } from '../components/ItemRow';
import { ListToolbar } from '../components/ListToolbar';
import './PageHeader.css';
import '../components/ItemList.css';

/** `/search` — search over feed + item titles (SPEC.md *Search*; MVP is title
 * search, body search deferred). */
export function SearchPage() {
  const ds = useDataSource();
  const share = useShareItem();
  const [query, setQuery] = useState('');
  useDocumentTitle('Search · readmo');

  const { data: results = [] } = useQuery({
    queryKey: ['search', query],
    queryFn: () => ds.search(query),
    enabled: query.trim().length > 0,
  });

  return (
    <div>
      <div className="page-header">
        <input
          type="search"
          className="search-input"
          placeholder="Search titles and feeds"
          value={query}
          autoFocus
          aria-label="Search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {query.trim() && results.length === 0 ? (
        <div className="item-list__state">
          <p>No matches.</p>
        </div>
      ) : (
        <ul className="item-list__rows">
          {results.map((fi) => (
            <li key={fi.item.id} className="item-list__row">
              <ItemRow
                feedItem={fi}
                enableSwipe={false}
                onShare={() => share({ title: fi.item.title, url: fi.item.url })}
              />
            </li>
          ))}
        </ul>
      )}
      <ListToolbar placement="bottom" actions={false} />
    </div>
  );
}
