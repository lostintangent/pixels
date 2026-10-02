import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { loadDocument } from '../loaders';
import { createDocumentStore } from '../storage/documentStore';
import { attachAutosave, saveDocument } from './autosaveRuntime';
import { terminatePngWorkerClient } from './pngWorkerClient';
import { renameDocument } from './rename';

afterEach(() => {
  terminatePngWorkerClient();
});

let dbCounter = 0;
function freshStore() {
  return createDocumentStore({ databaseName: `rename-test-db-${dbCounter++}` });
}

const SLOW = { debounceMs: 5000, maxWaitMs: 20000 };

function paint(document: ReturnType<typeof createBitmapDocument>, x: number) {
  document.pixels[x] = packRgba(200, 40, 20);
  document.events.invalidate({ x, y: 0, width: 1, height: 1 });
}

describe('renameDocument', () => {
  test('a later autosave keeps the new name, and a reload reads it', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-a', 8, 8, 'Untitled');
    await saveDocument(document, store);
    const autosave = attachAutosave(document, store, SLOW);

    await renameDocument(document, 'Hero sprite', store, true);
    paint(document, 0);
    await autosave.flush();
    autosave.dispose();

    const reloaded = await loadDocument(store, 'doc-a');
    expect(reloaded?.name).toBe('Hero sprite');
    expect(reloaded?.pixels[0]).toBe(packRgba(200, 40, 20));
    const [recent] = await store.listRecents();
    expect(recent?.name).toBe('Hero sprite');
  });

  test('a rename during an in-flight save lands after it', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-a', 8, 8, 'Untitled');
    await saveDocument(document, store);
    const autosave = attachAutosave(document, store, SLOW);

    paint(document, 1);
    const saving = autosave.flush(); // its snapshot already holds the old name
    const renaming = renameDocument(document, 'Walk cycle', store, true);
    await Promise.all([saving, renaming]);
    autosave.dispose();

    expect((await loadDocument(store, 'doc-a'))?.name).toBe('Walk cycle');
  });

  test('naming a blank canvas that was never stored keeps it in Recent', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-blank', 16, 16, 'Untitled');
    const autosave = attachAutosave(document, store, SLOW);
    expect(await store.listRecents()).toHaveLength(0);

    await renameDocument(document, 'Tiles', store, false);
    autosave.dispose();

    const recents = await store.listRecents();
    expect(recents.map((recent) => [recent.id, recent.name])).toEqual([['doc-blank', 'Tiles']]);
    const reloaded = await loadDocument(store, 'doc-blank');
    expect(reloaded?.name).toBe('Tiles');
    expect([reloaded?.width, reloaded?.height]).toEqual([16, 16]);
  });

  test('a kept blank canvas still saves later strokes incrementally', async () => {
    const store = freshStore();
    const document = createBitmapDocument('doc-blank', 16, 16, 'Untitled');
    const autosave = attachAutosave(document, store, SLOW);
    await renameDocument(document, 'Tiles', store, false);

    paint(document, 3);
    await autosave.flush();
    autosave.dispose();

    const reloaded = await loadDocument(store, 'doc-blank');
    expect(reloaded?.name).toBe('Tiles');
    expect(reloaded?.pixels[3]).toBe(packRgba(200, 40, 20));
  });
});
