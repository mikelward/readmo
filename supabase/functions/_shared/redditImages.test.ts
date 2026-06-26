// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { upgradeRedditThumbnails } from './redditImages.ts';

// A faithful sketch of Reddit's RSS/Atom item body: the thumbnail <img> wrapped
// in a permalink, plus the "submitted by … [link] [comments]" tail where
// "[link]" carries the submission's real target URL.
function redditBody(opts: {
  thumbSrc: string;
  linkHref: string;
  thumbAttrs?: string;
}): string {
  const attrs = opts.thumbAttrs ?? 'alt="Train Driving Licence" title="Train Driving Licence"';
  return [
    '<table><tr>',
    `<td><a href="https://www.reddit.com/r/pics/comments/abc123/a_cool_photo/">`,
    `<img src="${opts.thumbSrc}" ${attrs}/></a></td>`,
    '<td> submitted by <a href="https://www.reddit.com/user/InterestingSock7519">/u/InterestingSock7519</a> <br/>',
    `<span><a href="${opts.linkHref}">[link]</a></span> `,
    '<span><a href="https://www.reddit.com/r/pics/comments/abc123/a_cool_photo/">[comments]</a></span>',
    '</td></tr></table>',
  ].join('');
}

describe('upgradeRedditThumbnails', () => {
  it('swaps a b.thumbs.redditmedia.com thumbnail for the i.redd.it full image', () => {
    const out = upgradeRedditThumbnails(
      redditBody({
        thumbSrc: 'https://b.thumbs.redditmedia.com/AbCdEf123.jpg',
        linkHref: 'https://i.redd.it/fullsize9876.jpeg',
      }),
    );
    expect(out).toContain('src="https://i.redd.it/fullsize9876.jpeg"');
    expect(out).not.toContain('b.thumbs.redditmedia.com');
  });

  it('swaps a cropped preview.redd.it thumbnail for the full image', () => {
    const out = upgradeRedditThumbnails(
      redditBody({
        thumbSrc: 'https://preview.redd.it/cropped.jpg?width=640&crop=smart&s=sig',
        linkHref: 'https://i.redd.it/original.png',
      }),
    );
    expect(out).toContain('src="https://i.redd.it/original.png"');
    expect(out).not.toContain('preview.redd.it');
  });

  it('upgrades an external-preview.redd.it thumbnail when [link] ends in an image extension', () => {
    const out = upgradeRedditThumbnails(
      redditBody({
        thumbSrc: 'https://external-preview.redd.it/xyz.jpg?auto=webp&s=sig',
        linkHref: 'https://images.example.com/photos/full.jpeg',
      }),
    );
    expect(out).toContain('src="https://images.example.com/photos/full.jpeg"');
  });

  it('drops the thumbnail srcset and intrinsic width/height when upgrading', () => {
    const out = upgradeRedditThumbnails(
      redditBody({
        thumbSrc: 'https://b.thumbs.redditmedia.com/t.jpg',
        linkHref: 'https://i.redd.it/full.jpeg',
        thumbAttrs:
          'width="140" height="140" srcset="https://b.thumbs.redditmedia.com/t.jpg 1x" alt="x"',
      }),
    );
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('width=');
    expect(out).not.toContain('height=');
    expect(out).toContain('src="https://i.redd.it/full.jpeg"');
  });

  it('leaves a gallery post untouched ([link] is not a direct image)', () => {
    const html = redditBody({
      thumbSrc: 'https://b.thumbs.redditmedia.com/g.jpg',
      linkHref: 'https://www.reddit.com/gallery/abc123',
    });
    expect(upgradeRedditThumbnails(html)).toBe(html);
  });

  it('leaves an external-article link post untouched', () => {
    const html = redditBody({
      thumbSrc: 'https://b.thumbs.redditmedia.com/a.jpg',
      linkHref: 'https://example.com/news/story',
    });
    expect(upgradeRedditThumbnails(html)).toBe(html);
  });

  it('does not upgrade when [link] is a non-http(s) scheme', () => {
    const html = redditBody({
      thumbSrc: 'https://b.thumbs.redditmedia.com/a.jpg',
      linkHref: 'javascript:alert(1)//x.jpg',
    });
    expect(upgradeRedditThumbnails(html)).toBe(html);
  });

  it('leaves the body alone when the only image is not a Reddit thumbnail', () => {
    // An i.redd.it image already inline (no cropped thumbnail to replace).
    const html = redditBody({
      thumbSrc: 'https://i.redd.it/already-full.jpeg',
      linkHref: 'https://i.redd.it/already-full.jpeg',
    });
    expect(upgradeRedditThumbnails(html)).toBe(html);
  });

  it('bails when there are multiple Reddit thumbnails (unexpected shape)', () => {
    const html =
      '<img src="https://b.thumbs.redditmedia.com/one.jpg"/>' +
      '<img src="https://b.thumbs.redditmedia.com/two.jpg"/>' +
      '<a href="https://i.redd.it/full.jpeg">[link]</a>';
    expect(upgradeRedditThumbnails(html)).toBe(html);
  });

  it('is a no-op for non-Reddit content with no "[link]" anchor', () => {
    const html = '<p>An ordinary article.</p><figure><img src="https://cdn.example.com/x.jpg"/></figure>';
    expect(upgradeRedditThumbnails(html)).toBe(html);
  });

  it('handles null/empty input', () => {
    expect(upgradeRedditThumbnails(null)).toBe('');
    expect(upgradeRedditThumbnails(undefined)).toBe('');
    expect(upgradeRedditThumbnails('')).toBe('');
  });

  it('matches "[link]" case-insensitively and ignores surrounding whitespace', () => {
    const html =
      '<img src="https://preview.redd.it/p.jpg"/>' +
      '<a href="https://i.redd.it/full.jpeg">  [LINK]  </a>';
    const out = upgradeRedditThumbnails(html);
    expect(out).toContain('src="https://i.redd.it/full.jpeg"');
  });
});
