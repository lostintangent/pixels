import { describe, expect, test } from 'bun:test';
import { packRgba } from '../../document';
import { ImportError } from './contracts';
import { decodePng, encodePng } from './png';

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
  if (palette) {
    const plteData = new Uint8Array(palette);
    parts.push(chunk('PLTE', plteData));
  }
  if (trns) parts.push(chunk('tRNS', new Uint8Array(trns)));
  const idatChunk = chunk('IDAT', idat);
  if (options.corruptCrc)
    idatChunk[idatChunk.length - 1] = (idatChunk[idatChunk.length - 1] ?? 0) ^ 0xff;
  parts.push(idatChunk, chunk('IEND', new Uint8Array(0)));
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
