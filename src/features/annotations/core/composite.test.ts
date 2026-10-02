import { expect, test } from 'bun:test';
import { packRgba } from '../../document';
import { compositeAnnotationLayer } from './composite';

test('flattening keeps every untouched pixel byte-identical', () => {
  const base = new Uint32Array([
    packRgba(7, 11, 19, 37),
    packRgba(10, 20, 30),
    packRgba(21, 34, 55, 0),
  ]);
  const layer = new Uint8ClampedArray([200, 150, 100, 0, 255, 0, 0, 128, 200, 100, 50, 128]);
  const result = compositeAnnotationLayer(base, layer);
  const bytes = new Uint8ClampedArray(result.buffer);
  expect(result[0]).toBe(base[0]);
  expect(Array.from(bytes.slice(4, 8))).toEqual([133, 10, 15, 255]);
  expect(Array.from(bytes.slice(8, 12))).toEqual([200, 100, 50, 128]);
  expect(base[1]).toBe(packRgba(10, 20, 30));
});

test('opaque annotation pixels replace their source exactly', () => {
  const result = compositeAnnotationLayer(
    new Uint32Array([packRgba(1, 2, 3, 4)]),
    new Uint8ClampedArray([5, 6, 7, 255]),
  );
  expect(result[0]).toBe(packRgba(5, 6, 7));
});
