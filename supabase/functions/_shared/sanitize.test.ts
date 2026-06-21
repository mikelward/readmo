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

  it('absolutizes relative img src against the base URL', () => {
    const out = sanitizeContent('<img src="pics/a.png">', base);
    expect(out).toContain('src="https://pub.example.com/articles/pics/a.png"');
  });

  it('absolutizes srcset candidates', () => {
    const out = sanitizeContent(
      '<img src="/a.png" srcset="/a.png 1x, /a@2x.png 2x">',
      base,
    );
    expect(out).toContain('https://pub.example.com/a.png 1x');
    expect(out).toContain('https://pub.example.com/a@2x.png 2x');
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
});
