import { describe, expect, it } from 'vitest';
import { SEED_FEEDS, SEED_ITEMS, SEED_SUBSCRIPTIONS } from './seed';
import { displayTitle } from '../spoilerHeadline';

// Guards the sports-spoiler demo fixture: the corpus must ship a general-news
// feed (BBC) that intermingles world news with a spoiling sports result, so the
// mock demo exercises the spoiler-free headline path end-to-end.

describe('seed corpus — sports spoiler fixture', () => {
  const bbc = SEED_FEEDS.find((f) => f.id === 'feed-bbc');
  const bbcItems = SEED_ITEMS.filter((i) => i.feedId === 'feed-bbc');
  const spoilers = SEED_ITEMS.filter((i) => i.spoilerFreeTitle);

  it('ships the BBC News feed with a subscription', () => {
    expect(bbc?.title).toBe('BBC News');
    expect(SEED_SUBSCRIPTIONS.some((s) => s.feedId === 'feed-bbc')).toBe(true);
  });

  it('has exactly one spoiler fixture, in the BBC feed', () => {
    expect(spoilers).toHaveLength(1);
    expect(spoilers[0].feedId).toBe('feed-bbc');
  });

  it('caches a spoiler-free rewrite that hides the result while the body keeps it', () => {
    const item = spoilers[0];
    // The rewrite names the event, never the outcome (SPEC: never what happened).
    expect(item.spoilerFreeTitle).toBe('World Cup ESP v ARG spoiler');
    expect(item.spoilerFreeTitle).not.toMatch(/won|beat|champion|penalt/i);
    // The original headline and body still carry the result unchanged.
    expect(item.title).toMatch(/Argentina/);
    expect(item.contentHtml).toMatch(/Spain/);
  });

  it('swaps the headline for an allowlisted reader hiding spoilers', () => {
    const item = spoilers[0];
    const shown = displayTitle(item, { hideSpoilers: true, allowed: true });
    expect(shown).toEqual({
      text: 'World Cup ESP v ARG spoiler',
      rewritten: true,
      original: item.title,
    });
  });

  it('intermingles non-sport news in the same feed (no rewrite on those)', () => {
    const nonSpoiler = bbcItems.filter((i) => !i.spoilerFreeTitle);
    expect(nonSpoiler.length).toBeGreaterThan(0);
    for (const item of nonSpoiler) {
      expect(displayTitle(item, { hideSpoilers: true, allowed: true }).rewritten).toBe(false);
    }
  });
});
