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
