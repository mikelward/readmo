// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { extractArticle, MIN_ARTICLE_TEXT } from './fulltext.ts';

/** A realistic article page: a <body> wrapped in site chrome (nav/header/
 * footer/aside) around an <article> with the real content. Readability should
 * keep the article paragraphs and drop the chrome. */
function pageWith(articleHtml: string): string {
  return `<!doctype html><html><head><title>Site — The Headline</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <header><h1>My News Site</h1></header>
      <article>
        <h1>The Headline</h1>
        ${articleHtml}
      </article>
      <aside class="sidebar"><a href="/promo">Subscribe now!</a></aside>
      <footer>© 2026 My News Site. All rights reserved.</footer>
    </body></html>`;
}

const LONG_BODY = Array.from(
  { length: 8 },
  (_, i) =>
    `<p>This is paragraph ${i + 1} of a genuine article about feed readers, ` +
    `reading modes, and why truncated RSS excerpts are frustrating. It is long ` +
    `enough that Readability treats it as the primary content of the page.</p>`,
).join('');

describe('extractArticle', () => {
  it('pulls the article body out of surrounding site chrome', () => {
    const result = extractArticle(
      pageWith(LONG_BODY),
      'https://example.com/news/the-headline',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).toContain('genuine article about feed readers');
    // Site chrome should be dropped.
    expect(result!.contentHtml).not.toContain('Subscribe now!');
    expect(result!.contentHtml).not.toContain('All rights reserved');
    expect(result!.textLength).toBeGreaterThanOrEqual(MIN_ARTICLE_TEXT);
  });

  it('absolutizes/keeps a relative link so the sanitizer can resolve it', () => {
    const result = extractArticle(
      pageWith(LONG_BODY + '<p><a href="/more">related</a></p>'),
      'https://example.com/news/the-headline',
    );
    expect(result).not.toBeNull();
    // Readability resolves against the document base URL we seeded.
    expect(result!.contentHtml).toContain('https://example.com/more');
  });

  it('returns null for a too-thin body (paywall teaser / cookie wall)', () => {
    const result = extractArticle(
      pageWith('<p>Subscribe to read the rest of this story.</p>'),
      'https://example.com/news/paywalled',
    );
    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractArticle('', 'https://example.com')).toBeNull();
  });

  it('does not throw on malformed HTML', () => {
    expect(() =>
      extractArticle('<html><body><p>oops', 'https://example.com'),
    ).not.toThrow();
  });
});
