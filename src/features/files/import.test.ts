import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../document';
import { ImportError } from './core/contracts';
import { encodePng } from './core/png';
import { exportPng } from './export';
import { importPng } from './import';

/** `.rejects` isn't typed as a thenable in bun-types, so assert rejections by awaiting directly. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
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

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Splices an extra color chunk right after IHDR in an already-encoded PNG — cheaper than
 *  building a whole PNG by hand, and exercises `importPng` against bytes shaped like a real file
 *  that (like a real macOS Display P3 screenshot) carries more than one color chunk at once. */
function injectColorChunkAfterIhdr(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const ihdrLength = new DataView(png.buffer, png.byteOffset + 8, 4).getUint32(0);
  const ihdrChunkEnd = 8 + 12 + ihdrLength; // signature + length/type/crc + data
  const inserted = buildChunk(type, data);
  const out = new Uint8Array(png.length + inserted.length);
  out.set(png.subarray(0, ihdrChunkEnd), 0);
  out.set(inserted, ihdrChunkEnd);
  out.set(png.subarray(ihdrChunkEnd), ihdrChunkEnd + inserted.length);
  return out;
}

describe('importPng', () => {
  test('decodes bytes into a live BitmapDocument with the requested id and name', async () => {
    const pixels = new Uint32Array([packRgba(1, 2, 3, 4), packRgba(5, 6, 7, 8)]);
    const bytes = await encodePng(2, 1, pixels);
    const document = await importPng(bytes, 'imported-1', 'My Sprite');
    expect(document.id).toBe('imported-1');
    expect(document.name).toBe('My Sprite');
    expect(document.width).toBe(2);
    expect(document.height).toBe(1);
    expect([...document.pixels]).toEqual([...pixels]);
  });

  test('accepts a Blob, matching what a file picker or drop event hands over', async () => {
    const pixels = new Uint32Array([packRgba(9, 9, 9, 255)]);
    const bytes = await encodePng(1, 1, pixels);
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    const document = await importPng(blob, 'imported-2');
    expect(document.width).toBe(1);
    expect([...document.pixels]).toEqual([...pixels]);
  });

  test('accepts a raw ArrayBuffer', async () => {
    const pixels = new Uint32Array([packRgba(4, 4, 4, 255)]);
    const bytes = await encodePng(1, 1, pixels);
    const document = await importPng(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'imported-3',
    );
    expect(document.width).toBe(1);
  });

  test('rejects a corrupt file with a recoverable ImportError', async () => {
    expect(await rejectionOf(importPng(new Uint8Array([1, 2, 3]), 'bad'))).toBeInstanceOf(
      ImportError,
    );
  });
});

describe('importPng color tagging', () => {
  test('a plain PNG with no color chunk opens as an sRGB document', async () => {
    const pixels = new Uint32Array([packRgba(10, 20, 30, 255)]);
    const bytes = await encodePng(1, 1, pixels);
    const document = await importPng(bytes, 'srgb-doc');
    expect(document.colorSpace).toBe('srgb');
    expect([...document.pixels]).toEqual([...pixels]);
  });

  test('a PNG carrying the real cICP Display P3 bytes opens as a display-p3 document, exact pixels', async () => {
    const pixels = new Uint32Array([packRgba(10, 20, 30, 255), packRgba(200, 100, 50, 200)]);
    const plain = await encodePng(2, 1, pixels);
    // Verified against a real macOS Display P3 screenshot (`sips -m "Display P3.icc"`).
    const tagged = injectColorChunkAfterIhdr(plain, 'cICP', new Uint8Array([12, 13, 0, 1]));
    const document = await importPng(tagged, 'p3-doc');
    expect(document.colorSpace).toBe('display-p3');
    // cICP tagging never re-maps numbers, only how they're interpreted: pixels stay exact.
    expect([...document.pixels]).toEqual([...pixels]);
  });

  test(
    'a PNG with an unrecognized color chunk falls back gracefully under bun test (no DOM): ' +
      'exact pixels, tagged plain sRGB rather than throwing',
    async () => {
      const pixels = new Uint32Array([packRgba(1, 2, 3, 255)]);
      const plain = await encodePng(1, 1, pixels);
      // Rec. 2020 primaries/transfer: real color information neither of our two shorthand checks
      // recognizes. `createImageBitmap` isn't available under `bun test`, so `importPng` must keep
      // the already-decoded, exact pixels rather than throw or hang.
      const tagged = injectColorChunkAfterIhdr(plain, 'cICP', new Uint8Array([9, 16, 0, 1]));
      const document = await importPng(tagged, 'unknown-icc-doc');
      expect(document.colorSpace).toBe('srgb');
      expect([...document.pixels]).toEqual([...pixels]);
    },
  );

  test('exportPng tags a display-p3 document with cICP, round-tripping through importPng', async () => {
    const document = createBitmapDocument('p3-roundtrip', 2, 1, 'Untitled', 'display-p3');
    document.pixels[0] = packRgba(50, 60, 70, 255);
    document.pixels[1] = packRgba(80, 90, 100, 255);
    const bytes = await exportPng(document);
    const reimported = await importPng(bytes, 'p3-roundtrip-2');
    expect(reimported.colorSpace).toBe('display-p3');
    expect([...reimported.pixels]).toEqual([...document.pixels]);
  });
});

describe('exportPng round-trips through importPng', () => {
  test('exact for partial alpha at 1x', async () => {
    const document = createBitmapDocument('doc', 2, 2);
    document.pixels[0] = packRgba(10, 20, 30, 128);
    document.pixels[1] = packRgba(255, 0, 0, 0);
    document.pixels[2] = packRgba(0, 255, 0, 1);
    document.pixels[3] = packRgba(0, 0, 255, 255);

    const bytes = await exportPng(document);
    const reimported = await importPng(bytes, 'doc-2');
    expect([...reimported.pixels]).toEqual([...document.pixels]);
  });

  test('exports at an integer scale', async () => {
    const document = createBitmapDocument('doc', 2, 1);
    document.pixels[0] = packRgba(1, 2, 3);
    document.pixels[1] = packRgba(4, 5, 6);
    const bytes = await exportPng(document, { scale: 4 });
    const reimported = await importPng(bytes, 'doc-scaled');
    expect(reimported.width).toBe(8);
    expect(reimported.height).toBe(4);
  });
});
