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

  it('drops navigation link menus but keeps the article prose', () => {
    // A link-dense list like the BBC homepage's "Home / News / Sport …" bar.
    const navList =
      '<ul><li><a href="/">Home</a></li><li><a href="/news">News</a></li>' +
      '<li><a href="/sport">Sport</a></li><li><a href="/weather">Weather</a></li>' +
      '<li><a href="/iplayer">iPlayer</a></li></ul>';
    const result = extractArticle(
      pageWith(navList + LONG_BODY),
      'https://example.com/news/the-headline',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).toContain('genuine article about feed readers');
    // The link menu and its entries are gone.
    expect(result!.contentHtml).not.toMatch(/>Weather</);
    expect(result!.contentHtml).not.toMatch(/href="\/iplayer"/);
  });

  it('keeps a link roundup whose entries read like article titles', () => {
    // A listicle/resource-roundup body: a link-dense list, but each entry is a
    // full headline rather than a short menu label, so it's article content.
    const roundup =
      '<ul>' +
      '<li><a href="/a">How to self-host your photo library in 2026</a></li>' +
      '<li><a href="/b">The complete guide to feed readers and reading modes</a></li>' +
      '<li><a href="/c">Why truncated RSS excerpts are so frustrating to read</a></li>' +
      '</ul>';
    const result = extractArticle(
      pageWith(LONG_BODY + roundup),
      'https://example.com/news/the-headline',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).toContain('self-host your photo library');
    expect(result!.contentHtml).toMatch(/href="https:\/\/example\.com\/c"/);
  });

  it('keeps a genuine content list (few/no links) in the article', () => {
    const contentList =
      '<ul><li>First key takeaway about feed readers.</li>' +
      '<li>Second key takeaway about reading modes.</li>' +
      '<li>Third key takeaway about truncated excerpts.</li></ul>';
    const result = extractArticle(
      pageWith(LONG_BODY + contentList),
      'https://example.com/news/the-headline',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).toContain('First key takeaway');
    expect(result!.contentHtml).toContain('Third key takeaway');
  });

  // A page whose article body opens with a heading Readability keeps (an <h2>),
  // repeating the feed item's title — the case the screenshot showed, where the
  // headline appears once as the reader's own <h1> and again inside the body.
  const DUP_TITLE = 'Have World Cup changes made group stage games unfair?';
  function pageWithBodyHeading(): string {
    return `<!doctype html><html><head><title>Sport — BBC</title></head>
      <body>
        <article>
          <h2>${DUP_TITLE}</h2>
          ${LONG_BODY}
        </article>
      </body></html>`;
  }

  it('drops the body heading when it duplicates the feed item title', () => {
    const result = extractArticle(
      pageWithBodyHeading(),
      'https://example.com/sport/world-cup',
      DUP_TITLE,
    );
    expect(result).not.toBeNull();
    // The duplicate heading is gone, but the prose remains.
    expect(result!.contentHtml).not.toContain(DUP_TITLE);
    expect(result!.contentHtml).toContain('genuine article about feed readers');
  });

  it('matches case/punctuation-insensitively against the title', () => {
    const result = extractArticle(
      pageWithBodyHeading(),
      'https://example.com/sport/world-cup',
      // Trailing whitespace + different case still counts as a duplicate.
      '  have world cup changes made group stage games unfair?  ',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).not.toContain(DUP_TITLE);
  });

  it('matches when the title differs only by internal punctuation', () => {
    // Publishers often render a feed-title separator differently on the page (a
    // colon in the feed vs. an em dash in the heading). Both must compare equal.
    const heading = 'World Cup: the final showdown';
    const page = `<!doctype html><html><head><title>Sport — BBC</title></head>
      <body><article><h2>${heading}</h2>${LONG_BODY}</article></body></html>`;
    const result = extractArticle(
      page,
      'https://example.com/sport/world-cup',
      'World Cup — the final showdown',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).not.toContain(heading);
    expect(result!.contentHtml).toContain('genuine article about feed readers');
  });

  it('keeps a heading that differs from the title only by an in-word symbol', () => {
    // "C++" must not collapse to "C": a distinct leading heading on a tech feed
    // should survive even though it shares the rest of the words with the title.
    const heading = 'C++ memory model explained';
    const page = `<!doctype html><html><head><title>Dev — Blog</title></head>
      <body><article><h2>${heading}</h2>${LONG_BODY}</article></body></html>`;
    const result = extractArticle(
      page,
      'https://example.com/dev/memory',
      'C memory model explained',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).toContain(heading);
  });

  it('keeps the body heading when it does not match the title', () => {
    const result = extractArticle(
      pageWithBodyHeading(),
      'https://example.com/sport/world-cup',
      'A completely different headline',
    );
    expect(result).not.toBeNull();
    expect(result!.contentHtml).toContain(DUP_TITLE);
  });

  it('keeps a section heading that differs from the title', () => {
    const result = extractArticle(
      pageWith('<h2>Background</h2>' + LONG_BODY),
      'https://example.com/news/the-headline',
    );
    expect(result).not.toBeNull();
    // A non-title heading is article content and must survive.
    expect(result!.contentHtml).toMatch(/<h2[^>]*>\s*Background\s*<\/h2>/i);
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
