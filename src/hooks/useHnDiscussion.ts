import { useQuery } from '@tanstack/react-query';
import { findHnDiscussion, type HnDiscussion } from '../lib/hnDiscussion';
import { isSafeHttpUrl } from '../lib/itemMeta';
import { looksTokenized } from '../lib/urlSafety';

/**
 * Look up the Hacker News discussion for an article URL (via HN's Algolia
 * index) so the reader can offer a comments icon that links into newshacker.
 * Account-independent, so it lives outside the DataSource seam; the result is a
 * stable story id, cached effectively forever (the URL→discussion mapping
 * doesn't change). Disabled when the URL isn't a safe http(s) link or when the
 * caller passes `enabled: false` (e.g. offline), so it never fires a doomed
 * request. Any failure resolves to null → no icon.
 */
export function useHnDiscussion(
  url: string | undefined,
  enabled = true,
): HnDiscussion | null {
  // Skip tokenized URLs (a private feed's article URL may embed a secret) so the
  // query never even fires for them — findHnDiscussion enforces the same gate.
  const usable = !!url && isSafeHttpUrl(url) && !looksTokenized(url);
  const { data } = useQuery({
    queryKey: ['hn-discussion', url],
    queryFn: () => findHnDiscussion(url as string),
    enabled: usable && enabled,
    staleTime: Infinity,
  });
  return data ?? null;
}
