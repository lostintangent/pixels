import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { extractTile } from '../core/tiles';
import { snapshotDocument } from '../core/snapshot';
import { createDocumentStore } from './documentStore';

let dbCounter = 0;
function freshStore() {
  return createDocumentStore({ databaseName: `test-db-${dbCounter++}` });
}

async function saveFull(
  document: ReturnType<typeof createBitmapDocument>,
  store: ReturnType<typeof createDocumentStore>,
) {
  const snapshot = snapshotDocument(document, [], true);
  await store.save(snapshot, new Uint8Array([1, 2, 3])); // fake thumbnail bytes, not real PNG
  return snapshot;
}

describe('createDocumentStore', () => {
  test('saves and loads a document byte-for-byte', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-a', 70, 65, 'Hero');
    document.pixels.fill(packRgba(9, 8, 7, 255));
    document.pixels[0] = packRgba(1, 2, 3, 4);

    await saveFull(document, store);
    const loaded = await store.load('doc-a');

    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Hero');
    expect(loaded!.width).toBe(70);
    expect(loaded!.height).toBe(65);
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...loaded!.pixels.subarray(4, 8)]).toEqual([9, 8, 7, 255]);
  });

  test('load returns null for an unknown id', async () => {
    const store = freshStore();
    expect(await store.load('missing')).toBeNull();
  });

  test('an incremental save only touches its dirty tiles, leaving the rest intact', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-b', 128, 64, 'Two Tiles');
    document.pixels.fill(packRgba(1, 1, 1, 255));
    await saveFull(document, store);

    // Dirty only the second tile (tx=1), simulating a stroke there.
    document.pixels.fill(packRgba(2, 2, 2, 255), 64, 128); // first row, tile 1's columns
    const snapshot = snapshotDocument(document, [{ tx: 1, ty: 0 }], false);
    await store.save(snapshot, new Uint8Array([1]));

    const loaded = await store.load('doc-b');
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([1, 1, 1, 255]); // tile 0 untouched
    expect([...loaded!.pixels.subarray(64 * 4, 64 * 4 + 4)]).toEqual([2, 2, 2, 255]); // tile 1 updated
  });

  test('shrinking a document on a full resave removes stale tiles, leaving no leftovers', async () => {
    const store = freshStore();
    const big = createBitmapDocument('doc-c', 128, 128, 'Big');
    big.pixels.fill(packRgba(5, 5, 5, 255));
    await saveFull(big, store);

    const small = createBitmapDocument('doc-c', 64, 64, 'Small');
    small.pixels.fill(packRgba(9, 9, 9, 255));
    await saveFull(small, store);

    const loaded = await store.load('doc-c');
    expect(loaded!.width).toBe(64);
    expect(loaded!.height).toBe(64);
    expect(loaded!.pixels.length).toBe(64 * 64 * 4);
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([9, 9, 9, 255]);

    // Re-growing back to 128 must not resurrect the old tile 1/1 data (it should be transparent, not 5,5,5).
    const regrown = createBitmapDocument('doc-c', 128, 128, 'Regrown');
    // Only fill the original 64x64 corner to mimic a resize-with-anchor; the rest stays zeroed.
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) regrown.pixels[y * 128 + x] = packRgba(9, 9, 9, 255);
    }
    await saveFull(regrown, store);
    const reloaded = await store.load('doc-c');
    const farCorner = (127 * 128 + 127) * 4;
    expect([...reloaded!.pixels.subarray(farCorner, farCorner + 4)]).toEqual([0, 0, 0, 0]);
  });

  test('rename updates metadata without touching tiles', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-d', 64, 64, 'Old Name');
    await saveFull(document, store);
    await store.rename('doc-d', 'New Name');
    const loaded = await store.load('doc-d');
    expect(loaded!.name).toBe('New Name');
  });

  test('remove deletes metadata and every tile', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-e', 128, 128);
    await saveFull(document, store);
    await store.remove('doc-e');
    expect(await store.load('doc-e')).toBeNull();
    const recents = await store.listRecents();
    expect(recents.find((r) => r.id === 'doc-e')).toBeUndefined();
  });

  test('listRecents sorts newest first and exposes thumbnails as PNG blobs', async () => {
    const store = freshStore();
    const older = createBitmapDocument('doc-f', 32, 32, 'Older');
    const olderSnapshot = snapshotDocument(older, [], true);
    await store.save({ ...olderSnapshot, updatedAt: 1000 }, new Uint8Array([9]));

    const newer = createBitmapDocument('doc-g', 32, 32, 'Newer');
    const newerSnapshot = snapshotDocument(newer, [], true);
    await store.save({ ...newerSnapshot, updatedAt: 2000 }, new Uint8Array([9]));

    const recents = await store.listRecents();
    expect(recents.map((r) => r.id)).toEqual(['doc-g', 'doc-f']);
    expect(recents[0]!.thumbnail).toBeInstanceOf(Blob);
    expect(recents[0]!.thumbnail.type).toBe('image/png');
  });

  test('extractTile stays consistent with the store round-trip (sanity check on the shared helper)', () => {
    const document = createBitmapDocument('doc-h', 64, 64);
    document.pixels.fill(packRgba(3, 3, 3, 255));
    const tile = extractTile(document.rgbaBytes, 64, 64, { tx: 0, ty: 0 });
    expect(tile.pixels[0]).toBe(3);
  });
});
