// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  analyzeDarkness,
  decodeFavicon,
  faviconIsDarkOnTransparent,
} from './faviconDarkness';

// --- fixture builders -------------------------------------------------------

function str(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function u32le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') emits a zlib stream, matching what the PNG
  // decoder's DecompressionStream('deflate') expects.
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Build a minimal 8-bit RGBA (color type 6) PNG. CRC fields are left zero —
 * the decoder skips them. */
async function buildPng(
  width: number,
  height: number,
  rgba: number[],
): Promise<Uint8Array> {
  const sampleWidth = width * 4;
  const raw = new Uint8Array(height * (sampleWidth + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (sampleWidth + 1)] = 0; // filter: none
    for (let x = 0; x < sampleWidth; x++) {
      raw[y * (sampleWidth + 1) + 1 + x] = rgba[y * sampleWidth + x];
    }
  }
  const idat = await deflate(raw);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [
    ...u32be(13), ...str('IHDR'),
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, // bitDepth, colorType, compression, filter, interlace
    0, 0, 0, 0, // crc (ignored)
  ];
  const idatChunk = [
    ...u32be(idat.length), ...str('IDAT'), ...idat, 0, 0, 0, 0,
  ];
  const iend = [...u32be(0), ...str('IEND'), 0, 0, 0, 0];
  return new Uint8Array([...sig, ...ihdr, ...idatChunk, ...iend]);
}

/** Build an 8-bit RGB (color type 2) PNG with a tRNS color key. `rgb` is
 * top-down RGB (length w*h*3); `key` is the [r,g,b] treated as transparent. */
async function buildPngRgbWithTrns(
  width: number,
  height: number,
  rgb: number[],
  key: [number, number, number],
): Promise<Uint8Array> {
  const sampleWidth = width * 3;
  const raw = new Uint8Array(height * (sampleWidth + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (sampleWidth + 1)] = 0; // filter: none
    for (let x = 0; x < sampleWidth; x++) {
      raw[y * (sampleWidth + 1) + 1 + x] = rgb[y * sampleWidth + x];
    }
  }
  const idat = await deflate(raw);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [
    ...u32be(13), ...str('IHDR'),
    ...u32be(width), ...u32be(height),
    8, 2, 0, 0, 0, 0, 0, 0, 0, // colorType 2 (RGB)
  ];
  // tRNS for truecolor: three 16-bit samples (high byte 0 for 8-bit).
  const trns = [
    ...u32be(6), ...str('tRNS'),
    0, key[0], 0, key[1], 0, key[2], 0, 0, 0, 0,
  ];
  const idatChunk = [...u32be(idat.length), ...str('IDAT'), ...idat, 0, 0, 0, 0];
  const iend = [...u32be(0), ...str('IEND'), 0, 0, 0, 0];
  return new Uint8Array([...sig, ...ihdr, ...trns, ...idatChunk, ...iend]);
}

/** Build a 2×2 32-bit (BGRA) ICO. `pixels` is top-down RGBA (length 16).
 * When `setAndMask` is false the AND mask is left all-zero, modeling the common
 * "alpha-only" encoding where transparency lives solely in the BGRA channel. */
function buildIco32(pixels: number[], setAndMask = true): Uint8Array {
  const W = 2;
  const H = 2;
  // Header: 40 bytes; XOR: 2 rows × 8 bytes; AND: 2 rows × 4 bytes.
  const dibHeader = [
    ...u32le(40), ...u32le(W), ...u32le(2 * H),
    1, 0, // planes
    32, 0, // bitCount
    ...u32le(0), ...u32le(0), ...u32le(0), ...u32le(0), ...u32le(0), ...u32le(0),
  ];
  const xor: number[] = [];
  const and: number[] = [];
  // Stored bottom-up: bitmap row 0 = logical bottom row.
  for (let srcY = 0; srcY < H; srcY++) {
    const logicalY = H - 1 - srcY;
    let andByte = 0;
    for (let x = 0; x < W; x++) {
      const o = (logicalY * W + x) * 4;
      const r = pixels[o];
      const g = pixels[o + 1];
      const b = pixels[o + 2];
      const a = pixels[o + 3];
      xor.push(b, g, r, a); // BGRA
      if (setAndMask && a < 16) andByte |= 1 << (7 - x); // transparent → AND bit
    }
    and.push(andByte, 0, 0, 0); // row padded to 4 bytes
  }
  const dib = [...dibHeader, ...xor, ...and];
  const size = dib.length;
  const iconDir = [0, 0, 1, 0, 1, 0]; // reserved, type=1, count=1
  const entry = [
    W, H, 0, 0, // width, height, colorCount, reserved
    1, 0, // planes
    32, 0, // bitCount
    ...u32le(size), ...u32le(22), // bytesInRes, imageOffset (6 + 16)
  ];
  return new Uint8Array([...iconDir, ...entry, ...dib]);
}

// Pixel helpers (top-down RGBA).
const T = [0, 0, 0, 0]; // transparent
const BLACK = [10, 10, 10, 255]; // dark, monochrome, opaque
const BLUE = [0, 0, 255, 255]; // bright, saturated, opaque
const NAVY = [0, 0, 110, 255]; // dark BUT saturated

// --- tests ------------------------------------------------------------------

describe('decodeFavicon (PNG)', () => {
  it('decodes an 8-bit RGBA PNG to pixels', async () => {
    const png = await buildPng(2, 1, [...BLACK, ...T]);
    const img = await decodeFavicon(png);
    expect(img).not.toBeNull();
    expect(img!.width).toBe(2);
    expect(img!.height).toBe(1);
    expect([...img!.rgba.slice(0, 4)]).toEqual(BLACK);
    expect(img!.rgba[7]).toBe(0); // second pixel alpha
  });

  it('flags a dark-on-transparent PNG as needing inversion', async () => {
    // 4×4, 12 transparent + 4 black opaque (center) → mostly empty, dark ink.
    const px: number[] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const center = x >= 1 && x <= 2 && y >= 1 && y <= 2;
        px.push(...(center ? BLACK : T));
      }
    }
    const png = await buildPng(4, 4, px);
    expect(await faviconIsDarkOnTransparent(png)).toBe(true);
  });

  it('does not flag a bright full-color PNG', async () => {
    const px: number[] = [];
    for (let i = 0; i < 16; i++) px.push(...BLUE);
    const png = await buildPng(4, 4, px);
    expect(await faviconIsDarkOnTransparent(png)).toBe(false);
  });

  it('rejects a PNG whose inflate exceeds the declared size (deflate-bomb guard)', async () => {
    // IHDR claims 1×1 RGBA (≈5 decoded bytes) but the IDAT inflates to ~2 MB.
    // The decoder must cap the inflate to the expected size and bail (null)
    // instead of buffering the whole expansion.
    const huge = new Uint8Array(2_000_000); // zeros: compress tiny, expand huge
    const idat = await deflate(huge);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = [
      ...u32be(13), ...str('IHDR'),
      ...u32be(1), ...u32be(1),
      8, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    const idatChunk = [...u32be(idat.length), ...str('IDAT'), ...idat, 0, 0, 0, 0];
    const iend = [...u32be(0), ...str('IEND'), 0, 0, 0, 0];
    const png = new Uint8Array([...sig, ...ihdr, ...idatChunk, ...iend]);
    expect(await decodeFavicon(png)).toBeNull();
  });

  it('honors a tRNS color key in an RGB PNG (no alpha channel)', async () => {
    // 4×4 RGB with a white tRNS key as the "transparent" background + a black
    // center mark. Without applying tRNS this decodes fully opaque and is
    // missed; with it, the background is transparent and the mark is flagged.
    const WHITE = [255, 255, 255];
    const INK = [10, 10, 10];
    const rgb: number[] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const center = x >= 1 && x <= 2 && y >= 1 && y <= 2;
        rgb.push(...(center ? INK : WHITE));
      }
    }
    const png = await buildPngRgbWithTrns(4, 4, rgb, [255, 255, 255]);
    expect(await faviconIsDarkOnTransparent(png)).toBe(true);
  });

  it('does not flag a dark BUT saturated mark (the invert-hue guard)', async () => {
    // Dark navy on transparent: dark enough, but high saturation → invert(1)
    // would turn it pale yellow, so we must leave it alone.
    const px: number[] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const center = x >= 1 && x <= 2 && y >= 1 && y <= 2;
        px.push(...(center ? NAVY : T));
      }
    }
    const png = await buildPng(4, 4, px);
    expect(await faviconIsDarkOnTransparent(png)).toBe(false);
  });
});

describe('decodeFavicon (ICO)', () => {
  it('decodes a 32-bit BMP ICO frame and flags a dark-on-transparent mark', async () => {
    // 3 transparent + 1 black opaque.
    const ico = buildIco32([...T, ...T, ...T, ...BLACK]);
    const img = await decodeFavicon(ico);
    expect(img).not.toBeNull();
    expect(img!.width).toBe(2);
    expect(img!.height).toBe(2);
    expect(await faviconIsDarkOnTransparent(ico)).toBe(true);
  });

  it('does not flag a fully-opaque bright ICO', async () => {
    const ico = buildIco32([...BLUE, ...BLUE, ...BLUE, ...BLUE]);
    expect(await faviconIsDarkOnTransparent(ico)).toBe(false);
  });

  it('honors BGRA alpha when the AND mask is unused (alpha-only encoding)', async () => {
    // 3 transparent (alpha 0) + 1 black opaque, AND mask all zero. The decoder
    // must trust the alpha channel here — falling back to the (empty) AND mask
    // would make the transparent pixels opaque and miss the dark-on-transparent
    // mark.
    const ico = buildIco32([...T, ...T, ...T, ...BLACK], /* setAndMask */ false);
    expect(await faviconIsDarkOnTransparent(ico)).toBe(true);
  });
});

describe('decodeFavicon (undecidable)', () => {
  it('returns null for SVG / unknown formats', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    );
    expect(await decodeFavicon(svg)).toBeNull();
    expect(await faviconIsDarkOnTransparent(svg)).toBeNull();
  });

  it('returns null for empty or garbage bytes', async () => {
    expect(await decodeFavicon(new Uint8Array(0))).toBeNull();
    expect(await decodeFavicon(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});

describe('analyzeDarkness (pure)', () => {
  it('returns false when there are no pixels', () => {
    expect(analyzeDarkness({ width: 0, height: 0, rgba: new Uint8Array(0) })).toBe(
      false,
    );
  });

  it('returns false for an all-transparent image (no ink to judge)', () => {
    const rgba = new Uint8Array(4 * 4); // all zero → all transparent
    expect(analyzeDarkness({ width: 2, height: 2, rgba })).toBe(false);
  });
});
