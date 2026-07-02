import { describe, expect, it } from 'vitest';
import {
  MAX_SUMMARY_CONTENT_CHARS,
  SUMMARY_TRUNCATION_TEXT_THRESHOLD,
  buildSummaryPrompt,
  clampSummaryText,
  htmlToPlainText,
  looksTruncatedHtml,
  parseGeminiText,
  pickStoredContent,
} from './summary';

describe('htmlToPlainText', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText(undefined)).toBe('');
    expect(htmlToPlainText('')).toBe('');
  });

  it('strips tags and decodes the surviving entities', () => {
    const html = '<p>Tom &amp; Jerry say &lt;hi&gt;</p><p>second &quot;para&quot;</p>';
    const text = htmlToPlainText(html);
    expect(text).toContain('Tom & Jerry say <hi>');
    expect(text).toContain('second "para"');
    expect(text).not.toContain('<p>');
  });

  it('turns block boundaries into paragraph breaks and collapses runs', () => {
    const text = htmlToPlainText('<p>one</p><p>two</p><br>three');
    expect(text).toBe('one\n\ntwo\n\nthree');
  });
});

describe('looksTruncatedHtml', () => {
  it('treats a short stub as truncated and a long body as full', () => {
    expect(looksTruncatedHtml('<p>just a teaser…</p>')).toBe(true);
    expect(looksTruncatedHtml(null)).toBe(true);
    const long = `<p>${'word '.repeat(SUMMARY_TRUNCATION_TEXT_THRESHOLD)}</p>`;
    expect(looksTruncatedHtml(long)).toBe(false);
  });
});

describe('pickStoredContent', () => {
  const fullBody = `<p>${'word '.repeat(SUMMARY_TRUNCATION_TEXT_THRESHOLD)}</p>`;

  it('prefers the full extracted article and marks it cacheable', () => {
    const picked = pickStoredContent({
      contentHtml: '<p>stub</p>',
      fullContentHtml: '<p>the whole article body</p>',
    });
    expect(picked).toEqual({ text: 'the whole article body', cacheable: true });
  });

  it('uses a non-truncated feed body and marks it cacheable', () => {
    const picked = pickStoredContent({ contentHtml: fullBody, fullContentHtml: null });
    expect(picked?.cacheable).toBe(true);
    expect(picked?.text).toContain('word');
  });

  it('uses a truncated feed stub but marks it NOT cacheable', () => {
    const picked = pickStoredContent({
      contentHtml: '<p>just the teaser</p>',
      fullContentHtml: null,
    });
    expect(picked).toEqual({ text: 'just the teaser', cacheable: false });
  });

  it('returns null when there is nothing to summarize', () => {
    expect(pickStoredContent({ contentHtml: '', fullContentHtml: null })).toBeNull();
    expect(
      pickStoredContent({ contentHtml: '<p>   </p>', fullContentHtml: '' }),
    ).toBeNull();
  });

  it('clamps very long bodies to the content cap', () => {
    const huge = `<p>${'x'.repeat(MAX_SUMMARY_CONTENT_CHARS + 5000)}</p>`;
    const picked = pickStoredContent({ contentHtml: huge, fullContentHtml: null });
    expect(picked).not.toBeNull();
    expect(picked!.text.length).toBeLessThanOrEqual(MAX_SUMMARY_CONTENT_CHARS);
  });
});

describe('clampSummaryText', () => {
  it('returns null for empty/whitespace input', () => {
    expect(clampSummaryText(null)).toBeNull();
    expect(clampSummaryText(undefined)).toBeNull();
    expect(clampSummaryText('')).toBeNull();
    expect(clampSummaryText('   \n  ')).toBeNull();
  });

  it('passes short text through trimmed (markdown is kept as-is)', () => {
    expect(clampSummaryText('  # Heading\n\nBody **text**.  ')).toBe(
      '# Heading\n\nBody **text**.',
    );
  });

  it('clamps to the content cap', () => {
    const huge = 'x'.repeat(MAX_SUMMARY_CONTENT_CHARS + 5000);
    const out = clampSummaryText(huge);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(MAX_SUMMARY_CONTENT_CHARS);
  });
});

describe('buildSummaryPrompt', () => {
  it('asks for a tl;dr and embeds the title and content', () => {
    const prompt = buildSummaryPrompt('A Title', 'the body text');
    expect(prompt).toContain('Provide a tl;dr of the following article:');
    expect(prompt).toContain('A Title');
    expect(prompt).toContain('the body text');
    expect(prompt).toContain('--- BEGIN ARTICLE ---');
    expect(prompt).toContain('--- END ARTICLE ---');
  });

  it('stays unsteered: no length, format, or register instructions beyond the tl;dr ask', () => {
    const prompt = buildSummaryPrompt('A Title', 'body');
    expect(prompt).not.toContain('sentences');
    expect(prompt).not.toContain('bullet');
    expect(prompt).not.toContain('Markdown');
    expect(prompt).not.toContain('meta-framing');
  });

  it('omits the title clause when there is no title', () => {
    const prompt = buildSummaryPrompt(null, 'body');
    expect(prompt).not.toContain('titled');
  });
});

describe('parseGeminiText', () => {
  it('joins the first candidate parts and trims', () => {
    const json = {
      candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world.  ' }] } }],
    };
    expect(parseGeminiText(json)).toBe('Hello world.');
  });

  it('returns null for a safety-blocked / empty / malformed response', () => {
    expect(parseGeminiText(null)).toBeNull();
    expect(parseGeminiText(undefined)).toBeNull();
    expect(parseGeminiText({ candidates: [] })).toBeNull();
    expect(parseGeminiText({ candidates: [{ content: { parts: [] } }] })).toBeNull();
    expect(
      parseGeminiText({ candidates: [{ content: { parts: [{ text: '   ' }] } }] }),
    ).toBeNull();
  });
});
