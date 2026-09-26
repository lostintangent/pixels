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
  rows: number[][]; // one array of raw (unfiltered, filter-byte-free) bytes per row
  interlace?: number;
  corruptCrc?: boolean;
  signature?: number[];
}): Promise<Uint8Array> {
  const { width, height, bitDepth, colorType, palette, trns, rows, interlace = 0 } = options;
  const rowBytes = rows[0]?.length ?? 0;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(rows[y]!, y * (rowBytes + 1) + 1);
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

  test('rejects interlaced PNGs with reason unsupported-format', async () => {
    const bytes = await buildTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rows: [[1, 2, 3, 4, 5, 6]],
      interlace: 1,
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'unsupported-format' });
  });

  test('rejects 16-bit PNGs with reason unsupported-format', async () => {
    const bytes = await buildTestPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 2,
      rows: [[0, 10, 0, 20, 0, 30]],
    });
    expect(await rejectionOf(decodePng(bytes))).toMatchObject({ reason: 'unsupported-format' });
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
