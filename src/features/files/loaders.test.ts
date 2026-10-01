import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../document';
import { snapshotDocument } from './core/snapshot';
import { createDocumentStore } from './storage/documentStore';
import { loadDocument, loadMostRecentOrNew } from './loaders';

let dbCounter = 0;
function freshStore() {
  return createDocumentStore({ databaseName: `loaders-test-${dbCounter++}` });
}

describe('loadDocument', () => {
  test('returns null for an id with nothing stored', async () => {
    const store = freshStore();
    expect(await loadDocument(store, 'missing')).toBeNull();
  });

  test('reconstructs a live BitmapDocument with the stored pixels', async () => {
    const store = freshStore();
    const original = createBitmapDocument('doc-1', 64, 64, 'Saved');
    original.pixels.fill(packRgba(7, 8, 9, 255));
    await store.save(snapshotDocument(original, [], true), new Uint8Array([1]));

    const loaded = await loadDocument(store, 'doc-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Saved');
    expect([...loaded!.rgbaBytes.subarray(0, 4)]).toEqual([7, 8, 9, 255]);
  });

  test('round-trips a display-p3 document\u2019s color space', async () => {
    const store = freshStore();
    const original = createBitmapDocument('doc-p3', 4, 4, 'P3 doc', 'display-p3');
    await store.save(snapshotDocument(original, [], true), new Uint8Array([1]));

    const loaded = await loadDocument(store, 'doc-p3');
    expect(loaded!.colorSpace).toBe('display-p3');
  });
});

describe('loadMostRecentOrNew', () => {
  test('creates a fresh blank document when the store is empty', async () => {
    const store = freshStore();
    const result = await loadMostRecentOrNew(store, () => 'generated-id');
    expect(result.isNew).toBe(true);
    expect(result.document.id).toBe('generated-id');
    expect(result.document.width).toBe(64);
    expect(result.document.height).toBe(64);
  });

  test('opens the most recently updated document when one exists', async () => {
    const store = freshStore();
    const older = createBitmapDocument('older', 32, 32, 'Older');
    await store.save(
      { ...snapshotDocument(older, [], true), updatedAt: 1000 },
      new Uint8Array([1]),
    );
    const newer = createBitmapDocument('newer', 48, 48, 'Newer');
    await store.save(
      { ...snapshotDocument(newer, [], true), updatedAt: 2000 },
      new Uint8Array([1]),
    );

    const result = await loadMostRecentOrNew(store, () => 'unused-id');
    expect(result.isNew).toBe(false);
    expect(result.document.id).toBe('newer');
    expect(result.document.width).toBe(48);
  });
});
