import { describe, expect, it } from 'vitest';
import {
  collapseProxiedSrcset,
  extractProxiedImageUrls,
} from './extractProxiedImageUrls';

describe('extractProxiedImageUrls', () => {
  it('returns empty array for html with no images', () => {
    expect(extractProxiedImageUrls('<p>Hello world</p>')).toEqual([]);
  });

  it('returns empty array for non-proxied img src', () => {
    expect(
      extractProxiedImageUrls('<img src="https://example.com/photo.jpg">'),
    ).toEqual([]);
  });

  it('extracts a single /api/img src URL', () => {
    const html = '<img src="/api/img?url=https%3A%2F%2Fexample.com%2Fphoto.jpg">';
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fexample.com%2Fphoto.jpg',
    ]);
  });

  it('extracts multiple /api/img src URLs', () => {
    const html = `
      <p>
        <img src="/api/img?url=https%3A%2F%2Fa.com%2F1.jpg" alt="one">
        <img src="/api/img?url=https%3A%2F%2Fb.com%2F2.png" alt="two">
      </p>
    `;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2F1.jpg',
      '/api/img?url=https%3A%2F%2Fb.com%2F2.png',
    ]);
  });

  it('ignores non-proxied imgs mixed with proxied ones', () => {
    const html = `
      <img src="https://cdn.example.com/direct.jpg">
      <img src="/api/img?url=https%3A%2F%2Fproxied.com%2Fimg.jpg">
    `;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fproxied.com%2Fimg.jpg',
    ]);
  });

  it('collapses an x-descriptor srcset to the candidate nearest 2x', () => {
    const html = `<img srcset="/api/img?url=https%3A%2F%2Fa.com%2F1x.jpg 1x, /api/img?url=https%3A%2F%2Fa.com%2F2x.jpg 2x">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2F2x.jpg',
    ]);
  });

  it('collapses a width-descriptor srcset to the candidate nearest ~1600px', () => {
    // The 9-candidate ladder a publisher (e.g. economist.com) ships: prefetch
    // must fetch ONE width, not every advertised size.
    const w = (n: number) =>
      `/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D${n} ${n}w`;
    const html = `<img srcset="${[640, 750, 828, 1080, 1200, 1920, 2048, 3840].map(w).join(', ')}">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D1920',
    ]);
  });

  it('collapses a descriptor-less srcset to the first candidate', () => {
    const html = `<img srcset="/api/img?url=https%3A%2F%2Fa.com%2Fa.jpg, /api/img?url=https%3A%2F%2Fa.com%2Fb.jpg">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2Fa.jpg',
    ]);
  });

  it('ignores non-proxied srcset candidates', () => {
    const html = `<img srcset="https://cdn.com/1x.jpg 1x, /api/img?url=https%3A%2F%2Fa.com%2F2x.jpg 2x">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2F2x.jpg',
    ]);
  });

  it('warms only the srcset pick, not the fallback src, for a stale img', () => {
    // <img src=small srcset=ladder>: the browser renders the collapsed ~1600px
    // candidate, so the small fallback src must NOT also be prefetched — one
    // fetch per image, and the warmed URL is the one actually displayed.
    const html =
      `<img src="/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D300"` +
      ` srcset="/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D640 640w, /api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D1600 1600w">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D1600',
    ]);
  });

  it('de-duplicates an img src that equals its srcset pick', () => {
    // A stale row often carries both src and a srcset whose chosen candidate is
    // the same URL — that image must warm exactly one fetch, not two.
    const html =
      `<img src="/api/img?url=https%3A%2F%2Fa.com%2Fhero.jpg%3Fw%3D1600"` +
      ` srcset="/api/img?url=https%3A%2F%2Fa.com%2Fhero.jpg%3Fw%3D800 800w, /api/img?url=https%3A%2F%2Fa.com%2Fhero.jpg%3Fw%3D1600 1600w">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2Fhero.jpg%3Fw%3D1600',
    ]);
  });

  it('extracts proxied video poster URL', () => {
    const html = `<video poster="/api/img?url=https%3A%2F%2Fa.com%2Fthumb.jpg" src="/video.mp4"></video>`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2Fthumb.jpg',
    ]);
  });

  it('is safe to call twice (resets regex state)', () => {
    const html = '<img src="/api/img?url=https%3A%2F%2Fexample.com%2Fimg.jpg">';
    const first = extractProxiedImageUrls(html);
    const second = extractProxiedImageUrls(html);
    expect(first).toEqual(second);
  });
});

describe('collapseProxiedSrcset', () => {
  it('collapses an img srcset to a single src and drops srcset/sizes', () => {
    const w = (n: number) =>
      `/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D${n} ${n}w`;
    const html =
      `<img srcset="${[640, 1080, 1920, 3840].map(w).join(', ')}"` +
      ` sizes="100vw" alt="x">`;
    const out = collapseProxiedSrcset(html);
    expect(out).toBe(
      '<img alt="x" src="/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D1920">',
    );
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('sizes');
  });

  it('replaces an existing img src with the chosen candidate', () => {
    const html =
      `<img src="/api/img?url=https%3A%2F%2Fa.com%2Fsmall.jpg%3Fw%3D300"` +
      ` srcset="/api/img?url=https%3A%2F%2Fa.com%2Fbig.jpg%3Fw%3D1600 1600w">`;
    expect(collapseProxiedSrcset(html)).toBe(
      '<img src="/api/img?url=https%3A%2F%2Fa.com%2Fbig.jpg%3Fw%3D1600">',
    );
  });

  it('makes the rendered img and the prefetch request the same URL', () => {
    const w = (n: number) =>
      `/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg%3Fw%3D${n} ${n}w`;
    const html = `<img srcset="${[828, 1080, 1920, 3840].map(w).join(', ')}">`;
    const rendered = collapseProxiedSrcset(html);
    const [warmed] = extractProxiedImageUrls(html);
    // The src the browser will fetch from the collapsed HTML must be the one
    // the offline prefetch warms — the core of the offline-coverage guarantee.
    expect(rendered).toContain(`src="${warmed}"`);
  });

  it('rewrites a proxied <source> srcset but keeps its media query', () => {
    const html =
      `<source media="(max-width: 600px)"` +
      ` srcset="/api/img?url=https%3A%2F%2Fa.com%2Fp.jpg%3Fw%3D800 800w, /api/img?url=https%3A%2F%2Fa.com%2Fp.jpg%3Fw%3D1600 1600w">`;
    const out = collapseProxiedSrcset(html);
    expect(out).toContain('media="(max-width: 600px)"');
    expect(out).toContain(
      'srcset="/api/img?url=https%3A%2F%2Fa.com%2Fp.jpg%3Fw%3D1600"',
    );
    expect(out).not.toMatch(/800w/);
  });

  it('leaves a non-proxied srcset untouched', () => {
    const html = `<img srcset="https://cdn.com/a.jpg 1x, https://cdn.com/b.jpg 2x">`;
    expect(collapseProxiedSrcset(html)).toBe(html);
  });

  it('is a no-op for already-collapsed single-src HTML', () => {
    const html = '<img src="/api/img?url=https%3A%2F%2Fa.com%2Fimg.jpg" alt="y">';
    expect(collapseProxiedSrcset(html)).toBe(html);
  });
});
