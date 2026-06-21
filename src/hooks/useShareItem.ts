import { useCallback } from 'react';
import {
  buildSharePayload,
  shareOrCopy,
  type ShareableItem,
} from '../lib/share';
import { useToast } from './useToast';

// Shares an item's ORIGINAL article URL via the Web Share API, falling
// back to the clipboard, with a "Link copied" toast on the fallback
// path (SPEC.md *Reader view → Share*). Unlike newshacker's
// useShareStory, this shares the publisher's canonical page, not an
// on-site discussion URL.
export function useShareItem() {
  const { showToast } = useToast();

  return useCallback(
    async (item: ShareableItem) => {
      if (typeof window === 'undefined') return;
      const payload = buildSharePayload(item);
      const nav = window.navigator;
      const canShare =
        typeof nav !== 'undefined' && typeof nav.share === 'function';
      const canCopy =
        typeof nav !== 'undefined' &&
        typeof nav.clipboard?.writeText === 'function';

      const result = await shareOrCopy(payload, {
        share: canShare ? (data) => nav.share(data) : undefined,
        copy: canCopy ? (text) => nav.clipboard.writeText(text) : undefined,
      });

      if (result === 'copied') {
        showToast({ message: 'Link copied' });
      } else if (result === 'unavailable') {
        showToast({ message: 'Sharing not available' });
      }
    },
    [showToast],
  );
}
