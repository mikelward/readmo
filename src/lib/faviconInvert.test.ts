import { describe, expect, it } from 'vitest';
import { faviconNeedsDarkInvert } from './faviconInvert';

describe('faviconNeedsDarkInvert', () => {
  it('flags a known dark-monochrome favicon (vox.com /favicon.ico fallback)', () => {
    expect(faviconNeedsDarkInvert('https://www.vox.com/favicon.ico')).toBe(true);
  });

  it('flags the CDN-advertised Vox icon host (the normal feed path)', () => {
    // Vox's <icon> resolves to cdn.vox-cdn.com, not vox.com — match on the
    // favicon host so the real advertised icon, not just the fallback, inverts.
    expect(
      faviconNeedsDarkInvert(
        'https://cdn.vox-cdn.com/uploads/icon.png?w=150&h=150&crop=1',
      ),
    ).toBe(true);
  });

  it('matches on the registrable domain regardless of subdomain or path', () => {
    expect(faviconNeedsDarkInvert('https://vox.com/static/favicon.png')).toBe(
      true,
    );
    expect(
      faviconNeedsDarkInvert('https://cdn.vox.com/favicon.ico?w=32'),
    ).toBe(true);
  });

  it('flags ABC News (Australia) on its ccTLD host', () => {
    // www.abc.net.au/favicon.ico — host-suffix match, not the lossy
    // display-domain trim which would collapse this to the net.au suffix.
    expect(faviconNeedsDarkInvert('https://www.abc.net.au/favicon.ico')).toBe(
      true,
    );
    expect(faviconNeedsDarkInvert('https://abc.net.au/favicon.ico')).toBe(true);
  });

  it('does not over-match other sites on the same ccTLD suffix', () => {
    // The net.au public suffix must not leak: an unrelated *.net.au / *.com.au
    // site stays untouched.
    expect(faviconNeedsDarkInvert('https://www.smh.com.au/favicon.ico')).toBe(
      false,
    );
    expect(faviconNeedsDarkInvert('https://notabc.net.au/favicon.ico')).toBe(
      false,
    );
  });

  it('leaves an unlisted publisher favicon untouched', () => {
    expect(
      faviconNeedsDarkInvert('https://www.theverge.com/favicon.ico'),
    ).toBe(false);
  });

  it('returns false for a missing or unparseable URL', () => {
    expect(faviconNeedsDarkInvert(null)).toBe(false);
    expect(faviconNeedsDarkInvert(undefined)).toBe(false);
    expect(faviconNeedsDarkInvert('')).toBe(false);
    expect(faviconNeedsDarkInvert('not a url')).toBe(false);
  });
});
