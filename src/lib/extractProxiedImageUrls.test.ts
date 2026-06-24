import { describe, expect, it } from 'vitest';
import { extractProxiedImageUrls } from './extractProxiedImageUrls';

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

  it('extracts proxied srcset candidates', () => {
    const html = `<img srcset="/api/img?url=https%3A%2F%2Fa.com%2F1x.jpg 1x, /api/img?url=https%3A%2F%2Fa.com%2F2x.jpg 2x">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2F1x.jpg',
      '/api/img?url=https%3A%2F%2Fa.com%2F2x.jpg',
    ]);
  });

  it('ignores non-proxied srcset candidates', () => {
    const html = `<img srcset="https://cdn.com/1x.jpg 1x, /api/img?url=https%3A%2F%2Fa.com%2F2x.jpg 2x">`;
    expect(extractProxiedImageUrls(html)).toEqual([
      '/api/img?url=https%3A%2F%2Fa.com%2F2x.jpg',
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
