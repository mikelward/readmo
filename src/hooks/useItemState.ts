import { useCallback, useSyncExternalStore } from 'react';
import { useDataSource } from '../lib/data/context';
import type { ItemId, ItemState, ItemStateField } from '../lib/types';

/**
 * Subscribe to a single item's state. Re-renders whenever the shared
 * ItemStateStore changes (any tab/component that toggles a field). Returns
 * the current state plus typed togglers that enforce the mutation-layer
 * shields via the store.
 */
export function useItemState(id: ItemId): {
  state: ItemState;
  set: (field: ItemStateField, value: boolean) => void;
  toggle: (field: ItemStateField) => void;
} {
  const ds = useDataSource();
  const store = ds.stateStore;

  const state = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.get(id),
    () => store.get(id),
  );

  const set = useCallback(
    (field: ItemStateField, value: boolean) => {
      store.set(id, field, value);
    },
    [store, id],
  );

  const toggle = useCallback(
    (field: ItemStateField) => {
      store.set(id, field, !store.get(id)[field]);
    },
    [store, id],
  );

  return { state, set, toggle };
}

/** Snapshot of every item's id that currently holds `field` (used by library
 * views). Sorted by the field's timestamp, newest first. */
export function useStateBucket(field: ItemStateField): ItemId[] {
  const ds = useDataSource();
  const store = ds.stateStore;

  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => selectBucket(store.entries(), field),
    () => selectBucket(store.entries(), field),
  );
}

const bucketCache = new WeakMap<object, { key: string; ids: ItemId[] }>();

/** Memoize the derived id-array so useSyncExternalStore's referential
 * equality check doesn't see a fresh array every render (which would loop).
 * Keyed on a stable token per field+entries signature. */
function selectBucket(
  entries: Array<[ItemId, ItemState]>,
  field: ItemStateField,
): ItemId[] {
  const atKey = `${field}At` as const;
  const filtered = entries
    .filter(([, s]) => s[field])
    .sort((a, b) => (b[1][atKey] ?? 0) - (a[1][atKey] ?? 0))
    .map(([id]) => id);

  const sig = `${field}:${filtered.join(',')}`;
  const token = FIELD_TOKENS[field];
  const cached = bucketCache.get(token);
  if (cached && cached.key === sig) return cached.ids;
  bucketCache.set(token, { key: sig, ids: filtered });
  return filtered;
}

// Stable per-field tokens to key the memo cache.
const FIELD_TOKENS: Record<ItemStateField, object> = {
  pinned: {},
  favorite: {},
  done: {},
  hidden: {},
  opened: {},
};
