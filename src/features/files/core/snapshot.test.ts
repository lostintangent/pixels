import { describe, expect, test } from 'bun:test';
import { annotationsFor } from '../../annotations/model';
import { createBitmapDocument, packRgba } from '../../document';
import { snapshotDocument } from './snapshot';
import { extractAllTiles } from './tiles';

describe('snapshotDocument', () => {
  test('copies tile bytes eagerly, so later mutation of the live document does not affect it', () => {
    const document = createBitmapDocument('doc-1', 64, 64, 'Sprite');
    document.pixels.fill(packRgba(10, 20, 30, 255));

    const snapshot = snapshotDocument(document, [{ tx: 0, ty: 0 }], false);
    expect(snapshot.tiles).toHaveLength(1);
    expect(snapshot.tiles[0]!.pixels[0]).toBe(10);

    // Simulate a stroke landing after the snapshot was taken.
    document.pixels.fill(packRgba(200, 0, 0, 255));

    expect(snapshot.tiles[0]!.pixels[0]).toBe(10);
    expect(snapshot.name).toBe('Sprite');
  });

  test('a full resave captures a single synchronous copy of the whole buffer, to split into tiles lazily', () => {
    const document = createBitmapDocument('doc-2', 100, 70);
    document.pixels.fill(packRgba(5, 6, 7, 255));
    const snapshot = snapshotDocument(document, [], true);
    expect(snapshot.fullResave).toBe(true);
    expect(snapshot.tiles).toHaveLength(0);
    expect(snapshot.fullResaveBytes).toBeDefined();
    expect(snapshot.fullResaveBytes).toHaveLength(100 * 70 * 4);

    // Simulate a stroke landing after the snapshot was taken.
    document.pixels.fill(packRgba(200, 0, 0, 255));

    const tiles = [...extractAllTiles(snapshot.fullResaveBytes!, document.width, document.height)];
    expect(tiles).toHaveLength(2 * 2); // ceil(100/64) x ceil(70/64)
    expect(tiles[0]!.pixels[0]).toBe(5); // still the pre-stroke value, not the later one
  });

  test('deduplicates repeated dirty tile coordinates', () => {
    const document = createBitmapDocument('doc-3', 64, 64);
    const snapshot = snapshotDocument(
      document,
      [
        { tx: 0, ty: 0 },
        { tx: 0, ty: 0 },
      ],
      false,
    );
    expect(snapshot.tiles).toHaveLength(1);
  });

  test('builds a thumbnail from a detached copy of the pixels', () => {
    const document = createBitmapDocument('doc-4', 128, 128);
    document.pixels.fill(packRgba(1, 2, 3));
    const snapshot = snapshotDocument(document, [], true);
    expect(snapshot.thumbnailPixels.width).toBeLessThanOrEqual(64);
    expect(snapshot.thumbnailPixels.height).toBeLessThanOrEqual(64);
  });

  test('captures the committed shapes alongside pixels, on both the partial and full-resave paths', () => {
    const document = createBitmapDocument('doc-5', 64, 64);
    const shape = {
      id: 'r1',
      kind: 'rectangle' as const,
      start: { x: 1, y: 1 },
      end: { x: 10, y: 10 },
      width: 1,
      color: packRgba(255, 0, 0),
    };
    annotationsFor(document).commit(shape);

    const partial = snapshotDocument(document, [{ tx: 0, ty: 0 }], false);
    expect(partial.shapes).toEqual([shape]);

    const full = snapshotDocument(document, [], true);
    expect(full.shapes).toEqual([shape]);
  });

  test('a document with no shapes ever drawn captures an empty shapes list, without creating an AnnotationSet', () => {
    const document = createBitmapDocument('doc-6', 32, 32);
    const snapshot = snapshotDocument(document, [], true);
    expect(snapshot.shapes).toEqual([]);
  });
});
