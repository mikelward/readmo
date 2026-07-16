import { describe, expect, it, vi } from 'vitest';
import {
  BLOCK_BODY_MAX_CHARS,
  MAX_SUMMARY_CONTENT_CHARS,
  SUMMARY_TRUNCATION_TEXT_THRESHOLD,
  buildSummaryPrompt,
  clampSummaryText,
  coalesceSummaryGeneration,
  htmlToPlainText,
  isBlockingHttpStatus,
  looksLikeBlockPage,
  looksTruncatedHtml,
  parseGeminiText,
  pickStoredContent,
  isSummaryOutcomeTransient,
  siteLabel,
  stripSummaryPreamble,
} from './summary';
import type { SummaryLeaseClient, SummaryOutcome } from './summary';

describe('isSummaryOutcomeTransient', () => {
  it('is transient for a blip a retry could resolve', () => {
    expect(isSummaryOutcomeTransient({ status: 'unreachable' })).toBe(true);
    // A Jina blip / stub-defer — worth another try even if full text fails.
    expect(isSummaryOutcomeTransient({ status: 'empty', retryable: true })).toBe(true);
    // Generated but the shared-row write failed — the fire-and-forget pin path
    // doesn't display it, so it must retry to actually persist ai_summary.
    expect(isSummaryOutcomeTransient({ status: 'ok', cached: false })).toBe(true);
  });

  it('is not transient for a cached ok or a terminal outcome', () => {
    expect(isSummaryOutcomeTransient({ status: 'ok', cached: true })).toBe(false);
    expect(isSummaryOutcomeTransient({ status: 'ok' })).toBe(false); // cached absent → done
    // A non-retryable empty (no URL) and an unconfigured key are terminal.
    expect(isSummaryOutcomeTransient({ status: 'empty' })).toBe(false);
    expect(isSummaryOutcomeTransient({ status: 'empty', retryable: false })).toBe(false);
    expect(isSummaryOutcomeTransient({ status: 'unavailable', retryable: true })).toBe(false);
  });
});

describe('isBlockingHttpStatus', () => {
  it('is a block for stable non-2xx access denials', () => {
    for (const s of [401, 403, 404, 410, 451]) {
      expect(isBlockingHttpStatus(s)).toBe(true);
    }
  });

  it('is not a block for 2xx or transient 429/5xx (they should retry, not stick)', () => {
    for (const s of [200, 204, 301, 429, 500, 502, 503]) {
      expect(isBlockingHttpStatus(s)).toBe(false);
    }
  });
});

describe('looksLikeBlockPage', () => {
  it('matches an error-page title on its own', () => {
    expect(looksLikeBlockPage('403 Forbidden', null)).toBe(true);
    expect(looksLikeBlockPage('Access Denied', 'anything here')).toBe(true);
    expect(looksLikeBlockPage('Unauthorized', '')).toBe(true);
    expect(looksLikeBlockPage('Page Not Found', null)).toBe(true);
  });

  it('matches an unambiguous whole-page signature regardless of body length', () => {
    const long = 'x'.repeat(BLOCK_BODY_MAX_CHARS + 500);
    expect(
      looksLikeBlockPage('My son’s passport combo', `You don't have permission to access ${long}`),
    ).toBe(true);
    expect(looksLikeBlockPage(null, 'Sorry, you have been blocked from this site.')).toBe(true);
    expect(looksLikeBlockPage(null, 'Attention Required! | Cloudflare\nRay ID: abc')).toBe(true);
  });

  it('matches a weak phrase only in a short body', () => {
    expect(looksLikeBlockPage(null, 'The server returned 403 Forbidden.')).toBe(true);
    // A long article that merely mentions the words is NOT a block.
    const article = `A ruling on API access. ${'context '.repeat(400)} Access denied to some users, the court found. ${'more '.repeat(400)}`;
    expect(article.length).toBeGreaterThan(BLOCK_BODY_MAX_CHARS);
    expect(looksLikeBlockPage('Court weighs API access', article)).toBe(false);
  });

  it('does not match an ordinary article', () => {
    expect(
      looksLikeBlockPage('How we shipped the feature', 'This week we rolled out a new reader.'),
    ).toBe(false);
    expect(looksLikeBlockPage(null, null)).toBe(false);
    expect(looksLikeBlockPage('', '')).toBe(false);
  });
});

describe('siteLabel', () => {
  it('returns the hostname without a leading www.', () => {
    expect(siteLabel('https://www.reddit.com/r/x/comments/1')).toBe('reddit.com');
    expect(siteLabel('https://ft.com/content/abc')).toBe('ft.com');
    expect(siteLabel('http://news.example.co.uk/story')).toBe('news.example.co.uk');
  });

  it('is null for a missing or unparseable URL', () => {
    expect(siteLabel(null)).toBeNull();
    expect(siteLabel(undefined)).toBeNull();
    expect(siteLabel('not a url')).toBeNull();
  });
});

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

// ---------------------------------------------------------------------------
// coalesceSummaryGeneration — single-flight lease over concurrent callers.

const ITEM = 'item-1';

/** An in-memory model of the `items` row's summary + lease columns that mirrors
 * the atomic conditional-UPDATE claim the real SummaryLeaseClient runs against
 * Postgres. The claim's check-and-set is synchronous (no await before the
 * mutation), exactly like a single UPDATE statement — so two callers can never
 * both win, without relying on any async-scheduling race. */
function makeWorld(initial?: { aiSummary?: string | null; leaseAt?: string | null; clock?: number }) {
  const state = {
    aiSummary: initial?.aiSummary ?? null,
    leaseAt: initial?.leaseAt ?? null as string | null,
  };
  let clock = initial?.clock ?? 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => { clock += ms; };
  // Default sleep advances the virtual clock; individual tests override it to
  // inject a writer or hold state still.
  const sleep = (ms: number) => { advance(ms); return Promise.resolve(); };

  let claimCalls = 0;
  const client: SummaryLeaseClient = {
    async claimLease(_itemId, staleBeforeIso, nowIso) {
      claimCalls++;
      if (state.aiSummary != null) return false;
      const stale =
        state.leaseAt == null || Date.parse(state.leaseAt) < Date.parse(staleBeforeIso);
      if (!stale) return false;
      state.leaseAt = nowIso; // atomic set — no await before this line
      return true;
    },
    async readState() {
      return { aiSummary: state.aiSummary, leaseAt: state.leaseAt };
    },
    async releaseLease(_itemId, claimStamp) {
      if (state.aiSummary == null && state.leaseAt === claimStamp) state.leaseAt = null;
    },
  };
  return { state, now, sleep, advance, client, get claimCalls() { return claimCalls; } };
}

describe('coalesceSummaryGeneration', () => {
  it('the elected generator runs generate() once and keeps the lease on success', async () => {
    const w = makeWorld();
    const generate = vi.fn(async (): Promise<SummaryOutcome> => {
      w.state.aiSummary = 'SUM';
      w.state.leaseAt = new Date(w.now()).toISOString();
      return { status: 'ok', summary: 'SUM', cached: true };
    });

    const out = await coalesceSummaryGeneration({
      client: w.client, itemId: ITEM, generate, now: w.now, sleep: w.sleep,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: 'ok', summary: 'SUM', cached: true });
    expect(w.state.aiSummary).toBe('SUM');
    expect(w.state.leaseAt).not.toBeNull(); // NOT released — the summary landed
  });

  it('a concurrent caller that loses the claim waits and returns the winner’s result — no second generate', async () => {
    // Seed a fresh lease held by "the winner" (summary still generating).
    const w = makeWorld({ leaseAt: new Date(1_000_000).toISOString() });
    // The winner finishes during our first poll sleep: model that by writing the
    // summary the first time the waiter sleeps.
    let wrote = false;
    const sleep = (ms: number) => {
      if (!wrote) { wrote = true; w.state.aiSummary = 'FROM_WINNER'; }
      w.advance(ms);
      return Promise.resolve();
    };
    const generate = vi.fn(async (): Promise<SummaryOutcome> => {
      throw new Error('waiter must not generate');
    });

    const out = await coalesceSummaryGeneration({
      client: w.client, itemId: ITEM, generate, now: w.now, sleep,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(out).toEqual({ status: 'ok', summary: 'FROM_WINNER', cached: true });
  });

  it('claimLease is atomic: of two callers hitting a fresh miss, exactly one wins', async () => {
    // Directly exercise the claim primitive (models the concurrent DB UPDATE):
    // two claims against the same null-summary row → one true, one false.
    const w = makeWorld();
    const stale = new Date(w.now() - 60_000).toISOString();
    const first = await w.client.claimLease(ITEM, stale, new Date(w.now()).toISOString());
    const second = await w.client.claimLease(ITEM, stale, new Date(w.now() + 1).toISOString());
    expect(first).toBe(true);
    expect(second).toBe(false);
    // Once a summary is cached, no one can claim.
    w.state.aiSummary = 'SUM';
    expect(await w.client.claimLease(ITEM, stale, new Date(w.now()).toISOString())).toBe(false);
  });

  it('a failed generator releases the lease so the next caller reclaims and generates', async () => {
    const w = makeWorld();

    const failing = vi.fn(async (): Promise<SummaryOutcome> => ({
      status: 'unreachable', summary: null, // no `cached` → lease released
    }));
    const out1 = await coalesceSummaryGeneration({
      client: w.client, itemId: ITEM, generate: failing, now: w.now, sleep: w.sleep,
    });
    expect(out1.status).toBe('unreachable');
    expect(w.state.leaseAt).toBeNull(); // released after the failure

    // A later caller finds a clean row, claims, and succeeds.
    const ok = vi.fn(async (): Promise<SummaryOutcome> => {
      w.state.aiSummary = 'SUM';
      return { status: 'ok', summary: 'SUM', cached: true };
    });
    const out2 = await coalesceSummaryGeneration({
      client: w.client, itemId: ITEM, generate: ok, now: w.now, sleep: w.sleep,
    });
    expect(out2).toMatchObject({ status: 'ok', summary: 'SUM' });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('releases the lease (and re-throws) when the generator throws', async () => {
    const w = makeWorld();
    const boom = new Error('unexpected Supabase failure');
    const generate = vi.fn(async (): Promise<SummaryOutcome> => {
      throw boom;
    });

    await expect(
      coalesceSummaryGeneration({
        client: w.client, itemId: ITEM, generate, now: w.now, sleep: w.sleep,
      }),
    ).rejects.toBe(boom);

    // Lease released despite the throw, so a retry/waiter reclaims immediately
    // instead of blocking on the TTL.
    expect(w.state.leaseAt).toBeNull();
    expect(w.state.aiSummary).toBeNull();
  });

  it('reclaims a stale lease left by a dead generator', async () => {
    // Lease stamped 2× the TTL ago, summary never written (holder crashed).
    const w = makeWorld({ leaseAt: new Date(1_000_000 - 120_000).toISOString() });
    const generate = vi.fn(async (): Promise<SummaryOutcome> => {
      w.state.aiSummary = 'SUM';
      return { status: 'ok', summary: 'SUM', cached: true };
    });
    const out = await coalesceSummaryGeneration({
      client: w.client, itemId: ITEM, generate, now: w.now, sleep: w.sleep,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ status: 'ok', summary: 'SUM' });
  });

  it('falls back to self-generating when a wedged holder never finishes before the deadline', async () => {
    // A fresh lease that never resolves (holder wedged): summary stays null and
    // the lease stays fresh until the waiter’s deadline, so it self-generates.
    const w = makeWorld({ leaseAt: new Date(1_000_000).toISOString() });
    const generate = vi.fn(async (): Promise<SummaryOutcome> => ({
      status: 'ok', summary: 'SELF', cached: true,
    }));
    const out = await coalesceSummaryGeneration({
      client: w.client, itemId: ITEM, generate, now: w.now, sleep: w.sleep,
      leaseTtlMs: 10_000, pollIntervalMs: 1_000, maxWaitMs: 3_000,
    });
    // Never won the claim (lease stayed fresh); generated once as the fallback.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: 'ok', summary: 'SELF', cached: true });
  });
});
