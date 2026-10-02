import type { BitmapDocument } from '../../document';
import type { DocumentStore } from '../core/contracts';
import { saveDocument } from './autosaveRuntime';

/**
 * Names the live document and persists the name. Autosave writes `document.name` with every
 * snapshot, so the live document changes first and a later save can't restore the old name.
 * A rename that lands behind an in-flight save queues after it in the store's per-document
 * order. Naming a canvas that was never stored is an intent to keep it, so it gets its first
 * full save here and appears in Recent.
 */
export function renameDocument(
  document: BitmapDocument,
  name: string,
  store: DocumentStore,
  isStored: boolean,
): Promise<void> {
  document.name = name;
  return isStored ? store.rename(document.id, name) : saveDocument(document, store);
}
