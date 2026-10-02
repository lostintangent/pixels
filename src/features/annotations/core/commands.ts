import { canvasAnchorOffset, resizeDocument } from '../../document';
import type { BitmapDocument, CanvasAnchor, PixelPoint } from '../../document';
import type { DocumentHistory, HistoryExternalState } from '../../history';
import type { Annotation, AnnotationSet } from './contracts';
import { annotationsFor } from './set';

let nextId = 0;

export function createAnnotationId(): string {
  nextId++;
  return `shape-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

export function translateAnnotation(shape: Annotation, delta: PixelPoint): Annotation {
  return {
    ...shape,
    start: { x: shape.start.x + delta.x, y: shape.start.y + delta.y },
    end: { x: shape.end.x + delta.x, y: shape.end.y + delta.y },
  };
}

export interface AnnotationEdit {
  preview(shape: Annotation): void;
  commit(shape: Annotation): boolean;
  cancel(): void;
}

function sameShapes(before: readonly Annotation[], after: readonly Annotation[]): boolean {
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index++) {
    const a = before[index]!;
    const b = after[index]!;
    if (
      a.id !== b.id ||
      a.kind !== b.kind ||
      a.start.x !== b.start.x ||
      a.start.y !== b.start.y ||
      a.end.x !== b.end.x ||
      a.end.y !== b.end.y ||
      a.width !== b.width ||
      a.color !== b.color
    )
      return false;
  }
  return true;
}

export function annotationHistoryState(set: AnnotationSet): HistoryExternalState {
  return {
    snapshot: () => set.snapshot(),
    restore: (snapshot) => set.replace(snapshot as Annotation[]),
    equals: (before, after) => sameShapes(before as Annotation[], after as Annotation[]),
    byteSize: (snapshot) =>
      (snapshot as Annotation[]).reduce((size, shape) => size + 80 + shape.id.length * 2, 0),
  };
}

/** Preview remains outside the committed set and autosave until the gesture ends. */
export function beginAnnotationEdit(
  document: BitmapDocument,
  history: DocumentHistory,
  label: string,
): AnnotationEdit {
  const set = annotationsFor(document);
  const transaction = history.begin(label, document, annotationHistoryState(set));
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error('Annotation edit is closed');
  };
  return {
    preview(shape) {
      ensureOpen();
      set.showPreview(shape);
    },
    commit(shape) {
      ensureOpen();
      closed = true;
      set.commit(shape);
      return transaction.commit();
    },
    cancel() {
      ensureOpen();
      closed = true;
      set.showPreview(null);
      transaction.cancel();
    },
  };
}

export function deleteAnnotation(
  document: BitmapDocument,
  history: DocumentHistory,
  id: string,
): boolean {
  const set = annotationsFor(document);
  if (!set.get(id)) return false;
  const transaction = history.begin('Delete shape', document, annotationHistoryState(set));
  set.remove(id);
  return transaction.commit();
}

/** Command-D duplicates in place with a visible offset. Option-drag uses an edit gesture instead. */
export function duplicateAnnotation(
  document: BitmapDocument,
  history: DocumentHistory,
  id: string,
  offset: PixelPoint = { x: 10, y: 10 },
): string | null {
  const set = annotationsFor(document);
  const source = set.get(id);
  if (!source) return null;
  const next = translateAnnotation({ ...source, id: createAnnotationId() }, offset);
  const transaction = history.begin('Duplicate shape', document, annotationHistoryState(set));
  set.commit(next);
  transaction.commit();
  return next.id;
}

/** Resizing shifts shapes by the same anchor offset as pixels, with one shared undo entry. */
export function resizeAnnotatedDocument(
  document: BitmapDocument,
  history: DocumentHistory,
  width: number,
  height: number,
  anchor: CanvasAnchor,
): BitmapDocument {
  const next = resizeDocument(document, width, height, anchor);
  const offset = canvasAnchorOffset(document.width, document.height, width, height, anchor);
  annotationsFor(next).replace(
    annotationsFor(document)
      .snapshot()
      .map((shape) => translateAnnotation(shape, offset)),
  );
  history.pushReplacement('Resize canvas', document, next);
  return next;
}
