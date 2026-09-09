import { describe, expect, it } from 'vitest';
import { feedInitials } from './feedInitials';

describe('feedInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(feedInitials('Financial Times')).toBe('FT');
    expect(feedInitials('Hacker News')).toBe('HN');
  });

  it('drops a leading article', () => {
    expect(feedInitials('The Economist')).toBe('E');
    expect(feedInitials('The Old New Thing')).toBe('ON');
    expect(feedInitials('the verge')).toBe('V');
  });

  it('returns a single letter for a one-word name', () => {
    expect(feedInitials('Reddit')).toBe('R');
    expect(feedInitials('Economist')).toBe('E');
  });

  it('skips leading punctuation to the first alphanumeric of each word', () => {
    expect(feedInitials('/r/programming')).toBe('R');
    expect(feedInitials('*Daring Fireball')).toBe('DF');
  });

  it('uppercases and caps at two letters', () => {
    expect(feedInitials('financial times weekly')).toBe('FT');
  });

  it('returns empty string when nothing usable is derivable', () => {
    expect(feedInitials('')).toBe('');
    expect(feedInitials(null)).toBe('');
    expect(feedInitials(undefined)).toBe('');
    expect(feedInitials('   ')).toBe('');
    expect(feedInitials('— —')).toBe('');
  });
});
