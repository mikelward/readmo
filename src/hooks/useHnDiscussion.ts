import { useQuery } from '@tanstack/react-query';
import { findHnDiscussion, type HnDiscussion } from '../lib/hnDiscussion';
import { isSafeHttpUrl } from '../lib/itemMeta';
import { looksTokenized } from '../lib/urlSafety';

/**
 * Look up the Hacker News discussion for an article URL (via HN's Algolia
 * index) so the reader can offer a comments icon that links into newshacker.
 * Account-independent, so it lives outside the DataSource seam; the result is a
 * stable story id. Disabled when the URL isn't a safe http(s) link or when the
 * caller passes `enabled: false` (e.g. offline), so it never fires a doomed
 * request. Any failure resolves to null → no icon.
 */
export function useHnDiscussion(
  url: string | undefined,
  enabled = true,
): HnDiscussion | null {
  // Skip tokenized URLs (a private feed's article URL may embed a secret) so the
  // query never even fires for them — findHnDiscussion enforces the same gate.
  const gated = !!url && isSafeHttpUrl(url) && !looksTokenized(url) && enabled;
  const { data } = useQuery({
    queryKey: ['hn-discussion', url],
    queryFn: () => findHnDiscussion(url as string),
    enabled: gated,
    // A FOUND discussion (story id) is immutable, so cache it forever. A null
    // result, though, is either "not on HN yet" or a transient Algolia
    // failure — don't pin that as fresh, or the icon would stay disabled even
    // after the article gets submitted or the API recovers. Let nulls go stale
    // so reopening the article retries (the call is free/keyless).
    staleTime: (query) => (query.state.data ? Infinity : 0),
  });
  // Honor the gate on the RETURNED value, not just the fetch: the cache is keyed
  // on url alone, so a hit cached during an earlier online/public render would
  // otherwise be handed to a later observer that's offline or on a private feed
  // (enabled=false), re-enabling the comments link past the fail-closed gate.
  return gated ? (data ?? null) : null;
}
