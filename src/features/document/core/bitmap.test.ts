import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, getPixel, packRgba } from './bitmap';
import { resizeDocument } from './resize';

describe('bitmap storage', () => {
  test('packed colors and ImageData bytes share exactly the same pixels', () => {
    const document = createBitmapDocument('one', 2, 1);
    document.pixels[0] = packRgba(1, 2, 3, 4);
    document.pixels[1] = packRgba(255, 128, 0);
    expect([...document.rgbaBytes]).toEqual([1, 2, 3, 4, 255, 128, 0, 255]);
    expect(getPixel(document, { x: 1, y: 0 })).toBe(packRgba(255, 128, 0));
    expect(getPixel(document, { x: -1, y: 0 })).toBeNull();
  });

  test('rejects dimensions outside the document contract', () => {
    expect(() => createBitmapDocument('bad', 0, 1)).toThrow(RangeError);
    expect(() => createBitmapDocument('bad', 4097, 1)).toThrow(RangeError);
  });

  test('new canvases default to sRGB and resize keeps a P3 document tagged', () => {
    expect(createBitmapDocument('new', 1, 1).colorSpace).toBe('srgb');
    const p3 = createBitmapDocument('p3', 2, 2, 'Wide color', 'display-p3');
    const resized = resizeDocument(p3, 3, 3);
    expect(resized.colorSpace).toBe('display-p3');
  });
});
