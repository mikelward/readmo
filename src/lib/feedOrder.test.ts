// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { placeStayInBodyPins } from './feedOrder';
import type { FeedItem } from './types';

// Minimal FeedItem for ordering tests — only id/feedId/publishedAt are read.
function fi(id: string, publishedAt: number, feedId = 'feed-a'): FeedItem {
  return {
    item: {
      id,
      feedId,
      guid: id,
      url: `https://example.com/${id}`,
      title: id,
      author: null,
      publishedAt,
      contentHtml: '',
      summary: null,
      fullContentHtml: null,
      enclosures: [],
    },
    feed: {
      id: feedId,
      url: `https://example.com/${feedId}`,
      siteUrl: null,
      title: feedId,
      faviconUrl: null,
      errorCount: 0,
      lastError: null,
      parked: false,
    },
  };
}

const ids = (list: FeedItem[]) => list.map((f) => f.item.id);

describe('placeStayInBodyPins', () => {
  it('returns the same reference when no ids are held in body', () => {
    const list = [fi('a', 300), fi('b', 200), fi('c', 100)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: false,
      stay: new Set(),
      isPinned: () => false,
    });
    expect(out).toBe(list);
  });

  it('anchors a held row to its body slot after it is unpinned (stale pinned-first cache)', () => {
    // The reader unpinned a held row, but the cache is still pinned-first ('b'
    // lifted to the front) until the unpin's refetch lands. The held id keeps
    // sorting the row back to its date slot rather than leaving it at the top.
    const list = [fi('b', 200), fi('a', 300), fi('c', 100)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: false,
      stay: new Set(['b']),
      isPinned: () => false, // 'b' is no longer pinned
    });
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('returns the same reference when no held id is in the list', () => {
    const list = [fi('a', 300), fi('b', 200), fi('c', 100)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: false,
      stay: new Set(['z']), // held id not present in this list
      isPinned: () => false,
    });
    expect(out).toBe(list);
  });

  it('keeps an in-session pin at its natural date position instead of the top', () => {
    // Data source order: pinned 'b' lifted to the top, then body by date desc.
    const list = [fi('b', 200), fi('a', 300), fi('c', 100)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: false,
      stay: new Set(['b']),
      isPinned: (id) => id === 'b',
    });
    // 'b' falls back into the body and re-sorts by date → a(300), b(200), c(100).
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('lifts a pre-existing pin but keeps an in-session pin in body', () => {
    // 'p' is a pre-existing pin (lifted), 'b' is an in-session pin (stays put).
    const list = [fi('p', 50), fi('b', 200), fi('a', 300), fi('c', 100)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: false,
      stay: new Set(['b']),
      isPinned: (id) => id === 'p' || id === 'b',
    });
    // 'p' stays at the top; body re-sorts by date with 'b' in place.
    expect(ids(out)).toEqual(['p', 'a', 'b', 'c']);
  });

  it('returns an in-session pin to its id-tie-break slot when timestamps are equal', () => {
    // All same publishedAt (dateless feed). Data source order: pinned i2
    // lifted to the front, body in id-desc order (i3, i1). The pin must drop
    // back to its natural slot (id desc: i3, i2, i1), not keep the front.
    const list = [fi('i2', 100), fi('i3', 100), fi('i1', 100)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: false,
      stay: new Set(['i2']),
      isPinned: (id) => id === 'i2',
    });
    expect(ids(out)).toEqual(['i3', 'i2', 'i1']);
  });

  it('honors ascending (oldest-first) body order', () => {
    const list = [fi('b', 200), fi('a', 100), fi('c', 300)];
    const out = placeStayInBodyPins(list, {
      groupByFeed: false,
      sortAsc: true,
      stay: new Set(['b']),
      isPinned: (id) => id === 'b',
    });
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('reorders within each feed run and keeps sections contiguous', () => {
    // Two feed sections; an in-session pin in each.
    const list = [
      fi('a2', 200, 'feed-a'),
      fi('a1', 300, 'feed-a'),
      fi('a3', 100, 'feed-a'),
      fi('b2', 200, 'feed-b'),
      fi('b1', 300, 'feed-b'),
      fi('b3', 100, 'feed-b'),
    ];
    const out = placeStayInBodyPins(list, {
      groupByFeed: true,
      sortAsc: false,
      stay: new Set(['a2', 'b2']),
      isPinned: (id) => id === 'a2' || id === 'b2',
    });
    expect(ids(out)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
  });
});
