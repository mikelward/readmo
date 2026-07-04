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
  stripSummaryPreamble,
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

  it('carries the targeted anti-preamble instruction', () => {
    const prompt = buildSummaryPrompt('A Title', 'body');
    expect(prompt).toContain('no preamble');
    expect(prompt).toContain('"tl;dr" label');
    expect(prompt).toContain('The article covers');
  });

  it('stays unsteered on length/register: no length/register instructions', () => {
    const prompt = buildSummaryPrompt('A Title', 'body');
    expect(prompt).not.toContain('sentences');
  });

  it('explicitly requests Markdown, a bulleted list, and no headings', () => {
    const prompt = buildSummaryPrompt('A Title', 'body');
    expect(prompt).toContain('Format the summary in Markdown');
    expect(prompt).toContain('bulleted list');
    expect(prompt).toContain('do not use headings');
  });

  it('omits the title clause when there is no title', () => {
    const prompt = buildSummaryPrompt(null, 'body');
    expect(prompt).not.toContain('titled');
  });
});

describe('stripSummaryPreamble', () => {
  it('strips a bare "tl;dr:" label prefix', () => {
    expect(stripSummaryPreamble('tl;dr: The team shipped a new feature.')).toBe(
      'The team shipped a new feature.',
    );
    expect(stripSummaryPreamble('TL;DR — The team shipped a new feature.')).toBe(
      'The team shipped a new feature.',
    );
    expect(stripSummaryPreamble('tldr: no semicolon variant.')).toBe(
      'no semicolon variant.',
    );
  });

  it('strips markdown-emphasized labels', () => {
    expect(stripSummaryPreamble('**TL;DR:** The gist here.')).toBe('The gist here.');
    expect(stripSummaryPreamble('**tl;dr** the gist here.')).toBe('the gist here.');
    expect(stripSummaryPreamble('## Summary\n\nThe gist here.')).toBe('The gist here.');
  });

  it('preserves the summary\'s own opening emphasis after a stripped label', () => {
    // The trailing mop-up must not eat the first token's markdown.
    expect(stripSummaryPreamble('TL;DR: **OpenAI** launched a new model.')).toBe(
      '**OpenAI** launched a new model.',
    );
    expect(stripSummaryPreamble('Summary: _OpenAI_ launched a new model.')).toBe(
      '_OpenAI_ launched a new model.',
    );
    expect(
      stripSummaryPreamble("Here's a tl;dr of the article: **OpenAI** launched."),
    ).toBe('**OpenAI** launched.');
    // The label's OWN closing emphasis is still removed.
    expect(stripSummaryPreamble('**TL;DR:** **OpenAI** launched.')).toBe(
      '**OpenAI** launched.',
    );
  });

  it('strips a "Here\'s a tl;dr of the article:" lead-in sentence', () => {
    expect(
      stripSummaryPreamble(
        "Here's a tl;dr of the article: The article covers various news stories, including several updates.",
      ),
    ).toBe('The article covers various news stories, including several updates.');
    expect(
      stripSummaryPreamble('Here is a summary of the article: It rained.'),
    ).toBe('It rained.');
    expect(
      stripSummaryPreamble('Sure, here is the tl;dr: It rained.'),
    ).toBe('It rained.');
  });

  it('strips stacked preambles', () => {
    expect(
      stripSummaryPreamble("Here's a tl;dr of the article: **TL;DR:** It rained."),
    ).toBe('It rained.');
  });

  it('leaves a clean summary untouched', () => {
    const clean = 'The article covers various news stories, including updates.';
    expect(stripSummaryPreamble(clean)).toBe(clean);
  });

  it('does not strip a mid-sentence mention of tl;dr', () => {
    const text = 'The author gives a tl;dr at the end of the post.';
    expect(stripSummaryPreamble(text)).toBe(text);
  });

  it('keeps a lead-in where "summary" is an adjective, not the offered object', () => {
    const legal = 'This is a summary judgment case: the court ruled for the plaintiff.';
    expect(stripSummaryPreamble(legal)).toBe(legal);
    const stats = 'Here are the summary statistics: the mean was 4.2.';
    expect(stripSummaryPreamble(stats)).toBe(stats);
  });

  it('keeps a leading TLDR proper noun when no label delimiter follows', () => {
    // The tldr project / TLDR newsletter: "TLDR" is the subject, not a label.
    const text = 'TLDR Pages is a community-driven collection of man pages.';
    expect(stripSummaryPreamble(text)).toBe(text);
    const news = 'TLDR newsletter rounded up the week in tech.';
    expect(stripSummaryPreamble(news)).toBe(news);
  });

  it('does not strip a summary that merely begins with the word Summary in prose', () => {
    const text = 'Summary judgment was granted to the defendant.';
    // "Summary judgment" has no label separator after "Summary", so it survives.
    expect(stripSummaryPreamble(text)).toBe(text);
  });

  it('trims surrounding whitespace', () => {
    expect(stripSummaryPreamble('  \n  tl;dr:  It rained.  \n')).toBe('It rained.');
  });

  it('preserves a bullet list under a stripped label (does not eat the marker)', () => {
    // Regression: the prompt now asks for "-" bullet lists, and the line-agnostic
    // mop-up used to treat the first "- " as a separator, dropping the marker so
    // the first point rendered as prose. The whole list must survive.
    expect(stripSummaryPreamble('Summary:\n- First point\n- Second point')).toBe(
      '- First point\n- Second point',
    );
    expect(stripSummaryPreamble('tl;dr:\n- alpha\n- beta')).toBe('- alpha\n- beta');
    expect(stripSummaryPreamble('**TL;DR:**\n- alpha\n- beta')).toBe('- alpha\n- beta');
    expect(stripSummaryPreamble("Here's a tl;dr of the article:\n- alpha\n- beta")).toBe(
      '- alpha\n- beta',
    );
    // A blank line between the label and the list is still fully stripped.
    expect(stripSummaryPreamble('Summary:\n\n- alpha\n- beta')).toBe('- alpha\n- beta');
  });

  it('preserves inline emphasis in the first bullet under a stripped label', () => {
    expect(stripSummaryPreamble('tl;dr:\n- **OpenAI** shipped a model\n- prices fell')).toBe(
      '- **OpenAI** shipped a model\n- prices fell',
    );
  });

  it('keeps a real head paragraph above a bullet list', () => {
    const text = 'The release lands three changes:\n- faster sync\n- dark mode';
    expect(stripSummaryPreamble(text)).toBe(text);
  });

  it('leaves a bullet list with no preamble untouched', () => {
    expect(stripSummaryPreamble('- alpha\n- beta')).toBe('- alpha\n- beta');
    expect(stripSummaryPreamble('* alpha\n* beta')).toBe('* alpha\n* beta');
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
