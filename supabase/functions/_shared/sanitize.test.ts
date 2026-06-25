// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sanitizeContent } from './sanitize.ts';

describe('sanitizeContent', () => {
  const base = 'https://pub.example.com/articles/42';

  it('strips <script> tags and their contents', () => {
    const out = sanitizeContent(
      '<p>Hello</p><script>alert(1)</script>',
      base,
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>Hello</p>');
  });

  it('drops inline event handlers (onerror, onclick)', () => {
    const out = sanitizeContent(
      '<img src="/x.png" onerror="steal()"><a href="/y" onclick="hack()">y</a>',
      base,
    );
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).not.toContain('steal()');
    expect(out).not.toContain('hack()');
  });

  it('rejects javascript: hrefs', () => {
    const out = sanitizeContent('<a href="javascript:alert(1)">x</a>', base);
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('forces rel="noopener noreferrer" and target on links', () => {
    const out = sanitizeContent('<a href="https://x.com/">link</a>', base);
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it('absolutizes relative href against the base URL', () => {
    const out = sanitizeContent('<a href="/relative">link</a>', base);
    expect(out).toContain('href="https://pub.example.com/relative"');
  });

  it('absolutizes a relative img src and routes it through the image proxy', () => {
    const out = sanitizeContent('<img src="pics/a.png">', base);
    expect(out).toContain(
      'src="/api/img?url=' +
        encodeURIComponent('https://pub.example.com/articles/pics/a.png') +
        '"',
    );
    // The publisher origin is never present as a directly-loadable src.
    expect(out).not.toContain('src="https://pub.example.com/articles/pics/a.png"');
  });

  it('routes srcset candidates through the image proxy, preserving descriptors', () => {
    const out = sanitizeContent(
      '<img src="/a.png" srcset="/a.png 1x, /a@2x.png 2x">',
      base,
    );
    expect(out).toContain(
      '/api/img?url=' + encodeURIComponent('https://pub.example.com/a.png') + ' 1x',
    );
    expect(out).toContain(
      '/api/img?url=' + encodeURIComponent('https://pub.example.com/a@2x.png') + ' 2x',
    );
  });

  it('keeps commas inside a single srcset URL (Cloudflare image-resizing path)', () => {
    // The Economist (and many CDNs) embed comma-separated params in the URL
    // path: /cdn-cgi/image/width=1424,quality=80,format=auto/…/img.jpg.
    // Splitting srcset naively on "," shredded this into fragments like
    // "quality=80", which then absolutized into a bogus article-relative URL
    // the image proxy could only 502 on. The whole URL must survive intact.
    const url =
      'https://www.economist.com/cdn-cgi/image/width=1424,quality=80,format=auto/content-assets/images/img.jpg';
    const out = sanitizeContent(
      `<img srcset="${url} 1424w">`,
      'https://www.economist.com/science-and-technology/2026/06/24/headline',
    );
    expect(out).toContain(
      '/api/img?url=' + encodeURIComponent(url) + ' 1424w',
    );
    // The previous naive split absolutized the "quality=80" fragment against
    // the article URL into this bogus target — it must never be emitted.
    expect(out).not.toContain(
      encodeURIComponent(
        'https://www.economist.com/science-and-technology/2026/06/24/quality=80',
      ),
    );
    // Exactly one proxied candidate, not one per comma-fragment.
    expect(out.match(/\/api\/img\?url=/g)).toHaveLength(1);
  });

  it('proxies multiple comma-bearing srcset candidates with descriptors', () => {
    const big =
      'https://img.example.com/cdn-cgi/image/width=1424,quality=80/a.jpg';
    const small =
      'https://img.example.com/cdn-cgi/image/width=712,quality=80/a.jpg';
    const out = sanitizeContent(
      `<img srcset="${big} 1424w, ${small} 712w">`,
      base,
    );
    expect(out).toContain('/api/img?url=' + encodeURIComponent(big) + ' 1424w');
    expect(out).toContain('/api/img?url=' + encodeURIComponent(small) + ' 712w');
  });

  it('proxies descriptor-less srcset candidates (comma-only separator)', () => {
    const out = sanitizeContent(
      '<img srcset="/a.png, /b.png">',
      base,
    );
    expect(out).toContain(
      '/api/img?url=' + encodeURIComponent('https://pub.example.com/a.png'),
    );
    expect(out).toContain(
      '/api/img?url=' + encodeURIComponent('https://pub.example.com/b.png'),
    );
  });

  it('leaves inline data: images un-proxied', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const out = sanitizeContent(`<img src="${dataUri}">`, base);
    expect(out).toContain(`src="${dataUri}"`);
    expect(out).not.toContain('/api/img');
  });

  it('does not proxy media enclosure <source src> (audio/video)', () => {
    const out = sanitizeContent(
      '<audio controls><source src="/ep.mp3" type="audio/mpeg"></audio>',
      base,
    );
    expect(out).toContain('src="https://pub.example.com/ep.mp3"');
    expect(out).not.toContain('/api/img');
  });

  it('routes a <video poster> through the image proxy', () => {
    const out = sanitizeContent(
      '<video poster="https://tracker.example/pixel.gif" src="/clip.mp4"></video>',
      base,
    );
    expect(out).toContain(
      'poster="/api/img?url=' +
        encodeURIComponent('https://tracker.example/pixel.gif') +
        '"',
    );
    // The publisher-controlled poster is never a directly-loadable URL.
    expect(out).not.toContain('poster="https://tracker.example/pixel.gif"');
  });

  it('absolutizes a relative <video poster> before proxying it', () => {
    const out = sanitizeContent('<video poster="thumbs/p.jpg"></video>', base);
    expect(out).toContain(
      'poster="/api/img?url=' +
        encodeURIComponent('https://pub.example.com/articles/thumbs/p.jpg') +
        '"',
    );
  });

  it('does not proxy the <video src> media enclosure', () => {
    const out = sanitizeContent(
      '<video src="/clip.mp4" poster="/p.jpg" controls></video>',
      base,
    );
    expect(out).toContain('src="https://pub.example.com/clip.mp4"');
    // Only the poster is proxied, never the video file itself.
    expect(out).not.toContain('/api/img?url=' + encodeURIComponent('https://pub.example.com/clip.mp4'));
  });

  it('returns empty string for null/empty input', () => {
    expect(sanitizeContent(null, base)).toBe('');
    expect(sanitizeContent('', base)).toBe('');
  });

  it('drops disallowed tags like <iframe> and <form>', () => {
    const out = sanitizeContent(
      '<iframe src="https://evil"></iframe><form><input></form><p>ok</p>',
      base,
    );
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).toContain('<p>ok</p>');
  });

  it('unwraps <small> but keeps its text (presentational lede, not semantic)', () => {
    // The Economist wraps an article's opening words in <small> for a
    // small-caps lede; we strip the tag so those words render at body size,
    // while preserving the words themselves.
    const out = sanitizeContent(
      '<p><small>On Monday morning,</small> another bout of history happened.</p>',
      base,
    );
    expect(out).not.toContain('<small');
    expect(out).toContain('On Monday morning,');
    expect(out).toContain('another bout of history happened.');
  });
});
