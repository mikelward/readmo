// Detect a "dark monochrome mark on a mostly-empty field" favicon, server-side.
//
// Some publishers (Vox, ABC News Australia, …) ship a black-on-transparent
// favicon — a dark wordmark/glyph with no background — which all but vanishes
// on the reader's dark page background. The client inverts such icons to white
// in dark mode (see src/lib/faviconInvert.ts). Rather than hand-maintain the
// list of affected domains forever, the poller measures the icon once and
// stores a boolean on the feed; the client reads it (and keeps the manual list
// as an override for icons we can't decode here — SVG, exotic formats).
//
// "Measure" means decode the icon to RGBA pixels and look at two things: how
// much of it is transparent, and whether the visible ink is dark AND
// low-saturation (monochrome). The saturation gate matters because the client
// uses `filter: invert(1)`, which inverts hue too — a dark *navy* logo would
// turn pale yellow — so we only flag near-grayscale dark marks.
//
// Decoding covers PNG and ICO (the two formats our real targets use: Vox's
// advertised PNG and ABC's /favicon.ico). Anything else — SVG, JPEG, GIF, a
// truncated/garbled body, an unsupported PNG variant — returns null
// ("undecidable"), and the caller falls back to the manual domain list. The
// decoders are deliberately defensive: any parse surprise yields null rather
// than a throw, so a hostile or malformed icon can never break a poll.
//
// Dependency-free and free of Deno globals (uses only the DecompressionStream
// web API) so the same code runs under vitest for unit tests.

export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

/** Tuning for {@link analyzeDarkness}. Conservative on purpose: a false
 * positive (inverting an icon that shouldn't be) is more visible than a false
 * negative (the manual list still covers known dark icons). */
const ALPHA_OPAQUE_MIN = 16; // alpha below this counts as transparent
const DARK_LUMINANCE_MAX = 90; // 0–255; below this an opaque pixel is "dark"
const LOW_SATURATION_MAX = 0.25; // 0–1; below this it's "monochrome"
const MIN_TRANSPARENT_FRACTION = 0.4; // a mark sits on a mostly-empty field
const MIN_DARK_FRACTION_OF_OPAQUE = 0.7; // the ink is overwhelmingly dark+gray

/** Reject favicons larger than this on a side. Real favicons top out at 256px;
 * a generous 1024 cap bounds the decoded-pixel buffer (≤ ~4 MB RGBA) and the
 * PNG inflate ceiling, so a malicious oversized "favicon" can't exhaust
 * memory. */
const MAX_FAVICON_DIM = 1024;

/**
 * Given decoded RGBA pixels, decide whether the icon is a dark, low-saturation
 * mark on a mostly-transparent field — i.e. one that needs inverting in dark
 * mode. Pure; no I/O.
 */
export function analyzeDarkness(img: DecodedImage): boolean {
  const { rgba } = img;
  let transparent = 0;
  let opaque = 0;
  let darkMono = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a < ALPHA_OPAQUE_MIN) {
      transparent++;
      continue;
    }
    opaque++;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Rec. 709 luminance; saturation as HSV (chroma / value).
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (lum < DARK_LUMINANCE_MAX && sat < LOW_SATURATION_MAX) darkMono++;
  }
  const total = transparent + opaque;
  if (total === 0 || opaque === 0) return false;
  const transparentFraction = transparent / total;
  const darkFractionOfOpaque = darkMono / opaque;
  return (
    transparentFraction >= MIN_TRANSPARENT_FRACTION &&
    darkFractionOfOpaque >= MIN_DARK_FRACTION_OF_OPAQUE
  );
}

/**
 * Decode favicon bytes to RGBA, dispatching on the file's magic bytes (the
 * content-type hint is advisory — favicons are routinely mislabeled). Returns
 * null for any format we don't decode or any malformed input.
 */
export async function decodeFavicon(
  bytes: Uint8Array,
): Promise<DecodedImage | null> {
  if (isPng(bytes)) return decodePng(bytes);
  if (isIco(bytes)) return decodeIco(bytes);
  return null;
}

/**
 * Top-level helper: decode + analyze. Returns true/false when the icon is
 * decodable, or null when it isn't (caller should fall back to the manual
 * domain list).
 */
export async function faviconIsDarkOnTransparent(
  bytes: Uint8Array,
): Promise<boolean | null> {
  const img = await decodeFavicon(bytes);
  if (!img) return null;
  return analyzeDarkness(img);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** Inflate a zlib stream (PNG IDAT), aborting once the decompressed output
 * exceeds `maxBytes`. Favicon bytes are untrusted: a tiny "deflate bomb" can
 * expand to hundreds of MB, so we cap to the image's expected decoded size and
 * bail (returning null) rather than buffering the whole expansion and OOMing
 * the poll Edge Function. */
async function inflate(
  data: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const ds = new DecompressionStream('deflate');
  const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function decodePng(b: Uint8Array): Promise<DecodedImage | null> {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idat: Uint8Array[] = [];

    while (off + 8 <= b.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      const start = off + 8;
      if (start + len > b.length) break; // truncated chunk
      if (type === 'IHDR') {
        width = dv.getUint32(start);
        height = dv.getUint32(start + 4);
        bitDepth = b[start + 8];
        colorType = b[start + 9];
        interlace = b[start + 12];
      } else if (type === 'PLTE') {
        palette = b.slice(start, start + len);
      } else if (type === 'tRNS') {
        trns = b.slice(start, start + len);
      } else if (type === 'IDAT') {
        idat.push(b.slice(start, start + len));
      } else if (type === 'IEND') {
        break;
      }
      off = start + len + 4; // + 4-byte CRC
    }

    if (!width || !height || width > MAX_FAVICON_DIM || height > MAX_FAVICON_DIM) {
      return null;
    }
    if (interlace !== 0) return null; // Adam7 not supported (rare for favicons)
    if (idat.length === 0) return null;

    const channels =
      colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
    if (colorType === 3) {
      if (![1, 2, 4, 8].includes(bitDepth) || !palette) return null;
    } else if (bitDepth !== 8) {
      return null; // only 8-bit channels for grayscale/RGB(A)
    }

    let totalLen = 0;
    for (const c of idat) totalLen += c.length;
    const comp = new Uint8Array(totalLen);
    let cp = 0;
    for (const c of idat) {
      comp.set(c, cp);
      cp += c.length;
    }

    // Non-interlaced raw size is exactly height × (1 filter byte + row samples).
    // Cap the inflate to that so a deflate bomb can't expand unbounded.
    const sampleWidth = colorType === 3 ? Math.ceil((width * bitDepth) / 8) : width * channels;
    const bppFilter = colorType === 3 ? 1 : channels;
    const expected = height * (sampleWidth + 1);
    const raw = await inflate(comp, expected);
    if (!raw || raw.length < expected) return null;
    const lines = new Uint8Array(height * sampleWidth);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const rowStart = y * sampleWidth;
      for (let x = 0; x < sampleWidth; x++) {
        const rb = raw[pos++];
        const left = x >= bppFilter ? lines[rowStart + x - bppFilter] : 0;
        const up = y > 0 ? lines[rowStart - sampleWidth + x] : 0;
        const ul = y > 0 && x >= bppFilter ? lines[rowStart - sampleWidth + x - bppFilter] : 0;
        let v: number;
        switch (filter) {
          case 0: v = rb; break;
          case 1: v = rb + left; break;
          case 2: v = rb + up; break;
          case 3: v = rb + ((left + up) >> 1); break;
          case 4: v = rb + paeth(left, up, ul); break;
          default: return null;
        }
        lines[rowStart + x] = v & 0xff;
      }
    }

    // tRNS color key for non-alpha color types: a single sample (grayscale, ct
    // 0) or RGB triple (truecolor, ct 2) whose matching pixels are transparent.
    // Stored as 16-bit big-endian samples; for our 8-bit depth the value is the
    // low byte. (Palette tRNS is per-index and handled inline below.)
    const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns[1] : -1;
    const trnsR = colorType === 2 && trns && trns.length >= 6 ? trns[1] : -1;
    const trnsG = colorType === 2 && trns && trns.length >= 6 ? trns[3] : -1;
    const trnsB = colorType === 2 && trns && trns.length >= 6 ? trns[5] : -1;

    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const rowStart = y * sampleWidth;
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let bl = 0;
        let a = 255;
        if (colorType === 3) {
          const idx = readPaletteIndex(lines, rowStart, x, bitDepth);
          if (palette && idx * 3 + 2 < palette.length) {
            r = palette[idx * 3];
            g = palette[idx * 3 + 1];
            bl = palette[idx * 3 + 2];
          }
          a = trns && idx < trns.length ? trns[idx] : 255;
        } else if (colorType === 0) {
          r = g = bl = lines[rowStart + x];
          if (trnsGray >= 0 && r === trnsGray) a = 0; // tRNS color key
        } else if (colorType === 4) {
          const o = rowStart + x * 2;
          r = g = bl = lines[o];
          a = lines[o + 1];
        } else if (colorType === 2) {
          const o = rowStart + x * 3;
          r = lines[o];
          g = lines[o + 1];
          bl = lines[o + 2];
          if (trnsR >= 0 && r === trnsR && g === trnsG && bl === trnsB) a = 0;
        } else {
          const o = rowStart + x * 4;
          r = lines[o];
          g = lines[o + 1];
          bl = lines[o + 2];
          a = lines[o + 3];
        }
        const q = (y * width + x) * 4;
        rgba[q] = r;
        rgba[q + 1] = g;
        rgba[q + 2] = bl;
        rgba[q + 3] = a;
      }
    }
    return { width, height, rgba };
  } catch {
    return null;
  }
}

/** Read a palette index for a pixel at sub-byte bit depths (1/2/4/8). */
function readPaletteIndex(
  lines: Uint8Array,
  rowStart: number,
  x: number,
  bitDepth: number,
): number {
  if (bitDepth === 8) return lines[rowStart + x];
  const perByte = 8 / bitDepth;
  const byte = lines[rowStart + Math.floor(x / perByte)] ?? 0;
  const shift = (perByte - 1 - (x % perByte)) * bitDepth;
  const mask = (1 << bitDepth) - 1;
  return (byte >> shift) & mask;
}

// ---------------------------------------------------------------------------
// ICO (PNG-embedded or BMP/DIB frames)
// ---------------------------------------------------------------------------

function isIco(b: Uint8Array): boolean {
  // ICONDIR: reserved=0, type=1 (icon), count>=1.
  return b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 &&
    (b[4] | (b[5] << 8)) >= 1;
}

async function decodeIco(b: Uint8Array): Promise<DecodedImage | null> {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const count = dv.getUint16(4, true);
    // Pick the largest frame by pixel area (0 in the dir means 256).
    let best = -1;
    let bestArea = -1;
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      if (e + 16 > b.length) break;
      const w = b[e] === 0 ? 256 : b[e];
      const h = b[e + 1] === 0 ? 256 : b[e + 1];
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = e;
      }
    }
    if (best < 0) return null;
    const size = dv.getUint32(best + 8, true);
    const offset = dv.getUint32(best + 12, true);
    if (offset + size > b.length || size < 8) return null;
    const frame = b.subarray(offset, offset + size);
    if (isPng(frame)) return decodePng(frame);
    return decodeIcoBmp(frame);
  } catch {
    return null;
  }
}

/** Decode a BMP/DIB frame from inside an ICO (BITMAPINFOHEADER, bottom-up,
 * height doubled to include the 1-bpp AND/transparency mask). Supports the
 * common 32-bit (BGRA) and 24-bit (BGR + AND mask) cases. */
function decodeIcoBmp(frame: Uint8Array): DecodedImage | null {
  try {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headerSize = dv.getUint32(0, true);
    if (headerSize < 40) return null; // need BITMAPINFOHEADER
    const width = dv.getInt32(4, true);
    const heightField = dv.getInt32(8, true);
    const bpp = dv.getUint16(14, true);
    const compression = dv.getUint32(16, true);
    if (compression !== 0) return null; // only BI_RGB
    if (width <= 0 || width > MAX_FAVICON_DIM) return null;
    // In an ICO, the DIB height is XOR-bitmap + AND-mask stacked, so it's 2×.
    const realHeight = Math.floor(Math.abs(heightField) / 2);
    if (realHeight <= 0 || realHeight > MAX_FAVICON_DIM) return null;
    if (bpp !== 32 && bpp !== 24) return null;

    const rgba = new Uint8Array(width * realHeight * 4);
    const rowBytesXor = Math.ceil((width * bpp) / 32) * 4; // 4-byte aligned
    const xorStart = headerSize;
    const andRowBytes = Math.ceil(width / 32) * 4;
    const andStart = xorStart + rowBytesXor * realHeight;
    const hasAndMask = andStart + andRowBytes * realHeight <= frame.length;

    // 32-bit ICO frames come in two flavors: ones that carry real BGRA alpha,
    // and ones that leave the alpha byte 0 everywhere and rely on the 1-bpp AND
    // mask for transparency. Trust the alpha channel when ANY pixel uses it;
    // only fall back to the AND mask when the whole channel is zero — otherwise
    // a genuinely-transparent (alpha 0) pixel would wrongly decode as opaque.
    let useAlphaChannel = false;
    if (bpp === 32) {
      for (let p = xorStart + 3; p < andStart && p < frame.length; p += 4) {
        if (frame[p] !== 0) {
          useAlphaChannel = true;
          break;
        }
      }
    }

    for (let y = 0; y < realHeight; y++) {
      // Bottom-up: row 0 of the bitmap is the bottom of the image.
      const srcY = realHeight - 1 - y;
      const xorRow = xorStart + srcY * rowBytesXor;
      const andRow = andStart + srcY * andRowBytes;
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let bl = 0;
        let a = 255;
        if (bpp === 32) {
          const o = xorRow + x * 4;
          if (o + 3 >= frame.length) return null;
          bl = frame[o];
          g = frame[o + 1];
          r = frame[o + 2];
          a = useAlphaChannel
            ? frame[o + 3]
            : hasAndMask
              ? (andBit(frame, andRow, x) ? 0 : 255)
              : 255;
        } else {
          const o = xorRow + x * 3;
          if (o + 2 >= frame.length) return null;
          bl = frame[o];
          g = frame[o + 1];
          r = frame[o + 2];
          a = hasAndMask ? (andBit(frame, andRow, x) ? 0 : 255) : 255;
        }
        const q = (y * width + x) * 4;
        rgba[q] = r;
        rgba[q + 1] = g;
        rgba[q + 2] = bl;
        rgba[q + 3] = a;
      }
    }
    return { width, height: realHeight, rgba };
  } catch {
    return null;
  }
}

/** A set bit in the AND mask means "transparent" for this pixel. */
function andBit(frame: Uint8Array, rowStart: number, x: number): boolean {
  const byte = frame[rowStart + (x >> 3)] ?? 0;
  return ((byte >> (7 - (x & 7))) & 1) === 1;
}
