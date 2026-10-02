import { createBitmapDocument, type BitmapDocument } from '../document';
import type { DocumentStore } from './core/contracts';

/**
 * For `/d/$docId`. Returns null so the route can render a graceful not-found state.
 *
 * `store.load` itself waits for any write already chained for `id` before reading, so a route
 * with `gcTime: 0` (re-reading IndexedDB on every visit) can't race the flush a just-left document
 * kicked off and read the pixels it's about to replace.
 */
export async function loadDocument(
  store: DocumentStore,
  id: string,
): Promise<BitmapDocument | null> {
  const loaded = await store.load(id);
  if (!loaded) return null;
  const document = createBitmapDocument(
    loaded.id,
    loaded.width,
    loaded.height,
    loaded.name,
    loaded.colorSpace,
  );
  document.rgbaBytes.set(loaded.pixels);
  // Dynamic: a document with no persisted shapes never pulls in the mutable `AnnotationSet`
  // implementation. `../annotations`, not `../../annotations/model` — hydration needs the live,
  // replaceable set (`annotationsFor`), not just the read-only lookup `core/` code uses.
  if (loaded.shapes.length > 0) {
    const { annotationsFor } = await import('../annotations');
    annotationsFor(document).replace(loaded.shapes);
  }
  return document;
}

/**
 * For `/`. Picks the id to redirect to: the most recently updated document, or a freshly minted
 * one if there are none yet. Deliberately does not load the document itself — `listRecents` only
 * reads the small documents index, never the tile store — so the `/d/$docId` redirect target's
 * own loader (via `loadDocument`) is the only place that ever pays for tile reassembly. An
 * earlier version loaded the full document here and threw it away on redirect, paying that cost
 * twice on every cold load.
 */
export async function pickInitialDocumentId(
  store: DocumentStore,
  makeId: () => string,
): Promise<string> {
  const recents = await store.listRecents();
  return recents[0]?.id ?? makeId();
}
