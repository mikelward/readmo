import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useStateBucket } from '../hooks/useItemState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ItemRows } from '../components/ItemRows';
import { ListPage } from '../components/ListPage';
import { resolveSavedItems } from '../lib/offlineItems';

/** `/offline` — items already cached on this device. Pinned and Favorited
 * items are warmed at toggle time (SPEC.md *Prefetch on Pin/Favorite*;
 * useOfflineCacheLock), so they are the always-available offline set. */
export function OfflinePage() {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const pinned = useStateBucket('pinned');
  const favorite = useStateBucket('favorite');
  useDocumentTitle('Offline · readmo');

  const ids = Array.from(new Set([...pinned, ...favorite]));
  const { data: items = [] } = useQuery({
    queryKey: ['offline', ids.join(',')],
    queryFn: () => resolveSavedItems(ds, queryClient, ids),
  });

  return (
    <ListPage header={<h1 className="page-header__title">Offline</h1>}>
      <ItemRows
        items={items}
        emptyLabel="Nothing saved offline yet. Pin or favorite items to keep a copy."
      />
    </ListPage>
  );
}
