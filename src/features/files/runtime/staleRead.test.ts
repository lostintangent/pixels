import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { loadDocument } from '../loaders';
import { createDocumentStore } from '../storage/documentStore';
import { attachAutosave } from './autosaveRuntime';

let dbCounter = 0;
function freshStore() {
  return createDocumentStore({ databaseName: `stale-read-test-db-${dbCounter++}` });
}

describe('stale-read guarantee', () => {
  test('navigating away before the debounce fires still persists, and an immediate reload reads it', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-a', 8, 8, 'A');
    const autosave = attachAutosave(document, store, { initialResave: true });
    await autosave.flush(); // the initial full save a real "New canvas" flow awaits before navigating in

    // Edit, then leave immediately, long before the 5s debounce would ever fire on its own.
    document.pixels[0] = packRgba(9, 8, 7, 6);
    document.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    autosave.dispose();

    // Navigate straight back to A. With `gcTime: 0` this re-reads the store, so it must not race
    // the flush `dispose()` just kicked off.
    const reloaded = await loadDocument(store, 'doc-a');

    expect(reloaded).not.toBeNull();
    expect([...reloaded!.rgbaBytes.subarray(0, 4)]).toEqual([9, 8, 7, 6]);
  });

  test('a load for an unrelated document id is never held up by another document’s pending save', async () => {
    const store = freshStore();
    const documentA = createBitmapDocument('doc-a', 8, 8, 'A');
    const documentB = createBitmapDocument('doc-b', 8, 8, 'B');
    const autosaveA = attachAutosave(documentA, store, { initialResave: true });
    const autosaveB = attachAutosave(documentB, store, { initialResave: true });
    await Promise.all([autosaveA.flush(), autosaveB.flush()]);

    documentA.pixels[0] = packRgba(1, 1, 1, 1);
    documentA.events.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    autosaveA.dispose(); // only A has a save in flight

    const reloadedB = await loadDocument(store, 'doc-b');
    expect(reloadedB).not.toBeNull();
    expect(reloadedB!.name).toBe('B');

    autosaveB.dispose();
  });
});
