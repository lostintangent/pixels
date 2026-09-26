import { createBitmapDocument, type BitmapDocument } from '../document';
import type { DocumentStore } from './core/contracts';
import { waitForPendingSave } from './core/pendingSaves';

export interface RecentOrNewResult {
  document: BitmapDocument;
  isNew: boolean;
}

/**
 * For `/d/$docId`. Returns null so the route can render a graceful not-found state.
 *
 * Waits for any save already registered for `id` before reading, so a route with `gcTime: 0`
 * (re-reading IndexedDB on every visit) can't race the flush a just-left document kicked off and
 * read the pixels it's about to replace.
 */
export async function loadDocument(
  store: DocumentStore,
  id: string,
): Promise<BitmapDocument | null> {
  await waitForPendingSave(id);
  const loaded = await store.load(id);
  if (!loaded) return null;
  const document = createBitmapDocument(loaded.id, loaded.width, loaded.height, loaded.name);
  document.rgbaBytes.set(loaded.pixels);
  return document;
}

/**
 * For `/`. Opens the most recently updated document, or creates a fresh blank one if there are
 * none yet. The blank document is in-memory only: nothing is written until the first edit, so
 * recents never fill up with empty canvases. The route should redirect (replace) to
 * `/d/$docId` with the returned id either way, so a reload lands on the same document.
 */
export async function loadMostRecentOrNew(
  store: DocumentStore,
  makeId: () => string,
  newDocumentSize = 64,
): Promise<RecentOrNewResult> {
  const recents = await store.listRecents();
  const mostRecent = recents[0];
  if (!mostRecent) {
    return {
      document: createBitmapDocument(makeId(), newDocumentSize, newDocumentSize),
      isNew: true,
    };
  }
  const document = await loadDocument(store, mostRecent.id);
  if (!document) {
    return {
      document: createBitmapDocument(makeId(), newDocumentSize, newDocumentSize),
      isNew: true,
    };
  }
  return { document, isNew: false };
}
