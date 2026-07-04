import { describe, it, expect, vi } from 'vitest';
import {
  MAX_SPOILER_CONTENT_CHARS,
  buildSpoilerPrompt,
  generateSpoilerTitles,
  parseSpoilerResult,
  selectItemsNeedingSpoilerTitle,
  spoilerContentText,
  type SpoilerDeps,
  type SpoilerItemRow,
} from './spoilerTitle';

const gemini = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
});

describe('spoilerContentText', () => {
  it('strips the RSS body to text and prefers content_html over summary', () => {
    expect(
      spoilerContentText({ content_html: '<p>Two late goals</p>', summary: 'other' }),
    ).toBe('Two late goals');
  });

  it('falls back to summary when there is no content_html', () => {
    expect(spoilerContentText({ content_html: null, summary: '<p>teaser</p>' })).toBe('teaser');
  });

  it('returns empty string when there is no body at all', () => {
    expect(spoilerContentText({ content_html: null, summary: null })).toBe('');
  });

  it('clamps a long body to the content cap', () => {
    const huge = `<p>${'x'.repeat(MAX_SPOILER_CONTENT_CHARS + 500)}</p>`;
    expect(spoilerContentText({ content_html: huge }).length).toBeLessThanOrEqual(
      MAX_SPOILER_CONTENT_CHARS,
    );
  });
});

describe('buildSpoilerPrompt', () => {
  it('asks for the JSON contract and embeds the headline', () => {
    const prompt = buildSpoilerPrompt('Man Utd beat Arsenal 3-1', 'body text');
    expect(prompt).toContain('{"spoiler": boolean, "headline": string}');
    expect(prompt).toContain('Man Utd beat Arsenal 3-1');
    expect(prompt).toContain('body text');
    expect(prompt).toContain('--- BEGIN ARTICLE ---');
  });

  it('omits the article block when there is no content', () => {
    const prompt = buildSpoilerPrompt('Some headline', '');
    expect(prompt).not.toContain('BEGIN ARTICLE');
    expect(prompt).toContain('Some headline');
  });

  it('tolerates a null title', () => {
    expect(() => buildSpoilerPrompt(null, 'body')).not.toThrow();
  });

  it('frames the delayed-replay principle and covers implied outcomes', () => {
    // Guards the "assume they'll watch on replay" framing plus the implicit
    // outcomes (eliminations/exits, farewells, title wins) that must be hidden
    // even without a scoreline, and the lean-toward-hiding tie-breaker.
    const prompt = buildSpoilerPrompt('Farewell Cape Verde', '');
    expect(prompt).toMatch(/delayed replay/i);
    expect(prompt).toMatch(/eliminated|knocked out/i);
    expect(prompt).toMatch(/farewell/i);
    expect(prompt).toMatch(/crowned champion/i);
    expect(prompt).toMatch(/unsure[\s\S]*?treat it as a spoiler/i);
  });

  it('falls back to the sport when the competition is unknown', () => {
    // The rewrite must always name at least the sport: an unidentified league
    // like a bare "AUS v IRE spoiler" leaves the reader guessing, so the model
    // is told to lead with the sport (Rugby, Cricket, …) when it can't name the
    // competition.
    const prompt = buildSpoilerPrompt('Wallabies edge Ireland in Sydney thriller', 'rugby body');
    expect(prompt).toMatch(/lead with the SPORT/i);
    expect(prompt).toMatch(/Rugby AUS v IRE spoiler/);
    expect(prompt).toMatch(/never omit both/i);
  });

  it('treats finishing positions and standings changes as spoilers', () => {
    // Guards the miss where "F1 championship leader extends lead, Piastri seventh
    // in British sprint" slipped through: a finishing place ("seventh") and a
    // change to the championship standings ("extends lead") are both results and
    // must be classified as spoilers, even for a competitor named outside the
    // decisive moment.
    const prompt = buildSpoilerPrompt(
      'F1 championship leader extends lead, Piastri seventh in British sprint',
      'Antonelli took the sprint win',
    );
    expect(prompt).toMatch(/finishing position or placing/i);
    expect(prompt).toMatch(/extends lead|standings/i);
    expect(prompt).toMatch(/finished seventh|P3/);
  });

  it('treats a qualifying or sprint session as its own event to protect', () => {
    // A qualifying/sprint result must not be waved through as mere "build-up" to
    // the main race — each session is separately watched, so its result is a
    // spoiler. Pre-game is scoped to THAT session, not the main event.
    const prompt = buildSpoilerPrompt('Piastri fastest in British GP qualifying', '');
    expect(prompt).toMatch(/qualifying.*sprint|sprint.*qualifying/i);
    expect(prompt).toMatch(/its OWN event|separately-watched sessions/i);
    expect(prompt).toMatch(/NOT pre-game/i);
  });

  it('does not treat a preview as safe when it leaks an earlier session', () => {
    // Being labelled a "preview"/"build-up" is not a blanket exemption: a race
    // preview that gives away the qualifying result (or a heat/leg of the same
    // event) still spoils. Pre-game is only safe when nothing has been run yet.
    const prompt = buildSpoilerPrompt('Race preview: pole-sitter leads the grid at Silverstone', '');
    expect(prompt).toMatch(/genuinely PRE-GAME/i);
    expect(prompt).toMatch(/does NOT by itself make a headline safe/i);
    expect(prompt).toMatch(/nothing in the event has\s+happened yet/i);
  });

  it('forbids describing the incident and pulls teams from the body instead', () => {
    // Guards the failure where a headline naming no teams (a mid-match injury)
    // was rewritten as "Football critical injury spoiler" — which leaks WHAT
    // happened. The replacement must never mention the incident and must dig the
    // participants out of the body even when the headline names neither side.
    const prompt = buildSpoilerPrompt('Footballer critical after mid-match head knock', 'Epping v Lalor Reserves');
    expect(prompt).toMatch(/never what happened|must not describe the incident/i);
    expect(prompt).toMatch(/injury/i);
    expect(prompt).toMatch(/none at all/i);
    expect(prompt).toMatch(/Football Epping v Lalor Reserves spoiler/);
    expect(prompt).toMatch(/qualifier that is part of a team's name/i);
    expect(prompt).toMatch(/never invent a league/i);
  });

  it('hides in-play events and exempts only pre-game content', () => {
    // Guards mid-game spoilers: goals, cards, crashes, and in-play injuries are
    // hidden too — and the ONLY carve-out is pre-game (a transfer/fixture just
    // has nothing to spoil, not a listed exception).
    const prompt = buildSpoilerPrompt('Ronaldo scores twice before red card', 'body');
    expect(prompt).toMatch(/in-play/i);
    expect(prompt).toMatch(/\bgoal\b/i);
    expect(prompt).toMatch(/red or yellow card/i);
    expect(prompt).toMatch(/crash|retirement/i);
    expect(prompt).toMatch(/injury during play|injured/i);
    expect(prompt).toMatch(/pre-game/i);
    expect(prompt).toMatch(/transfer/i);
    expect(prompt).toMatch(/fixture/i);
  });
});

describe('parseSpoilerResult', () => {
  it('returns the rewrite when spoiler is true and a headline is given', () => {
    const out = parseSpoilerResult(
      gemini('{"spoiler": true, "headline": "EPL MNU v ARS spoiler"}'),
    );
    expect(out).toEqual({ spoilerFreeTitle: 'EPL MNU v ARS spoiler' });
  });

  it('returns null when spoiler is false (keep the original)', () => {
    expect(
      parseSpoilerResult(gemini('{"spoiler": false, "headline": ""}')),
    ).toEqual({ spoilerFreeTitle: null });
  });

  it('returns null when spoiler is true but the headline is empty', () => {
    expect(
      parseSpoilerResult(gemini('{"spoiler": true, "headline": "  "}')),
    ).toEqual({ spoilerFreeTitle: null });
  });

  it('unwraps a ```json fenced object', () => {
    const out = parseSpoilerResult(
      gemini('```json\n{"spoiler": true, "headline": "F1 GP qualifying spoiler"}\n```'),
    );
    expect(out.spoilerFreeTitle).toBe('F1 GP qualifying spoiler');
  });

  it('returns null for non-JSON / empty / malformed responses', () => {
    expect(parseSpoilerResult(gemini('not json at all')).spoilerFreeTitle).toBeNull();
    expect(parseSpoilerResult(gemini('')).spoilerFreeTitle).toBeNull();
    expect(parseSpoilerResult(null).spoilerFreeTitle).toBeNull();
    expect(parseSpoilerResult(gemini('{"headline": "x"}')).spoilerFreeTitle).toBeNull();
    expect(parseSpoilerResult(gemini('42')).spoilerFreeTitle).toBeNull();
  });
});

describe('selectItemsNeedingSpoilerTitle', () => {
  const rows: SpoilerItemRow[] = [
    { id: 'a', title: 'Result headline' },
    { id: 'b', title: 'Already done', spoiler_free_title_generated_at: '2026-07-03T00:00:00Z' },
    { id: 'c', title: '   ' },
    { id: 'd', title: null },
  ];

  it('keeps only unprocessed items that have a non-blank title', () => {
    expect(selectItemsNeedingSpoilerTitle(rows).map((r) => r.id)).toEqual(['a']);
  });
});

describe('generateSpoilerTitles', () => {
  function makeDeps(over: Partial<SpoilerDeps> = {}): {
    deps: SpoilerDeps;
    writes: Array<{ id: string; title: string | null }>;
    generateCalls: number;
  } {
    const writes: Array<{ id: string; title: string | null }> = [];
    let generateCalls = 0;
    const deps: SpoilerDeps = {
      allowlistedFeeds: async (ids) => ids,
      unprocessedItems: async (feedId) => [
        { id: `${feedId}-1`, title: 'Man Utd beat Arsenal 3-1' },
        { id: `${feedId}-2`, title: 'Wimbledon final preview' },
      ],
      generate: async (title) => {
        generateCalls++;
        return title?.includes('beat')
          ? { status: 'rewrite', title: 'EPL MNU v ARS spoiler' }
          : { status: 'none' };
      },
      write: async (id, spoilerFreeTitle) => {
        writes.push({ id, title: spoilerFreeTitle });
      },
      ...over,
    };
    return { deps, writes, get generateCalls() { return generateCalls; } };
  }

  it('writes a rewrite for a spoiler and null for a non-spoiler, with counts', async () => {
    const h = makeDeps();
    const result = await generateSpoilerTitles(['feed-x'], h.deps);
    expect(result).toEqual({ processed: 2, rewritten: 1, failed: 0, budgetHit: false });
    expect(h.writes).toEqual([
      { id: 'feed-x-1', title: 'EPL MNU v ARS spoiler' },
      { id: 'feed-x-2', title: null },
    ]);
  });

  it('does NOT persist a transient Gemini failure (leaves it for the next poll)', async () => {
    const h = makeDeps({
      unprocessedItems: async () => [
        { id: 'ok', title: 'A beat B 2-0' },
        { id: 'boom', title: 'C beat D 1-0' },
      ],
      generate: async (title) =>
        title?.includes('C beat')
          ? { status: 'failed' }
          : { status: 'rewrite', title: 'REW' },
    });
    const result = await generateSpoilerTitles(['feed-x'], h.deps);
    expect(result).toEqual({ processed: 1, rewritten: 1, failed: 1, budgetHit: false });
    // The failed item is never written, so its generated_at stays null (retried).
    expect(h.writes).toEqual([{ id: 'ok', title: 'REW' }]);
  });

  it('does nothing when no feed has an allowlisted subscriber (empty allowlist → off)', async () => {
    const generate = vi.fn(async () => ({ status: 'rewrite' as const, title: 'x' }));
    const h = makeDeps({ allowlistedFeeds: async () => [], generate });
    const result = await generateSpoilerTitles(['feed-x', 'feed-y'], h.deps);
    expect(result).toEqual({ processed: 0, rewritten: 0, failed: 0, budgetHit: false });
    expect(generate).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it('processes only allowlisted-subscriber feeds', async () => {
    const seen: string[] = [];
    const h = makeDeps({
      allowlistedFeeds: async () => ['feed-x'],
      unprocessedItems: async (feedId) => {
        seen.push(feedId);
        return [{ id: `${feedId}-1`, title: 'A beat B 2-0' }];
      },
    });
    await generateSpoilerTitles(['feed-x', 'feed-y'], h.deps);
    expect(seen).toEqual(['feed-x']);
  });

  it('skips already-processed items', async () => {
    const h = makeDeps({
      unprocessedItems: async () => [
        { id: 'done', title: 'A beat B', spoiler_free_title_generated_at: '2026-07-03T00:00:00Z' },
        { id: 'fresh', title: 'C beat D 1-0' },
      ],
    });
    const result = await generateSpoilerTitles(['feed-x'], h.deps);
    expect(result.processed).toBe(1);
    expect(h.writes.map((w) => w.id)).toEqual(['fresh']);
  });

  it('returns zero for an empty feed list without calling deps', async () => {
    const allowlistedFeeds = vi.fn(async () => []);
    const h = makeDeps({ allowlistedFeeds });
    const result = await generateSpoilerTitles([], h.deps);
    expect(result).toEqual({ processed: 0, rewritten: 0, failed: 0, budgetHit: false });
    expect(allowlistedFeeds).not.toHaveBeenCalled();
  });

  it('stops at the item cap, leaving the rest for the next poll (budgetHit)', async () => {
    const generate = vi.fn(async () => ({ status: 'none' as const }));
    const h = makeDeps({
      allowlistedFeeds: async () => ['feed-x', 'feed-y'],
      unprocessedItems: async (feedId) => [
        { id: `${feedId}-1`, title: 'A beat B' },
        { id: `${feedId}-2`, title: 'C beat D' },
      ],
      generate,
    });
    // 2 feeds × 2 items = 4 available; cap at 3.
    const result = await generateSpoilerTitles(['feed-x', 'feed-y'], h.deps, { maxItems: 3 });
    expect(result.processed).toBe(3);
    expect(result.budgetHit).toBe(true);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('stops when the wall-clock budget is spent (no further Gemini calls)', async () => {
    const generate = vi.fn(async () => ({ status: 'none' as const }));
    const h = makeDeps({
      unprocessedItems: async () => [
        { id: 'a', title: 'A beat B' },
        { id: 'b', title: 'C beat D' },
        { id: 'c', title: 'E beat F' },
      ],
      generate,
    });
    // Budget allows exactly one item, then reports "over budget".
    let calls = 0;
    const withinBudget = () => calls++ < 1;
    const result = await generateSpoilerTitles(['feed-x'], h.deps, { withinBudget });
    expect(result.processed).toBe(1);
    expect(result.budgetHit).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
