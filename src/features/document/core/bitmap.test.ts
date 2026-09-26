import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, getPixel, packRgba } from './bitmap';

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
});
