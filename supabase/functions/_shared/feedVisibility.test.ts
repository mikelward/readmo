// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { feedIsPublic, isTransientAuthError, readItemIfPublicFeed } from './feedVisibility.ts';

describe('feedIsPublic', () => {
  it('is true for a plain public feed url with no secret', () => {
    expect(feedIsPublic({ url: 'https://public.example/feed.xml', secret_url: null })).toBe(true);
  });

  it('is false when a secret_url is present', () => {
    expect(
      feedIsPublic({ url: 'https://news.example/feed', secret_url: 'https://news.example/feed?token=XYZ' }),
    ).toBe(false);
  });

  it('is false when the url looks tokenized', () => {
    expect(
      feedIsPublic({
        url: 'https://paid.example/feed/0123456789abcdef0123456789abcdef/rss.xml',
        secret_url: null,
      }),
    ).toBe(false);
    expect(feedIsPublic({ url: 'https://x.example/feed?token=abc', secret_url: null })).toBe(false);
  });

  it('is false for a missing feed or url', () => {
    expect(feedIsPublic(null)).toBe(false);
    expect(feedIsPublic(undefined)).toBe(false);
    expect(feedIsPublic({ url: null, secret_url: null })).toBe(false);
  });

  it('is false for a non-http(s) scheme (parity with the SQL gate)', () => {
    expect(feedIsPublic({ url: 'ftp://x.example/feed.xml', secret_url: null })).toBe(false);
    expect(feedIsPublic({ url: 'javascript:alert(1)', secret_url: null })).toBe(false);
    expect(feedIsPublic({ url: 'file:///etc/passwd', secret_url: null })).toBe(false);
  });
});

describe('isTransientAuthError', () => {
  it('is true for a 5xx or network (no/zero status) error — retryable outage', () => {
    expect(isTransientAuthError({ status: 500 })).toBe(true);
    expect(isTransientAuthError({ status: 503 })).toBe(true);
    expect(isTransientAuthError({ status: 0 })).toBe(true);
    expect(isTransientAuthError({})).toBe(true);
    expect(isTransientAuthError(new Error('network'))).toBe(true);
  });

  it('is false for a 4xx auth rejection — anon / invalid JWT must be withheld', () => {
    expect(isTransientAuthError({ status: 401 })).toBe(false);
    expect(isTransientAuthError({ status: 403 })).toBe(false);
    expect(isTransientAuthError({ status: 400 })).toBe(false);
  });
});

/** A tiny stub of the service-role Supabase client: one canned single-row reply
 * per table, captured through the `.from(t).select(c).eq(k,v).maybeSingle()`
 * chain that {@link readItemIfPublicFeed} uses. */
function stubService(replies: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () =>
                  replies[table] ?? { data: null, error: null },
              };
            },
          };
        },
      };
    },
  };
}

describe('readItemIfPublicFeed', () => {
  const item = { id: 'i1', feed_id: 'f1', url: 'https://public.example/a', title: 'A' };

  it('returns the item when its feed is public', async () => {
    const svc = stubService({
      items: { data: item },
      feeds: { data: { url: 'https://public.example/feed.xml', secret_url: null } },
    });
    expect(await readItemIfPublicFeed(svc as never, 'i1', 'id, feed_id, url, title')).toEqual(item);
  });

  it('returns null when the feed is private (tokenized url)', async () => {
    const svc = stubService({
      items: { data: item },
      feeds: { data: { url: 'https://x.example/feed?token=abc', secret_url: null } },
    });
    expect(await readItemIfPublicFeed(svc as never, 'i1', 'id, feed_id, url, title')).toBeNull();
  });

  it('returns null when the feed carries a secret_url', async () => {
    const svc = stubService({
      items: { data: item },
      feeds: { data: { url: 'https://news.example/feed', secret_url: 'https://news.example/feed?t=1' } },
    });
    expect(await readItemIfPublicFeed(svc as never, 'i1', 'id, feed_id, url, title')).toBeNull();
  });

  it('returns null when the item is genuinely missing', async () => {
    expect(
      await readItemIfPublicFeed(stubService({ items: { data: null } }) as never, 'i1', 'id, feed_id'),
    ).toBeNull();
  });

  it('THROWS on a transient lookup error (so the caller reports a retryable failure, not a terminal miss)', async () => {
    // Item-read blip.
    await expect(
      readItemIfPublicFeed(
        stubService({ items: { data: null, error: { message: 'boom' } } }) as never,
        'i1',
        'id, feed_id',
      ),
    ).rejects.toThrow('boom');
    // Feed-read blip (item resolved, feed lookup errors).
    await expect(
      readItemIfPublicFeed(
        stubService({ items: { data: item }, feeds: { data: null, error: { message: 'feed blip' } } }) as never,
        'i1',
        'id, feed_id, url, title',
      ),
    ).rejects.toThrow('feed blip');
  });

  it('returns null when the item row lacks a feed_id', async () => {
    const svc = stubService({ items: { data: { id: 'i1' } } });
    expect(await readItemIfPublicFeed(svc as never, 'i1', 'id')).toBeNull();
  });
});
