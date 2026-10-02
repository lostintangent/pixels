import type { BitmapDocument } from '../../document';
import type { AnnotationSet } from './contracts';

const sets = new WeakMap<BitmapDocument, AnnotationSet>();
const waiting = new WeakMap<BitmapDocument, Set<(set: AnnotationSet) => void>>();

/** Read without creating a mutable set on the pixel-only first load. */
export function findAnnotationsFor(document: BitmapDocument): AnnotationSet | null {
  return sets.get(document) ?? null;
}

export function registerAnnotationSet(document: BitmapDocument, set: AnnotationSet): void {
  sets.set(document, set);
  const listeners = waiting.get(document);
  if (!listeners) return;
  waiting.delete(document);
  for (const listener of listeners) listener(set);
}

/** The renderer attaches when loading or a gesture first creates the document's set. */
export function watchAnnotationSet(
  document: BitmapDocument,
  listener: (set: AnnotationSet) => void,
): () => void {
  const existing = sets.get(document);
  if (existing) {
    listener(existing);
    return () => {};
  }
  let listeners = waiting.get(document);
  if (!listeners) {
    listeners = new Set();
    waiting.set(document, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) waiting.delete(document);
  };
}
