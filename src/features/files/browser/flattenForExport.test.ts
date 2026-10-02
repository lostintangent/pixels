import { describe, expect, test } from 'bun:test';
import type { Annotation } from '../../annotations';
import { packRgba } from '../../document';
import { flattenShapesForExport } from './flattenForExport';

const rectangle: Annotation = {
  id: 'r1',
  kind: 'rectangle',
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
  width: 1,
  color: packRgba(255, 0, 0, 255),
};

describe('flattenShapesForExport', () => {
  test('returns the same pixels reference, untouched, when there are no shapes', () => {
    const pixels = new Uint32Array([packRgba(1, 2, 3, 255), packRgba(4, 5, 6, 255)]);
    const result = flattenShapesForExport(pixels, 2, 1, 'srgb', []);
    expect(result).toBe(pixels); // same reference: proves no canvas work was attempted
  });

  test(
    'throws a clear error for a non-empty shapes list when OffscreenCanvas is unavailable ' +
      '(bun test’s environment) — real browsers always have it inside a Worker, so this path ' +
      'only ever exercises the error, never silently drops a shape from the exported bytes',
    () => {
      const pixels = new Uint32Array([packRgba(1, 2, 3, 255), packRgba(4, 5, 6, 255)]);
      expect(() => flattenShapesForExport(pixels, 2, 1, 'srgb', [rectangle])).toThrow(
        /OffscreenCanvas/,
      );
    },
  );
});
