import { describe, expect, test } from 'bun:test';
import { packRgba } from '../../document';
import { ImportError } from './contracts';
import { decodePng, encodePng } from './png';
import type { ScaledRowOverlay } from './png';

/** `.rejects` isn't typed as a thenable in bun-types, so assert rejections by awaiting directly. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

// Encodes an arbitrary PNG for decode tests, independent of encodePng, so tests aren't circular.
async function buildTestPng(options: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  palette?: number[]; // RGB triples
  trns?: number[];
  rows?: number[][]; // one array of raw (unfiltered, filter-byte-free) bytes per row
  /** A full, filter-byte-prefixed scanline stream, already laid out pass by pass for Adam7. Used
   *  instead of `rows` when a test needs to control the raw stream directly. */
  rawScanlines?: Uint8Array;
  interlace?: number;
  corruptCrc?: boolean;
  signature?: number[];
  /** Raw `cICP`/`iCCP`/`sRGB` chunk bytes to embed, for color-tagging decode tests. Written right
   *  after IHDR, matching where a real encoder places them. */
  colorChunks?: { cicp?: number[]; iccp?: Uint8Array; srgb?: number[] };
  /** A `gAMA` chunk's 4-byte unsigned value (gamma x 100000), for gamma-correction decode tests. */
  gama?: number;
  /** Raw `gAMA` chunk bytes, for exercising a malformed (e.g. too-short) chunk directly. */
  gamaRaw?: number[];
  /** A raw `eXIf` chunk's bytes (a TIFF-structured blob), for orientation decode tests. */
  exif?: number[];
  /** Places the `eXIf` chunk after IDAT (and before IEND) instead of before PLTE/IDAT, to
   *  exercise the spec's before-IDAT requirement: Chrome and WebKit both ignore a chunk placed
   *  this late, no matter how well-formed it is. */
  exifAfterIdat?: number[];
}): Promise<Uint8Array> {
  const { width, height, bitDepth, colorType, palette, trns, rows, interlace = 0 } = options;
  let raw: Uint8Array;
  if (options.rawScanlines) {
    raw = options.rawScanlines;
  } else {
    const rowBytes = rows![0]?.length ?? 0;
    raw = new Uint8Array((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (rowBytes + 1)] = 0;
      raw.set(rows![y]!, y * (rowBytes + 1) + 1);
    }
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  await writer.write(raw as unknown as BufferSource);
  await writer.close();
  const idatChunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    idatChunks.push(value);
  }
  const idat = new Uint8Array(idatChunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idatChunks) {
    idat.set(c, off);
    off += c.length;
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;

  function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  const parts: Uint8Array[] = [
    new Uint8Array(options.signature ?? [137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
  ];
  if (options.colorChunks?.cicp)
    parts.push(chunk('cICP', new Uint8Array(options.colorChunks.cicp)));
  if (options.colorChunks?.iccp) parts.push(chunk('iCCP', options.colorChunks.iccp));
  if (options.colorChunks?.srgb)
    parts.push(chunk('sRGB', new Uint8Array(options.colorChunks.srgb)));
  if (options.gama !== undefined) {
    const gamaData = new Uint8Array(4);
    new DataView(gamaData.buffer).setUint32(0, options.gama);
    parts.push(chunk('gAMA', gamaData));
  }
  if (options.gamaRaw) parts.push(chunk('gAMA', new Uint8Array(options.gamaRaw)));
  if (options.exif) parts.push(chunk('eXIf', new Uint8Array(options.exif)));
  if (palette) {
    const plteData = new Uint8Array(palette);
    parts.push(chunk('PLTE', plteData));
  }
  if (trns) parts.push(chunk('tRNS', new Uint8Array(trns)));
  const idatChunk = chunk('IDAT', idat);
  if (options.corruptCrc)
    idatChunk[idatChunk.length - 1] = (idatChunk[idatChunk.length - 1] ?? 0) ^ 0xff;
  parts.push(idatChunk);
  if (options.exifAfterIdat) parts.push(chunk('eXIf', new Uint8Array(options.exifAfterIdat)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

let crcTable: Int32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

describe('PNG round-trip', () => {
  test('encode then decode is pixel-exact, including partial alpha', async () => {
    const width = 3;
    const height = 2;
    const pixels = new Uint32Array([
      packRgba(255, 0, 0, 255),
      packRgba(0, 255, 0, 128), // partial alpha: the drift-prone case
      packRgba(0, 0, 255, 1),
      packRgba(10, 20, 30, 0), // fully transparent, color must still survive exactly
      packRgba(255, 255, 255, 255),
      packRgba(1, 2, 3, 254),
    ]);
    const bytes = await encodePng(width, height, pixels);
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  test('encode at an integer scale replicates pixels with no smoothing', async () => {
    const pixels = new Uint32Array([packRgba(200, 20, 20), packRgba(20, 200, 20)]);
    const bytes = await encodePng(2, 1, pixels, 3);
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(3);
    for (let y = 0; y < 3; y++) {
      const row = decoded.pixels.slice(y * 6, y * 6 + 6);
      expect([...row]).toEqual([
        packRgba(200, 20, 20),
        packRgba(200, 20, 20),
        packRgba(200, 20, 20),
        packRgba(20, 200, 20),
        packRgba(20, 200, 20),
        packRgba(20, 200, 20),
      ]);
    }
  });

  test('rejects a non-integer or non-positive scale', async () => {
    const pixels = new Uint32Array([packRgba(1, 2, 3)]);
    expect(await rejectionOf(encodePng(1, 1, pixels, 0))).toBeInstanceOf(RangeError);
    expect(await rejectionOf(encodePng(1, 1, pixels, 1.5))).toBeInstanceOf(RangeError);
  });

  test('an overlay reporting no content anywhere leaves output identical to no overlay at all', async () => {
    const pixels = new Uint32Array([packRgba(200, 20, 20), packRgba(20, 200, 20)]);
    const noOverlay: ScaledRowOverlay = {
      hasContent: () => false,
      compositeInto: () => {
        throw new Error('must never be called when hasContent is always false');
      },
    };
    const plain = await encodePng(2, 1, pixels, 3);
    const withEmptyOverlay = await encodePng(2, 1, pixels, 3, 'srgb', noOverlay);
    expect([...withEmptyOverlay]).toEqual([...plain]);
  });

  test('an overlay composites only into the bands it claims, leaving the rest exact nearest-neighbor', async () => {
    // Two document rows at scale 4: band covers both document rows in one 8-row-high band, since
    // 128 / 4 = 32 document rows per band comfortably covers this tiny fixture in a single band.
    const pixels = new Uint32Array([
      packRgba(200, 20, 20),
      packRgba(20, 200, 20),
      packRgba(20, 20, 200),
      packRgba(100, 100, 100),
    ]);
    const stamp = packRgba(1, 2, 3, 255);
    // Claims content only for document row 1 (the second row), and stamps every output pixel in
    // that band solid, so a decode can tell exactly which rows the overlay touched.
    const overlay: ScaledRowOverlay = {
      hasContent: (startY, endY) => startY < 2 && endY > 1,
      compositeInto(band, startY, endY, outWidth) {
        expect(startY).toBe(0);
        expect(endY).toBe(2);
        expect(outWidth).toBe(8);
        const r = (stamp >>> 0) & 0xff;
        const g = (stamp >>> 8) & 0xff;
        const b = (stamp >>> 16) & 0xff;
        const a = (stamp >>> 24) & 0xff;
        // Stamp only the second document row's output band (rows 4..7 of this 8-row band).
        for (let y = 4; y < 8; y++) {
          for (let x = 0; x < outWidth; x++) {
            const i = (y * outWidth + x) * 4;
            band[i] = r;
            band[i + 1] = g;
            band[i + 2] = b;
            band[i + 3] = a;
          }
        }
      },
    };
    const bytes = await encodePng(2, 2, pixels, 4, 'srgb', overlay);
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    // First document row (output rows 0-3): untouched, exact nearest-neighbor replication.
    for (let y = 0; y < 4; y++) {
      const row = decoded.pixels.slice(y * 8, y * 8 + 8);
      expect([...row]).toEqual([
        packRgba(200, 20, 20),
        packRgba(200, 20, 20),
        packRgba(200, 20, 20),
        packRgba(200, 20, 20),
        packRgba(20, 200, 20),
        packRgba(20, 200, 20),
        packRgba(20, 200, 20),
        packRgba(20, 200, 20),
      ]);
    }
    // Second document row (output rows 4-7): entirely replaced by the overlay's stamp.
    for (let y = 4; y < 8; y++) {
      const row = decoded.pixels.slice(y * 8, y * 8 + 8);
      expect([...row]).toEqual(Array.from({ length: 8 }, () => stamp));
    }
  });

  test('a band boundary dispatches plain rows and overlaid rows independently', async () => {
    // Scale 1 means 128 document rows per band. 130 rows forces two bands: [0,128) and [128,130).
    // The overlay claims content only in the second band, proving the dispatcher asks per-band
    // and never builds an overlay buffer for a band with nothing to add.
    const width = 1;
    const height = 130;
    const pixels = new Uint32Array(width * height);
    for (let y = 0; y < height; y++) pixels[y] = packRgba(y % 256, 0, 0);
    const stamp = packRgba(9, 9, 9, 255);
    let compositedBands = 0;
    const overlay: ScaledRowOverlay = {
      hasContent: (_startY, endY) => endY > 128,
      compositeInto(band, startY, endY, outWidth) {
        compositedBands++;
        expect(startY).toBe(128);
        expect(endY).toBe(130);
        expect(outWidth).toBe(1);
        for (let i = 0; i < band.length; i += 4) {
          band[i] = (stamp >>> 0) & 0xff;
          band[i + 1] = (stamp >>> 8) & 0xff;
          band[i + 2] = (stamp >>> 16) & 0xff;
          band[i + 3] = (stamp >>> 24) & 0xff;
        }
      },
    };
    const bytes = await encodePng(width, height, pixels, 1, 'srgb', overlay);
    const decoded = await decodePng(bytes);
    expect(compositedBands).toBe(1);
    for (let y = 0; y < 128; y++) expect(decoded.pixels[y]).toBe(pixels[y]);
    for (let y = 128; y < 130; y++) expect(decoded.pixels[y]).toBe(stamp);
  });
});

describe('PNG color tagging', () => {
  test('encodePng defaults to sRGB, writing a plain sRGB chunk and no cICP', async () => {
    const pixels = new Uint32Array([packRgba(100, 150, 200)]);
    const bytes = await encodePng(1, 1, pixels);
    const decoded = await decodePng(bytes);
    expect(decoded.colorTag).toBe('srgb');
  });

  test('encodePng tags a display-p3 document with a cICP chunk round-tripping as display-p3', async () => {
    const pixels = new Uint32Array([packRgba(100, 150, 200)]);
    const bytes = await encodePng(1, 1, pixels, 1, 'display-p3');
    const decoded = await decodePng(bytes);
    expect(decoded.colorTag).toBe('display-p3');
    // Pixel values themselves are an exact passthrough: export never re-maps numbers, only tags.
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  test('decodePng classifies a PNG with no color chunk as sRGB (the spec default)', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3]],
    });
    expect((await decodePng(bytes)).colorTag).toBe('srgb');
  });

  test('decodePng classifies real-world Display P3 cICP bytes as display-p3', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3]],
      colorChunks: { cicp: [12, 13, 0, 1] }, // verified against a real macOS P3 screenshot
    });
    expect((await decodePng(bytes)).colorTag).toBe('display-p3');
  });

  test('decodePng classifies an unrecognized cICP combination as unknown-icc', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3]],
      colorChunks: { cicp: [9, 16, 0, 1] }, // Rec. 2020: real color info, just not one we map
    });
    expect((await decodePng(bytes)).colorTag).toBe('unknown-icc');
  });
});

/** Builds a big-endian TIFF `eXIf` chunk payload with a single IFD entry for the Orientation tag
 *  (0x0112, SHORT), mirroring what real cameras and `exiftool` write. `littleEndian` exercises the
 *  'II' byte-order path instead of 'MM'. */
function exifOrientationChunk(value: number, littleEndian = false): number[] {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const w32 = littleEndian ? le32 : be32;
  const tag = littleEndian ? [0x12, 0x01] : [0x01, 0x12];
  const type = littleEndian ? [3, 0] : [0, 3];
  const valueBytes = littleEndian ? [value, 0] : [0, value];
  const order = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d];
  return [
    ...order,
    ...(littleEndian ? [0x2a, 0] : [0, 0x2a]),
    ...w32(8), // offset to the first (only) IFD
    ...(littleEndian ? [1, 0] : [0, 1]), // one entry
    ...tag,
    ...type,
    ...w32(1), // count
    ...valueBytes,
    0,
    0, // padding to fill the 4-byte value field
    ...w32(0), // next IFD offset: none
  ];
}

describe('PNG decode: eXIf orientation', () => {
  // A 3x2 grid of six distinct colors (row-major A B C / D E F) so every orientation's pixel
  // permutation is independently checkable by eye against the standard EXIF orientation table.
  const A = [10, 20, 30];
  const B = [40, 50, 60];
  const C = [70, 80, 90];
  const D = [100, 110, 120];
  const E = [130, 140, 150];
  const F = [160, 170, 180];
  const grid = {
    width: 3,
    height: 2,
    bitDepth: 8,
    colorType: 2,
    rows: [
      [...A, ...B, ...C],
      [...D, ...E, ...F],
    ],
  };
  const p = (rgb: number[]) => packRgba(rgb[0]!, rgb[1]!, rgb[2]!, 255);

  test('no eXIf chunk leaves pixels and dimensions unchanged', async () => {
    const bytes = await buildTestPng(grid);
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(A), p(B), p(C), p(D), p(E), p(F)]);
  });

  test('orientation 1 (normal) leaves pixels and dimensions unchanged', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(1) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(A), p(B), p(C), p(D), p(E), p(F)]);
  });

  test('orientation 2 (mirror horizontal) reverses each row, keeping dimensions', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(2) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(C), p(B), p(A), p(F), p(E), p(D)]);
  });

  test('orientation 3 (rotate 180) reverses pixel order entirely, keeping dimensions', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(3) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(F), p(E), p(D), p(C), p(B), p(A)]);
  });

  test('orientation 4 (mirror vertical) reverses row order, keeping dimensions', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(4) });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([p(D), p(E), p(F), p(A), p(B), p(C)]);
  });

  test('orientation 5 (transpose) swaps width and height', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(5) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(3);
    expect([...decoded.pixels]).toEqual([p(A), p(D), p(B), p(E), p(C), p(F)]);
  });

  test('orientation 6 (rotate 90 CW) swaps width and height', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(6) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(3);
    expect([...decoded.pixels]).toEqual([p(D), p(A), p(E), p(B), p(F), p(C)]);
  });

  test('orientation 7 (transverse) swaps width and height', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(7) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(3);
    expect([...decoded.pixels]).toEqual([p(F), p(C), p(E), p(B), p(D), p(A)]);
  });

  test('orientation 8 (rotate 270 CW) swaps width and height', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(8) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(3);
    expect([...decoded.pixels]).toEqual([p(C), p(F), p(B), p(E), p(A), p(D)]);
  });

  test('little-endian (II) byte order parses the same orientation', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(6, true) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(3);
    expect([...decoded.pixels]).toEqual([p(D), p(A), p(E), p(B), p(F), p(C)]);
  });

  test('a malformed eXIf chunk is ignored rather than failing the import', async () => {
    const bytes = await buildTestPng({ ...grid, exif: [1, 2, 3] });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(A), p(B), p(C), p(D), p(E), p(F)]);
  });

  test('re-exporting an orientation-corrected import carries no eXIf chunk and stays upright', async () => {
    const bytes = await buildTestPng({ ...grid, exif: exifOrientationChunk(6) });
    const decoded = await decodePng(bytes);
    const reencoded = await encodePng(decoded.width, decoded.height, decoded.pixels);
    // encodePng never writes an eXIf chunk, so any viewer re-opening this file sees the already
    // upright pixels with no orientation tag to (re-)apply.
    const text = Buffer.from(reencoded).toString('latin1');
    expect(text.includes('eXIf')).toBe(false);
    const redecoded = await decodePng(reencoded);
    expect(redecoded.width).toBe(decoded.width);
    expect(redecoded.height).toBe(decoded.height);
    expect([...redecoded.pixels]).toEqual([...decoded.pixels]);
  });

  test('an eXIf chunk placed after IDAT is ignored, matching Chrome and WebKit', async () => {
    // The spec requires eXIf before the first IDAT; a chunk arriving after it is well-formed
    // (orientation 6) but both engines ignore it rather than apply it, so Pixels must too.
    const bytes = await buildTestPng({ ...grid, exifAfterIdat: exifOrientationChunk(6) });
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(A), p(B), p(C), p(D), p(E), p(F)]);
  });

  test('an earlier valid eXIf chunk is kept even if a later, ignored one follows IDAT', async () => {
    const bytes = await buildTestPng({
      ...grid,
      exif: exifOrientationChunk(2),
      exifAfterIdat: exifOrientationChunk(6),
    });
    const decoded = await decodePng(bytes);
    // Orientation 2 (mirror horizontal) must win; orientation 6 would have swapped dimensions.
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect([...decoded.pixels]).toEqual([p(C), p(B), p(A), p(F), p(E), p(D)]);
  });

  test('an eXIf chunk with no Orientation tag is ignored', async () => {
    // A valid TIFF header and IFD, but with an unrelated tag (0x0100, ImageWidth) instead.
    const bytes = await buildTestPng({
      ...grid,
      exif: [
        0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x00, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 0,
      ],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([p(A), p(B), p(C), p(D), p(E), p(F)]);
  });
});

describe('PNG decode: gAMA gamma correction', () => {
  // A single RGB pixel with a mid-range sample on each channel and known expected outputs under
  // the sRGB-encode(sample ^ (1/gamma)) correction curve, verified against real Chrome/WebKit
  // decodes of the same gamma values (see AGENTS.md).
  test('a gAMA within 5% of 1/2.2 leaves samples untouched (matches the PNG default assumption)', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[128, 64, 32]],
      gama: 45455, // 1/2.2, the common real-world value
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(128, 64, 32, 255)]);
  });

  test('a linear gAMA of 1.0 brightens samples via the sRGB encode curve', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[128, 64, 32]],
      gama: 100000, // gamma 1.0: samples are already linear light
    });
    const decoded = await decodePng(bytes);
    // Exact LUT outputs for gamma 1.0, cross-checked against real Chrome and WebKit decodes.
    expect([...decoded.pixels]).toEqual([packRgba(188, 137, 99, 255)]);
  });

  test('the old Mac 1/1.8 gAMA (0.55556) corrects with a smaller shift', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[128, 64, 32]],
      gama: 55556,
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(146, 81, 43, 255)]);
  });

  test('gAMA is never applied to the alpha channel', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 6,
      rows: [[128, 64, 32, 128]],
      gama: 100000,
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(188, 137, 99, 128)]);
  });

  test('a cICP, iCCP, or sRGB chunk outranks gAMA, leaving samples untouched', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[128, 64, 32]],
      gama: 100000, // would otherwise brighten the samples
      colorChunks: { srgb: [0] },
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(128, 64, 32, 255)]);
  });

  test('a malformed (too-short) gAMA chunk is ignored rather than failing the import', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[128, 64, 32]],
      gamaRaw: [0, 1, 2], // only 3 bytes: not a valid 4-byte gAMA value
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(128, 64, 32, 255)]);
  });
});

describe('PNG decode: 16-bit gAMA indexes the lookup table by the high byte', () => {
  // Chrome and WebKit (both built on libpng) apply 16-bit gamma correction by indexing the same
  // 256-entry display LUT with just the sample's high byte, not the full 16-bit value reduced
  // with exact rounding: reverse-engineered by comparing real decodes of a 16-bit gAMA 1.0
  // fixture (Adam7, EXIF orientation 5) against both a naive reduce-then-correct implementation
  // and a full 65536-entry precision table. A native sample of 489 (high byte 1) must decode to
  // 13, matching gammaByte(1/255); a 65536-entry table would instead give 21, and reducing first
  // via round(489*255/65535)=2 then correcting would give a different wrong answer again.
  test('RGBA: each color channel corrects from its native sample high byte; alpha stays linear', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 6,
      // R=489 (hi 1), G=15633 (hi 61), B=5000 (hi 19), A=32896, all big-endian.
      rows: [[1, 233, 61, 17, 19, 136, 128, 128]],
      gama: 100000, // gamma 1.0: samples are already linear light
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(13, 134, 77, 128)]);
  });

  test('grayscale: the single channel corrects from its native sample high byte', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 0,
      rows: [[1, 233]], // gray=489 (high byte 1) out of 65535
      gama: 100000,
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(13, 13, 13, 255)]);
  });

  test('a cICP, iCCP, or sRGB chunk still outranks gAMA at 16-bit, leaving samples scaled plainly', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 2,
      rows: [[0, 129, 0, 10, 19, 136]], // R=129, G=10, B=5000
      gama: 100000, // would otherwise correct the samples
      colorChunks: { srgb: [0] },
    });
    const decoded = await decodePng(bytes);
    // Plain linear 16-to-8 scaling, exactly as the existing 16-bit scaling tests expect.
    expect([...decoded.pixels]).toEqual([
      packRgba(
        Math.round((129 * 255) / 65535),
        Math.round((10 * 255) / 65535),
        Math.round((5000 * 255) / 65535),
        255,
      ),
    ]);
  });
});

describe('PNG decode: color type coverage', () => {
  test('decodes 8-bit RGB, filling full alpha', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[10, 20, 30, 40, 50, 60]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(10, 20, 30), packRgba(40, 50, 60)]);
  });

  test('decodes 8-bit grayscale as equal RGB channels with full alpha', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      rows: [[128, 255]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(128, 128, 128), packRgba(255, 255, 255)]);
  });

  test('decodes 8-bit grayscale+alpha', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 4,
      rows: [[128, 64, 200, 255]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(128, 128, 128, 64),
      packRgba(200, 200, 200, 255),
    ]);
  });

  test('decodes 8-bit palette with tRNS alpha', async () => {
    const bytes = await buildTestPng({
      width: 3,
      height: 1,
      bitDepth: 8,
      colorType: 3,
      palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
      trns: [255, 128, 0],
      rows: [[0, 1, 2]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(255, 0, 0, 255),
      packRgba(0, 255, 0, 128),
      packRgba(0, 0, 255, 0),
    ]);
  });

  test('decodes low-bit-depth palette (2-bit indices)', async () => {
    // Two pixels packed into one byte at 2 bits/sample: index 3 then index 1 -> 0b11_01_00_00.
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 2,
      colorType: 3,
      palette: [0, 0, 0, 64, 64, 64, 128, 128, 128, 255, 255, 255],
      rows: [[0b11010000]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(255, 255, 255), packRgba(64, 64, 64)]);
  });

  test('applies Up and Paeth filters correctly across rows', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2,
      rows: [
        [10, 10, 10, 20, 20, 20],
        [10, 10, 10, 20, 20, 20], // Up-filtered row would decode identically if it round-tripped correctly
      ],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(10, 10, 10),
      packRgba(20, 20, 20),
      packRgba(10, 10, 10),
      packRgba(20, 20, 20),
    ]);
  });
});

describe('PNG decode: tRNS color-key transparency for gray and RGB', () => {
  test('8-bit grayscale: the keyed sample is transparent, everything else opaque', async () => {
    const bytes = await buildTestPng({
      width: 3,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      trns: [0, 64], // 2-byte gray key, 64 at this bit depth
      rows: [[64, 65, 0]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(64, 64, 64, 0),
      packRgba(65, 65, 65, 255),
      packRgba(0, 0, 0, 255),
    ]);
  });

  test('4-bit grayscale: the key is compared against the raw, unscaled sample', async () => {
    // Two pixels packed into one byte at 4 bits/sample: index 5 then index 9 -> 0b0101_1001.
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 4,
      colorType: 0,
      trns: [0, 5], // raw sample 5 is the key, not the scaled-to-8-bit value (5*255/15=85)
      rows: [[0b01011001]],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(85, 85, 85, 0),
      packRgba(153, 153, 153, 255), // 9*255/15=153, not the key, so opaque
    ]);
  });

  test('16-bit grayscale: the key is a full 16-bit value, not the scaled 8-bit one', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 16,
      colorType: 0,
      trns: [0x80, 0x80], // raw sample 0x8080 is the key
      rows: [[0x80, 0x80, 0x80, 0x81]], // first pixel matches exactly, second is one raw unit off
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(128, 128, 128, 0),
      packRgba(128, 128, 128, 255), // scales to the same 8-bit gray, but isn't the exact raw key
    ]);
  });

  test('8-bit RGB: only the exact keyed triple is transparent', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      trns: [0, 255, 0, 0, 0, 255], // magenta color key (3 x 2-byte values per the spec), as a real sprite sheet would use
      rows: [[255, 0, 255, 254, 0, 255]], // exact key, then one channel off
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(255, 0, 255, 0), packRgba(254, 0, 255, 255)]);
  });

  test('16-bit RGB: the key compares all three raw 16-bit channels', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 16,
      colorType: 2,
      trns: [0xff, 0xff, 0, 0, 0xff, 0xff], // raw (65535, 0, 65535)
      rows: [
        [0xff, 0xff, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 1, 0xff, 0xff], // exact key, then G off by one raw unit
      ],
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([
      packRgba(255, 0, 255, 0),
      packRgba(255, 0, 255, 255), // scales identically to 8-bit, but the raw key doesn't match
    ]);
  });
});

describe('PNG decode: 16-bit samples, scaled with exact rounding', () => {
  // 65535 = 255 * 257, so any raw sample that's a multiple of 257 scales to an exact integer;
  // everything else must round rather than truncate. These cover both.
  test('grayscale', async () => {
    const bytes = await buildTestPng({
      width: 4,
      height: 1,
      bitDepth: 16,
      colorType: 0,
      rows: [[0x00, 0x00, 0x80, 0x80, 0xff, 0xff, 0x01, 0x90]], // 0, 32896(=257*128), 65535, 400
    });
    const decoded = await decodePng(bytes);
    // 400 * 255 / 65535 = 1.5569... which must round to 2, not truncate to 1.
    expect([...decoded.pixels]).toEqual([
      packRgba(0, 0, 0),
      packRgba(128, 128, 128),
      packRgba(255, 255, 255),
      packRgba(2, 2, 2),
    ]);
  });

  test('RGB', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 2,
      rows: [[0x01, 0x90, 0xff, 0xff, 0x00, 0x00]], // R=400 (rounds to 2), G=65535, B=0
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(2, 255, 0)]);
  });

  test('gray+alpha', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 4,
      rows: [[0x80, 0x80, 0x01, 0x90]], // gray=32896(->128), alpha=400 (->2)
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(128, 128, 128, 2)]);
  });

  test('RGBA', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 6,
      rows: [[0x01, 0x90, 0x80, 0x80, 0xff, 0xff, 0x00, 0x00]], // R=400(->2), G=32896(->128), B=65535, A=0
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual([packRgba(2, 128, 255, 0)]);
  });
});

describe('PNG decode: Adam7 interlacing', () => {
  // The spec's seven reduced images, independent of the decoder: used to build interlaced test
  // fixtures and, separately, to compute each test's expected pixels, so neither side of the
  // assertion goes through the decoder's own pass logic.
  const ADAM7_PASSES = [
    { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
    { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
    { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
    { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
    { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
    { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
    { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
  ];

  /** A simple, bounded-to-one-byte RGBA formula so any small width/height stays in range. */
  function pixelAt(x: number, y: number): [number, number, number, number] {
    return [(x * 40 + 10) & 255, (y * 40 + 20) & 255, ((x + y) * 30 + 5) & 255, 255];
  }

  function buildAdam7Raw(width: number, height: number): Uint8Array {
    const parts: number[] = [];
    for (const pass of ADAM7_PASSES) {
      const passWidth = Math.ceil((width - pass.xStart) / pass.xStep);
      const passHeight = Math.ceil((height - pass.yStart) / pass.yStep);
      if (passWidth <= 0 || passHeight <= 0) continue;
      for (let py = 0; py < passHeight; py++) {
        parts.push(0); // filter type: None
        for (let px = 0; px < passWidth; px++) {
          const [r, g, b, a] = pixelAt(
            pass.xStart + px * pass.xStep,
            pass.yStart + py * pass.yStep,
          );
          parts.push(r, g, b, a);
        }
      }
    }
    return new Uint8Array(parts);
  }

  function expectedPixels(width: number, height: number): number[] {
    const out: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b, a] = pixelAt(x, y);
        out.push(packRgba(r, g, b, a));
      }
    }
    return out;
  }

  test('an 8x8 image exercises all seven passes', async () => {
    const width = 8;
    const height = 8;
    const bytes = await buildTestPng({
      width,
      height,
      bitDepth: 8,
      colorType: 6,
      interlace: 1,
      rawScanlines: buildAdam7Raw(width, height),
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual(expectedPixels(width, height));
  });

  test('a 1x1 image only has a pixel in the first pass, the rest are empty', async () => {
    const width = 1;
    const height = 1;
    const bytes = await buildTestPng({
      width,
      height,
      bitDepth: 8,
      colorType: 6,
      interlace: 1,
      rawScanlines: buildAdam7Raw(width, height),
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual(expectedPixels(width, height));
  });

  test('an odd 3x5 image mixes empty passes with non-square pass dimensions', async () => {
    const width = 3;
    const height = 5;
    const bytes = await buildTestPng({
      width,
      height,
      bitDepth: 8,
      colorType: 6,
      interlace: 1,
      rawScanlines: buildAdam7Raw(width, height),
    });
    const decoded = await decodePng(bytes);
    expect([...decoded.pixels]).toEqual(expectedPixels(width, height));
  });
});

test('312 filtered RGBA8 fixtures preserve every byte, including hidden RGB', async () => {
  const widths = [1, 2, 3, 4, 5, 7, 8, 15, 16, 31, 32, 63, 64];
  const heights = [1, 2, 3, 7];
  const patterns = [0, 1, 2, 3, 4, 5]; // five PNG filters plus a different filter on each row
  let cases = 0;

  function predictor(filter: number, left: number, above: number, upperLeft: number): number {
    if (filter === 0) return 0;
    if (filter === 1) return left;
    if (filter === 2) return above;
    if (filter === 3) return (left + above) >> 1;
    const base = left + above - upperLeft;
    const a = Math.abs(base - left);
    const b = Math.abs(base - above);
    const c = Math.abs(base - upperLeft);
    return a <= b && a <= c ? left : b <= c ? above : upperLeft;
  }

  for (const width of widths) {
    for (const height of heights) {
      for (const pattern of patterns) {
        const rowBytes = width * 4;
        const expected = new Uint8Array(rowBytes * height);
        const filtered = new Uint8Array((rowBytes + 1) * height);
        for (let y = 0; y < height; y++) {
          const filter = pattern === 5 ? y % 5 : pattern;
          filtered[y * (rowBytes + 1)] = filter;
          for (let i = 0; i < rowBytes; i++) {
            const offset = y * rowBytes + i;
            const value =
              i % 4 === 3 ? [0, 1, 128, 255][(i / 4 + y) % 4]! : (i * 73 + y * 139 + width) & 255;
            expected[offset] = value;
            const left = i >= 4 ? expected[offset - 4]! : 0;
            const above = y > 0 ? expected[offset - rowBytes]! : 0;
            const upperLeft = y > 0 && i >= 4 ? expected[offset - rowBytes - 4]! : 0;
            filtered[y * (rowBytes + 1) + 1 + i] =
              (value - predictor(filter, left, above, upperLeft) + 256) & 255;
          }
        }
        const png = await buildTestPng({
          width,
          height,
          bitDepth: 8,
          colorType: 6,
          rawScanlines: filtered,
        });
        const decoded = await decodePng(png);
        expect(new Uint8Array(decoded.pixels.buffer)).toEqual(expected);
        cases++;
      }
    }
  }
  expect(cases).toBe(312);
});

test('RGB8 fast path honors all filters and the exact transparent color key', async () => {
  const width = 3;
  const rows = [
    new Uint8Array([10, 20, 30, 21, 37, 49, 60, 71, 83]),
    new Uint8Array([90, 101, 113, 10, 20, 30, 140, 151, 163]),
  ];
  const expected = [
    packRgba(10, 20, 30, 0),
    packRgba(21, 37, 49),
    packRgba(60, 71, 83),
    packRgba(90, 101, 113),
    packRgba(10, 20, 30, 0),
    packRgba(140, 151, 163),
  ];
  for (let filter = 0; filter <= 4; filter++) {
    const scanlines = new Uint8Array((width * 3 + 1) * rows.length);
    for (let y = 0; y < rows.length; y++) {
      scanlines[y * (width * 3 + 1)] = filter;
      for (let i = 0; i < width * 3; i++) {
        const left = i >= 3 ? rows[y]![i - 3]! : 0;
        const above = y ? rows[y - 1]![i]! : 0;
        const upperLeft = y && i >= 3 ? rows[y - 1]![i - 3]! : 0;
        const base = left + above - upperLeft;
        const da = Math.abs(base - left);
        const db = Math.abs(base - above);
        const dc = Math.abs(base - upperLeft);
        const predictor = [
          0,
          left,
          above,
          (left + above) >> 1,
          da <= db && da <= dc ? left : db <= dc ? above : upperLeft,
        ][filter]!;
        scanlines[y * (width * 3 + 1) + 1 + i] = (rows[y]![i]! - predictor + 256) & 255;
      }
    }
    const png = await buildTestPng({
      width,
      height: rows.length,
      bitDepth: 8,
      colorType: 2,
      trns: [0, 10, 0, 20, 0, 30],
      rawScanlines: scanlines,
    });
    expect([...(await decodePng(png)).pixels]).toEqual(expected);
  }
});

describe('PNG decode: error cases', () => {
  test('rejects a file over the 4096 document size limit with reason too-large', async () => {
    const bytes = await buildTestPng({
      width: 5000,
      height: 10,
      bitDepth: 8,
      colorType: 2,
      rows: Array.from({ length: 10 }, () => Array.from({ length: 15000 }, () => 0)),
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'too-large' });
  });

  test('rejects an invalid interlace method with reason corrupt', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3, 4, 5, 6]],
      interlace: 2,
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'corrupt' });
  });

  test('rejects a color type and bit depth combination the spec disallows', async () => {
    // Color type 2 (RGB) only ever has 8 or 16-bit samples, never 4.
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 4,
      colorType: 2,
      rows: [[0]],
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'corrupt' });
  });

  test('rejects a corrupt checksum with reason corrupt', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3]],
      corruptCrc: true,
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'corrupt' });
  });

  test('rejects a file with the wrong signature', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3]],
      signature: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'unsupported-format' });
  });

  test('every rejection is an ImportError instance', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await rejectionOf(decodePng(bytes))).toBeInstanceOf(ImportError);
  });
});
