import { useSyncExternalStore } from 'react';
import {
  getConnectivityStatus,
  getOnline,
  subscribeConnectivityStatus,
  subscribeOnline,
  type ConnectivityStatus,
} from '../lib/networkStatus';

// Backed by `networkStatus`, which combines `navigator.onLine` /
// online-offline window events with real fetch-failure signals so the
// "Offline" pill flips as soon as a request fails, not whenever the OS
// eventually notices the radio dropped. See src/lib/networkStatus.ts.
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnline, getOnline);
}

// The three-way view: distinguishes a device with no network ('offline') from
// our backend not answering while the device is connected ('backend-
// unreachable'), so the UI can say "Down" instead of falsely "Offline". Prefer
// `useOnlineStatus` when only the online/not-online boolean matters.
export function useConnectivityStatus(): ConnectivityStatus {
  return useSyncExternalStore(
    subscribeConnectivityStatus,
    getConnectivityStatus,
    getConnectivityStatus,
  );
}
