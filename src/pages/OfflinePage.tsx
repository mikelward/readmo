import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useStateBucket } from '../hooks/useItemState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useShareItem } from '../hooks/useShareItem';
import { ItemRow } from '../components/ItemRow';
import './PageHeader.css';
import '../components/ItemList.css';

/** `/offline` — items already cached on this device. Pinned and Favorited
 * items are prefetched at toggle time (SPEC.md *Prefetch on Pin/Favorite*),
 * so they are the always-available offline set. */
export function OfflinePage() {
  const ds = useDataSource();
  const share = useShareItem();
  const pinned = useStateBucket('pinned');
  const favorite = useStateBucket('favorite');
  useDocumentTitle('Offline · readmo');

  const ids = Array.from(new Set([...pinned, ...favorite]));
  const { data: items = [] } = useQuery({
    queryKey: ['offline', ids.join(',')],
    queryFn: () => ds.getItemsByIds(ids),
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-header__title">Offline</h1>
      </div>
      {items.length === 0 ? (
        <div className="item-list__state">
          <p>Nothing saved offline yet. Pin or favorite items to keep a copy.</p>
        </div>
      ) : (
        <ul className="item-list__rows">
          {items.map((fi) => (
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
    </div>
  );
}
