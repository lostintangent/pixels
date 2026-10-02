import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Annotation } from '../../annotations/model';
import { createBitmapDocument, packRgba } from '../../document';
import type { DocumentSnapshot, TileSnapshot } from '../core/contracts';
import { extractTile } from '../core/tiles';
import { snapshotDocument } from '../core/snapshot';
import { createDocumentStore } from './documentStore';

/** A minimal in-memory `Storage`, since `bun test` has no `localStorage` global of its own — the
 *  crash-recovery journal is otherwise only ever exercised by the live-browser durability suite. */
class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

let memoryStorage: MemoryStorage;
beforeEach(() => {
  memoryStorage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = memoryStorage;
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** Mirrors the private key format in `documentStore.ts`, purely so these tests can inspect
 *  whether a stash actually landed in (or was cleared from) `localStorage`. */
function crashRecoveryKey(id: string): string {
  return `pixels-files-crash-recovery:${id}`;
}

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

  test('a full resave spanning more tiles than one save batch still round-trips every tile byte-exact', async () => {
    // 1536² is 24x24 = 576 tiles at TILE_SIZE 64 — more than SAVE_BATCH_TILE_COUNT (512), so this
    // save's tile puts cross at least one internal batch boundary (an awaited request mid-loop,
    // not just one synchronous pass). Distinct per-tile colors prove no tile is skipped,
    // duplicated, or overwritten by a neighboring batch.
    const store = freshStore();
    const side = 1536;
    const document = createBitmapDocument('doc-batch', side, side, 'Big Batch');
    const tilesPerAxis = side / 64;
    for (let ty = 0; ty < tilesPerAxis; ty++) {
      for (let tx = 0; tx < tilesPerAxis; tx++) {
        const value = (ty * tilesPerAxis + tx) % 255;
        for (let y = 0; y < 64; y++) {
          for (let x = 0; x < 64; x++) {
            document.pixels[(ty * 64 + y) * side + (tx * 64 + x)] = packRgba(value, value, value);
          }
        }
      }
    }
    await saveFull(document, store);

    const loaded = await store.load('doc-batch');
    expect(loaded).not.toBeNull();
    for (let ty = 0; ty < tilesPerAxis; ty++) {
      for (let tx = 0; tx < tilesPerAxis; tx++) {
        const expectedValue = (ty * tilesPerAxis + tx) % 255;
        const offset = ((ty * 64 + 7) * side + (tx * 64 + 7)) * 4;
        expect([...loaded!.pixels.subarray(offset, offset + 4)]).toEqual([
          expectedValue,
          expectedValue,
          expectedValue,
          255,
        ]);
      }
    }
  });

  test('saves and loads committed shapes alongside pixels, byte-for-byte', async () => {
    const { annotationsFor } = await import('../../annotations/model');
    const store = freshStore();
    const document = createBitmapDocument('doc-shapes', 64, 64, 'Shapes');
    const rectangle: Annotation = {
      id: 'r1',
      kind: 'rectangle',
      start: { x: 2, y: 2 },
      end: { x: 20, y: 20 },
      width: 1,
      color: packRgba(255, 0, 0),
    };
    const arrow: Annotation = {
      id: 'a1',
      kind: 'arrow',
      start: { x: 0, y: 0 },
      end: { x: 30, y: 30 },
      width: 2,
      color: packRgba(0, 0, 255),
    };
    annotationsFor(document).replace([rectangle, arrow]);

    await saveFull(document, store);
    const loaded = await store.load('doc-shapes');

    expect(loaded!.shapes).toEqual([rectangle, arrow]);
  });

  test('a document with no shapes ever drawn loads an empty shapes list', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-no-shapes', 32, 32, 'Plain');
    await saveFull(document, store);

    const loaded = await store.load('doc-no-shapes');
    expect(loaded!.shapes).toEqual([]);
  });

  test('drops an invalid shape on load rather than surfacing corrupt data, e.g. from a future format', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-bad-shape', 32, 32, 'BadShape');
    const valid: Annotation = {
      id: 'ok',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 },
      width: 1,
      color: packRgba(1, 2, 3),
    };
    const invalid = { id: 'bad', kind: 'rectangle' } as unknown as Annotation; // missing start/end/width/color
    const snapshot = { ...snapshotDocument(document, [], true), shapes: [valid, invalid] };
    await store.save(snapshot, new Uint8Array());

    const loaded = await store.load('doc-bad-shape');
    expect(loaded!.shapes).toEqual([valid]);
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

/** Builds a `DocumentSnapshot` shaped like an exit-time journal stash, without going through a
 *  live `BitmapDocument` — these tests exercise `load()`'s recovery merge directly. */
function recoveryStash(options: {
  id: string;
  name?: string;
  width: number;
  height: number;
  updatedAt: number;
  fullResave: boolean;
  tiles: TileSnapshot[];
  shapes?: Annotation[];
}): DocumentSnapshot {
  return {
    id: options.id,
    name: options.name ?? 'Recovered',
    width: options.width,
    height: options.height,
    updatedAt: options.updatedAt,
    tiles: options.tiles,
    fullResave: options.fullResave,
    shapes: options.shapes ?? [],
    thumbnailPixels: { width: 0, height: 0, pixels: new Uint32Array(0), scale: 1 },
    colorSpace: 'srgb',
  };
}

function soloTile(tx: number, ty: number, fill: number): TileSnapshot {
  const pixels = new Uint8Array(64 * 64 * 4);
  pixels.fill(fill);
  return { tx, ty, pixels };
}

describe('crash-recovery journal', () => {
  test('recovery merges the stashed tiles over what is already stored, leaving the rest intact', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-merge', 128, 64, 'Merge');
    document.pixels.fill(packRgba(1, 1, 1, 255));
    await saveFull(document, store);

    // A journal entry left behind at exit, covering only the second tile (tx=1) with a newer
    // timestamp than the stored record — exactly what an exit stash for one dirtied tile looks
    // like when the rest of the document already committed normally.
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-merge',
        width: 128,
        height: 64,
        updatedAt: Date.now() + 1000,
        fullResave: false,
        tiles: [soloTile(1, 0, 2)],
      }),
    );

    const loaded = await store.load('doc-merge');
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([1, 1, 1, 255]); // tile 0 untouched, from storage
    expect([...loaded!.pixels.subarray(64 * 4, 64 * 4 + 4)]).toEqual([2, 2, 2, 2]); // tile 1, from the journal
  });

  test('a full-resave journal entry replaces the stored grid entirely, not merges over it', async () => {
    const store = freshStore();
    const big = createBitmapDocument('doc-full', 128, 128, 'Big');
    big.pixels.fill(packRgba(5, 5, 5, 255));
    await saveFull(big, store);

    // A full-resave exit stash (e.g. after a resize) only ever includes tile 0:0's corner filled
    // in; a merge would incorrectly resurrect the old tile 1/1 corner from storage.
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-full',
        width: 128,
        height: 128,
        updatedAt: Date.now() + 1000,
        fullResave: true,
        tiles: [soloTile(0, 0, 9)],
      }),
    );

    const loaded = await store.load('doc-full');
    const farCorner = (127 * 128 + 127) * 4;
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([9, 9, 9, 9]);
    expect([...loaded!.pixels.subarray(farCorner, farCorner + 4)]).toEqual([0, 0, 0, 0]);
  });

  test('a journal entry carries shapes too, replacing whatever shape list is already stored', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-shape-recover', 64, 64, 'ShapeRecover');
    document.pixels.fill(packRgba(1, 1, 1, 255));
    await saveFull(document, store); // stored with no shapes

    const recoveredShape: Annotation = {
      id: 'r1',
      kind: 'rectangle',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
      width: 1,
      color: packRgba(9, 9, 9),
    };
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-shape-recover',
        width: 64,
        height: 64,
        updatedAt: Date.now() + 1000,
        fullResave: false,
        tiles: [],
        shapes: [recoveredShape],
      }),
    );

    const loaded = await store.load('doc-shape-recover');
    expect(loaded!.shapes).toEqual([recoveredShape]);
  });

  test('a journal entry no newer than the stored record is ignored, and cleared rather than left behind', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-stale', 64, 64, 'Stale');
    document.pixels.fill(packRgba(3, 3, 3, 255));
    await store.save(
      { ...snapshotDocument(document, [], true), updatedAt: 2000 },
      new Uint8Array(),
    );

    // A leftover journal entry from before the save above landed — same age, so it must not win.
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-stale',
        width: 64,
        height: 64,
        updatedAt: 2000,
        fullResave: false,
        tiles: [soloTile(0, 0, 8)],
      }),
    );

    const loaded = await store.load('doc-stale');
    expect([...loaded!.pixels.subarray(0, 4)]).toEqual([3, 3, 3, 255]); // the stored write wins
    expect(memoryStorage.getItem(crashRecoveryKey('doc-stale'))).toBeNull(); // and the stale entry is gone
  });

  test('remove clears any pending journal entry, so a deleted document is never resurrected by it', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-removed', 64, 64, 'Removed');
    await saveFull(document, store);
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-removed',
        width: 64,
        height: 64,
        updatedAt: Date.now() + 1000,
        fullResave: false,
        tiles: [soloTile(0, 0, 1)],
      }),
    );

    await store.remove('doc-removed');

    expect(await store.load('doc-removed')).toBeNull();
    expect(memoryStorage.getItem(crashRecoveryKey('doc-removed'))).toBeNull();
  });

  test('a snapshot over the crash-recovery size cap is never stashed', async () => {
    const store = freshStore();
    const oversizedTile: TileSnapshot = { tx: 0, ty: 0, pixels: new Uint8Array(2 * 1024 * 1024) };
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-oversize',
        width: 64,
        height: 64,
        updatedAt: Date.now(),
        fullResave: true,
        tiles: [oversizedTile],
      }),
    );

    expect(memoryStorage.getItem(crashRecoveryKey('doc-oversize'))).toBeNull();
    expect(await store.load('doc-oversize')).toBeNull(); // nothing to recover from, either
  });

  test('load() persists a recovered document to IndexedDB, not just returned in memory', async () => {
    const store = freshStore();
    // A brand-new document that crashed before its first normal save ever landed: nothing in
    // IndexedDB yet, only the journal.
    store.stashForRecovery(
      recoveryStash({
        id: 'doc-recover-persist',
        name: 'RecoverPersist',
        width: 64,
        height: 64,
        updatedAt: Date.now(),
        fullResave: true,
        tiles: [soloTile(0, 0, 4)],
      }),
    );

    const firstLoad = await store.load('doc-recover-persist');
    expect([...firstLoad!.pixels.subarray(0, 4)]).toEqual([4, 4, 4, 4]);

    // The journal entry is cleared once recovery persists, so this second load can only be
    // seeing this if the recovered write actually reached IndexedDB the first time.
    expect(memoryStorage.getItem(crashRecoveryKey('doc-recover-persist'))).toBeNull();
    const secondLoad = await store.load('doc-recover-persist');
    expect([...secondLoad!.pixels.subarray(0, 4)]).toEqual([4, 4, 4, 4]);

    const recents = await store.listRecents();
    const summary = recents.find((r) => r.id === 'doc-recover-persist');
    expect(summary).not.toBeUndefined();
    expect(summary!.thumbnail.size).toBeGreaterThan(0); // a real PNG, not the blank placeholder
  });
});
