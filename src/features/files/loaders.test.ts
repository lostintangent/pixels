import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../document';
import { snapshotDocument } from './core/snapshot';
import { createDocumentStore } from './storage/documentStore';
import { loadDocument, pickInitialDocumentId } from './loaders';

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

describe('pickInitialDocumentId', () => {
  test('mints a fresh id when the store is empty', async () => {
    const store = freshStore();
    const id = await pickInitialDocumentId(store, () => 'generated-id');
    expect(id).toBe('generated-id');
  });

  test('picks the most recently updated document\u2019s id when one exists', async () => {
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

    const id = await pickInitialDocumentId(store, () => 'unused-id');
    expect(id).toBe('newer');
  });
});
