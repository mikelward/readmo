import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useStateBucket } from '../hooks/useItemState';
import { useShareItem } from '../hooks/useShareItem';
import type { ItemStateField } from '../lib/types';
import { ItemRow } from './ItemRow';
import './ItemList.css';

interface Props {
  /** Which state bucket this view lists. */
  field: ItemStateField;
  /** Accessible label + tooltip for the right-side inverse button. */
  actionLabel: string;
  /** Filled, accent-colored icon for the inverse action. */
  actionIcon: ReactNode;
  emptyLabel: string;
}

/** A library view (/pinned, /favorites, /done, /hidden, /opened): the same
 * item row with the right-side button swapped to the view's inverse action
 * (SPEC.md *Library views*). Swipe is disabled here. */
export function LibraryItemList({
  field,
  actionLabel,
  actionIcon,
  emptyLabel,
}: Props) {
  const ds = useDataSource();
  const store = ds.stateStore;
  const ids = useStateBucket(field);
  const share = useShareItem();

  const query = useQuery({
    queryKey: ['library', field, ids.join(',')],
    queryFn: () => ds.getItemsByIds(ids),
  });

  const items = query.data ?? [];

  if (query.isLoading) {
    return (
      <ul className="item-list__skeletons" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="item-list__skeleton" />
        ))}
      </ul>
    );
  }

  if (items.length === 0) {
    return (
      <div className="item-list__state">
        <p>{emptyLabel}</p>
      </div>
    );
  }

  return (
    <ul className="item-list__rows">
      {items.map((fi) => (
        <li key={fi.item.id} className="item-list__row">
          <ItemRow
            feedItem={fi}
            enableSwipe={false}
            onShare={() => share({ title: fi.item.title, url: fi.item.url })}
            rightAction={{
              label: actionLabel,
              icon: actionIcon,
              testId: `library-action-${field}`,
              onToggle: () => store.set(fi.item.id, field, false),
            }}
          />
        </li>
      ))}
    </ul>
  );
}
