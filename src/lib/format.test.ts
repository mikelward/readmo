// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  formatDisplayDomain,
  formatTimeAgoLong,
  pluralize,
} from './format';

describe('formatDisplayDomain', () => {
  it('returns empty string for missing or invalid url', () => {
    expect(formatDisplayDomain(undefined)).toBe('');
    expect(formatDisplayDomain('not a url')).toBe('');
  });

  it('strips leading www.', () => {
    expect(formatDisplayDomain('https://www.example.com/path')).toBe(
      'example.com',
    );
  });

  it('always trims leading subdomains to the registrable domain', () => {
    expect(formatDisplayDomain('https://blog.example.com/x')).toBe(
      'example.com',
    );
    expect(formatDisplayDomain('https://sport.bbc.co.uk/x')).toBe('bbc.co.uk');
  });

  it('trims old.reddit.com down to reddit.com', () => {
    expect(formatDisplayDomain('https://old.reddit.com/r/x')).toBe(
      'reddit.com',
    );
  });

  it('drops leading subdomains on long hostnames', () => {
    expect(formatDisplayDomain('https://fingfx.thomsonreuters.com/foo')).toBe(
      'thomsonreuters.com',
    );
  });

  it('preserves nested ccTLDs when trimming subdomains', () => {
    expect(formatDisplayDomain('https://news.entertainment.9news.com.au/x')).toBe(
      '9news.com.au',
    );
    expect(formatDisplayDomain('https://a.b.asahi.co.jp/x')).toBe('asahi.co.jp');
  });

  it('does not trim a nested-ccTLD hostname that is already minimal', () => {
    expect(formatDisplayDomain('https://9news.com.au/story')).toBe(
      '9news.com.au',
    );
  });

  it('preserves user subdomains on compound effective TLDs like github.io', () => {
    expect(formatDisplayDomain('https://jasoneckert.github.io/project')).toBe(
      'jasoneckert.github.io',
    );
  });

  it('ellipsizes when the registrable domain is itself too long', () => {
    const long = 'https://some-really-long-publishing-company.com/x';
    const out = formatDisplayDomain(long, 22);
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('some-really-long-publ')).toBe(true);
  });

  it('ellipsizes the registrable domain itself when it exceeds maxLength', () => {
    expect(formatDisplayDomain('https://blog.example.com/x', 5)).toBe('exam…');
  });
});

describe('formatTimeAgoLong', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('returns "just now" for < 1 minute', () => {
    expect(formatTimeAgoLong(nowS - 30, now)).toBe('just now');
  });

  it('spells out and pluralizes the unit', () => {
    expect(formatTimeAgoLong(nowS - 60, now)).toBe('1 minute ago');
    expect(formatTimeAgoLong(nowS - 60 * 2, now)).toBe('2 minutes ago');
    expect(formatTimeAgoLong(nowS - 60 * 60 * 3, now)).toBe('3 hours ago');
    expect(formatTimeAgoLong(nowS - 60 * 60 * 24 * 2, now)).toBe('2 days ago');
    expect(formatTimeAgoLong(nowS - 60 * 60 * 24 * 60, now)).toBe('2 months ago');
    expect(formatTimeAgoLong(nowS - 60 * 60 * 24 * 400, now)).toBe('1 year ago');
  });

  it('rolls 360–365 days over to "1 year ago"', () => {
    expect(formatTimeAgoLong(nowS - 60 * 60 * 24 * 362, now)).toBe('1 year ago');
    expect(formatTimeAgoLong(nowS - 60 * 60 * 24 * 359, now)).toBe('11 months ago');
  });

  it('clamps future times to "just now"', () => {
    expect(formatTimeAgoLong(nowS + 60, now)).toBe('just now');
  });
});

describe('pluralize', () => {
  it('returns singular for 1', () => {
    expect(pluralize(1, 'item')).toBe('item');
  });
  it('returns plural form otherwise', () => {
    expect(pluralize(0, 'item')).toBe('items');
    expect(pluralize(2, 'item')).toBe('items');
  });
});

