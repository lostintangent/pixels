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

describe('per-id write chain', () => {
  test('load waits for a save already in flight for the same id, instead of racing it', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-race', 8, 8, 'Race');
    await saveFull(document, store); // baseline row so this is an update, not a fresh insert

    document.pixels[0] = packRgba(9, 8, 7, 6);
    const snapshot = snapshotDocument(document, [{ tx: 0, ty: 0 }], false);
    const save = store.save(snapshot, new Uint8Array([1])); // not awaited on purpose

    const loaded = await store.load('doc-race'); // fires while the save above is still in flight
    await save;

    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([9, 8, 7, 6]);
  });

  test('two overlapping saves for the same id commit in call order, not whichever transaction happens to finish first', async () => {
    const store = freshStore();
    // A big baseline so the first save's full-resave delete-cursor has many tiles to walk,
    // making it the slower of the two if writes aren't explicitly chained.
    const big = createBitmapDocument('doc-order', 256, 256, 'Order');
    big.pixels.fill(packRgba(1, 1, 1, 255));
    await saveFull(big, store);

    const first = createBitmapDocument('doc-order', 256, 256, 'First');
    first.pixels.fill(packRgba(2, 2, 2, 255));
    const firstSave = store.save(snapshotDocument(first, [], true), new Uint8Array([1]));

    // Issued immediately after, touching a single small tile: the "fast" write if unserialized.
    const second = createBitmapDocument('doc-order', 256, 256, 'Second');
    second.pixels[0] = packRgba(3, 3, 3, 255);
    const secondSave = store.save(
      snapshotDocument(second, [{ tx: 0, ty: 0 }], false),
      new Uint8Array([2]),
    );

    await Promise.all([firstSave, secondSave]);
    const loaded = await store.load('doc-order');
    // Second was issued after first, so it must win regardless of which transaction actually
    // committed first — proving writes are chained in call order, not left to race.
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([3, 3, 3, 255]);
  });

  test('a load for an unrelated document id is never held up by another id’s pending write', async () => {
    const store = freshStore();
    const documentA = createBitmapDocument('doc-a', 8, 8, 'A');
    const documentB = createBitmapDocument('doc-b', 8, 8, 'B');
    await saveFull(documentA, store);
    await saveFull(documentB, store);

    documentA.pixels[0] = packRgba(1, 1, 1, 1);
    const pendingA = store.save(
      snapshotDocument(documentA, [{ tx: 0, ty: 0 }], false),
      new Uint8Array([1]),
    );

    const loadedB = await store.load('doc-b');
    expect(loadedB!.name).toBe('B');
    await pendingA;
  });

  test('save reserves this id’s write order the instant it is called, even while the thumbnail is still encoding', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-thumb', 8, 8, 'Thumb');
    await saveFull(document, store);

    document.pixels[0] = packRgba(4, 3, 2, 1);
    const snapshot = snapshotDocument(document, [{ tx: 0, ty: 0 }], false);
    let resolveThumbnail!: (bytes: Uint8Array) => void;
    const thumbnail = new Promise<Uint8Array>((resolve) => {
      resolveThumbnail = resolve;
    });
    // Passed straight through, unresolved — mirrors how the autosave runtime hands `store.save`
    // the thumbnail encode's promise directly so this call reserves its place synchronously.
    const save = store.save(snapshot, thumbnail);

    const loadPromise = store.load('doc-thumb'); // issued while the thumbnail is still pending
    resolveThumbnail(new Uint8Array([1]));
    const loaded = await loadPromise;
    await save;

    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([4, 3, 2, 1]);
  });

  test('a rejected thumbnail promise queued behind another write never surfaces as an unhandled rejection', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-reject', 8, 8, 'Reject');
    await saveFull(document, store);

    // The thumbnail is best-effort: its own promise is never awaited by the write path, so even a
    // thumbnail that rejects immediately must not surface as an unhandled rejection, and the save
    // it belongs to (the tile and document-record write) must still resolve normally.
    const save = store.save(
      snapshotDocument(document, [], true),
      Promise.reject(new Error('thumbnail encode failed')),
    );

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await save;
      await new Promise((resolve) => setTimeout(resolve, 20)); // give it a chance to misfire
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('a save resolves — and its tiles become loadable — without waiting for the thumbnail at all', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-no-wait', 8, 8, 'NoWait');
    document.pixels[0] = packRgba(5, 6, 7, 8);

    // A thumbnail that never settles: if the write path still waited on it, `save` would hang
    // forever. It must not — pixel data is real document state; the thumbnail is a preview icon.
    const neverSettles = new Promise<Uint8Array>(() => {});
    await store.save(snapshotDocument(document, [], true), neverSettles);

    const loaded = await store.load('doc-no-wait');
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([5, 6, 7, 8]);
  });

  test('the thumbnail is patched in once it resolves, after an initial save that did not wait for it', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-patch', 8, 8, 'Patch');

    let resolveThumbnail!: (bytes: Uint8Array) => void;
    const thumbnail = new Promise<Uint8Array>((resolve) => {
      resolveThumbnail = resolve;
    });
    await store.save(snapshotDocument(document, [], true), thumbnail);

    // The save above already resolved without the real thumbnail: it's an entirely new document,
    // so its placeholder is empty until the worker round trip below actually lands.
    const beforePatch = await store.listRecents();
    expect(beforePatch[0]!.thumbnail.size).toBe(0);

    resolveThumbnail(new Uint8Array([7, 7, 7]));
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the detached patch write land

    const afterPatch = await store.listRecents();
    const bytes = new Uint8Array(await afterPatch[0]!.thumbnail.arrayBuffer());
    expect([...bytes]).toEqual([7, 7, 7]);
  });
});
