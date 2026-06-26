import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeForMatch,
  findHnDiscussion,
  newshackerThreadUrl,
} from './hnDiscussion';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('canonicalizeForMatch', () => {
  it('ignores scheme, www, trailing slash, and fragment', () => {
    const a = canonicalizeForMatch('http://www.example.com/post/');
    const b = canonicalizeForMatch('https://example.com/post#section');
    expect(a).toBe('example.com/post');
    expect(a).toBe(b);
  });

  it('strips tracking params but keeps meaningful query (order-independent)', () => {
    const a = canonicalizeForMatch('https://example.com/a?id=7&utm_source=hn&b=2');
    const b = canonicalizeForMatch('https://example.com/a?b=2&id=7&fbclid=xyz');
    expect(a).toBe('example.com/a?b=2&id=7');
    expect(a).toBe(b);
  });

  it('returns null for non-http(s) or unparseable URLs', () => {
    expect(canonicalizeForMatch('mailto:a@b.com')).toBeNull();
    expect(canonicalizeForMatch('javascript:alert(1)')).toBeNull();
    expect(canonicalizeForMatch('not a url')).toBeNull();
  });
});

describe('newshackerThreadUrl', () => {
  it('builds the newshacker thread URL for a story id', () => {
    expect(newshackerThreadUrl('4242')).toBe('https://newshacker.app/item/4242');
  });
});

describe('findHnDiscussion', () => {
  const url = 'https://example.com/the-article';

  it('returns the matching story, preferring the most-commented submission', async () => {
    const fetchImpl = vi.fn(async (_input: string) =>
      jsonResponse({
        hits: [
          { objectID: '100', url: 'https://example.com/the-article', num_comments: 3, points: 50 },
          // A second submission of the SAME url with more comments wins.
          { objectID: '200', url: 'http://www.example.com/the-article/', num_comments: 9, points: 5 },
          // A different article must be ignored even though Algolia returned it.
          { objectID: '300', url: 'https://example.com/other', num_comments: 999, points: 1 },
        ],
      }),
    );
    const result = await findHnDiscussion(url, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ id: '200', numComments: 9 });
    // The article URL is sent as the query against the url attribute.
    const calledWith = String(fetchImpl.mock.calls[0][0]);
    expect(calledWith).toContain('hn.algolia.com');
    expect(calledWith).toContain('restrictSearchableAttributes=url');
  });

  it('returns null when no returned hit canonicalizes to the article URL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ hits: [{ objectID: '1', url: 'https://elsewhere.com/x', num_comments: 4 }] }),
    );
    expect(await findHnDiscussion(url, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('skips hits missing an id or url', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        hits: [
          { url: 'https://example.com/the-article', num_comments: 5 },
          { objectID: '7' },
        ],
      }),
    );
    expect(await findHnDiscussion(url, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    expect(await findHnDiscussion(url, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('returns null when the request throws (offline)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await findHnDiscussion(url, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('returns null without fetching for a non-http URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hits: [] }));
    expect(
      await findHnDiscussion('mailto:a@b.com', fetchImpl as unknown as typeof fetch),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not forward a possibly-tokenized article URL to Algolia', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hits: [] }));
    // A query string (a private feed's article URL may carry ?token=…).
    expect(
      await findHnDiscussion(
        'https://example.com/article?token=secret',
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBeNull();
    // A long hex blob in the path.
    expect(
      await findHnDiscussion(
        'https://example.com/a/0123456789abcdef0123456789abcdef',
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
