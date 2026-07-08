// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { leadImageUrl, itemPreviewText } from './itemPreview';
import type { Item } from './types';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    feedId: 'feed-1',
    guid: 'g1',
    url: 'https://example.com/post',
    commentsUrl: null,
    title: 'A headline',
    spoilerFreeTitle: null,
    author: null,
    publishedAt: 0,
    contentHtml: '',
    summary: null,
    fullContentHtml: null,
    enclosures: [],
    ...overrides,
  };
}

const proxied = (url: string) => `/api/img?url=${encodeURIComponent(url)}`;

describe('leadImageUrl', () => {
  it('returns the first proxied image already in the content body', () => {
    const item = makeItem({
      contentHtml:
        '<p>Intro</p><img src="/api/img?url=https%3A%2F%2Fcdn.example.com%2Flead.jpg" alt="">',
    });
    expect(leadImageUrl(item)).toBe(
      '/api/img?url=https%3A%2F%2Fcdn.example.com%2Flead.jpg',
    );
  });

  it('collapses a responsive proxied srcset to one candidate', () => {
    const small = '/api/img?url=' + encodeURIComponent('https://cdn.example.com/s.jpg');
    const large = '/api/img?url=' + encodeURIComponent('https://cdn.example.com/l.jpg');
    const item = makeItem({
      contentHtml: `<img srcset="${small} 400w, ${large} 1600w" alt="">`,
    });
    // 1600w is nearest the ~1600px target the extractor picks.
    expect(leadImageUrl(item)).toBe(large);
  });

  it('proxies a raw http(s) content image when none is pre-proxied', () => {
    const item = makeItem({
      contentHtml:
        '<figure><img src="https://www.nasa.gov/example.jpg" alt="Galaxy"></figure>',
    });
    expect(leadImageUrl(item)).toBe(proxied('https://www.nasa.gov/example.jpg'));
  });

  it('prefers an already-proxied content image over a raw one', () => {
    const proxiedSrc = '/api/img?url=' + encodeURIComponent('https://cdn.example.com/a.jpg');
    const item = makeItem({
      contentHtml: `<img src="${proxiedSrc}" alt=""><img src="https://raw.example.com/b.jpg" alt="">`,
    });
    expect(leadImageUrl(item)).toBe(proxiedSrc);
  });

  it('falls back to the first image/* enclosure, routed through the proxy', () => {
    const item = makeItem({
      contentHtml: '<p>No image here</p>',
      enclosures: [
        { url: 'https://example.com/audio.mp3', type: 'audio/mpeg', length: null },
        { url: 'https://cdn.example.com/cover.png', type: 'image/png', length: null },
      ],
    });
    expect(leadImageUrl(item)).toBe(proxied('https://cdn.example.com/cover.png'));
  });

  it('prefers a content image over an enclosure', () => {
    const contentImg = '/api/img?url=' + encodeURIComponent('https://cdn.example.com/body.jpg');
    const item = makeItem({
      contentHtml: `<img src="${contentImg}" alt="">`,
      enclosures: [
        { url: 'https://cdn.example.com/cover.png', type: 'image/png', length: null },
      ],
    });
    expect(leadImageUrl(item)).toBe(contentImg);
  });

  it('ignores a non-image enclosure', () => {
    const item = makeItem({
      enclosures: [
        { url: 'https://example.com/clip.mp4', type: 'video/mp4', length: null },
      ],
    });
    expect(leadImageUrl(item)).toBeNull();
  });

  it('ignores an image enclosure with an unsafe (non-http) URL', () => {
    const item = makeItem({
      enclosures: [
        { url: 'javascript:alert(1)', type: 'image/png', length: null },
      ],
    });
    expect(leadImageUrl(item)).toBeNull();
  });

  it('returns null when there is no usable image anywhere', () => {
    expect(leadImageUrl(makeItem({ contentHtml: '<p>Just text.</p>' }))).toBeNull();
  });

  it('entity-decodes a raw src before proxying (multi-param URLs)', () => {
    // Attribute values in stored HTML are entity-encoded (& → &amp;), so a
    // signed/multi-param image URL must be decoded before it reaches the
    // proxy — otherwise the upstream sees literal "amp;h"/"amp;sig" params.
    const item = makeItem({
      contentHtml:
        '<img src="https://cdn.example.com/p.jpg?w=800&amp;h=600&amp;sig=abc" alt="">',
    });
    expect(leadImageUrl(item)).toBe(
      proxied('https://cdn.example.com/p.jpg?w=800&h=600&sig=abc'),
    );
  });
});

describe('itemPreviewText', () => {
  it('strips tags to plain text', () => {
    const item = makeItem({
      contentHtml: '<p>First para.</p><p>Second <strong>para</strong>.</p>',
    });
    expect(itemPreviewText(item)).toBe('First para. Second para.');
  });

  it('decodes common named and numeric entities', () => {
    const item = makeItem({
      contentHtml: '<p>Tom &amp; Jerry &#8212; it&#39;s &quot;great&quot;</p>',
    });
    expect(itemPreviewText(item)).toBe('Tom & Jerry — it\'s "great"');
  });

  it('collapses whitespace and trims', () => {
    const item = makeItem({
      contentHtml: '<p>  lots\n\n   of    space  </p>',
    });
    expect(itemPreviewText(item)).toBe('lots of space');
  });

  it('drops script/style content defensively', () => {
    const item = makeItem({
      contentHtml: '<style>.a{color:red}</style><p>Visible</p>',
    });
    expect(itemPreviewText(item)).toBe('Visible');
  });

  it('returns an empty string for an empty body', () => {
    expect(itemPreviewText(makeItem({ contentHtml: '' }))).toBe('');
  });

  it('reattaches punctuation split off by a removed inline tag', () => {
    const item = makeItem({
      contentHtml: '<p>Second <em>para</em> .</p>',
    });
    expect(itemPreviewText(item)).toBe('Second para.');
  });

  it('preserves genuine publisher spacing before punctuation', () => {
    // Only gaps introduced by tag removal are re-glued — a scoreline or
    // French spaced punctuation is the publisher's own copy and stays as-is.
    const item = makeItem({
      contentHtml: '<p>United 2 : 1 City. Pourquoi ? Attention !</p>',
    });
    expect(itemPreviewText(item)).toBe(
      'United 2 : 1 City. Pourquoi ? Attention !',
    );
  });
});
