import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { snapshotDocument } from './snapshot';

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

  test('a full resave snapshots every tile in the grid', () => {
    const document = createBitmapDocument('doc-2', 100, 70);
    const snapshot = snapshotDocument(document, [], true);
    expect(snapshot.fullResave).toBe(true);
    expect(snapshot.tiles).toHaveLength(2 * 2); // ceil(100/64) x ceil(70/64)
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
});
