import type { BitmapDocument } from '../../document';
import type { Annotation, AnnotationChange, AnnotationSet } from './contracts';
import { hitShape } from './geometry';

function copy(shape: Annotation): Annotation {
  return { ...shape, start: { ...shape.start }, end: { ...shape.end } };
}

export function isValidAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const shape = value as Partial<Annotation>;
  return (
    typeof shape.id === 'string' &&
    shape.id.length > 0 &&
    (shape.kind === 'rectangle' || shape.kind === 'arrow') &&
    Number.isFinite(shape.start?.x) &&
    Number.isFinite(shape.start?.y) &&
    Number.isFinite(shape.end?.x) &&
    Number.isFinite(shape.end?.y) &&
    Number.isFinite(shape.width) &&
    shape.width! > 0 &&
    Number.isInteger(shape.color) &&
    shape.color! >= 0 &&
    shape.color! <= 0xffffffff
  );
}

const sets = new WeakMap<BitmapDocument, AnnotationSet>();

export function createAnnotationSet(): AnnotationSet {
  let shapes: Annotation[] = [];
  let preview: Annotation | null = null;
  const listeners = new Set<(change: AnnotationChange) => void>();
  const previewChange: AnnotationChange = { kind: 'preview' };
  const commitChange: AnnotationChange = { kind: 'commit' };
  const emit = (change: AnnotationChange) => {
    for (const listener of listeners) listener(change);
  };
  return {
    get shapes() {
      return shapes;
    },
    get preview() {
      return preview;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      return shapes.map(copy);
    },
    replace(next) {
      shapes = next.filter(isValidAnnotation).map(copy);
      preview = null;
      emit(commitChange);
    },
    get(id) {
      return shapes.find((shape) => shape.id === id) ?? null;
    },
    showPreview(shape) {
      preview = shape;
      emit(previewChange);
    },
    commit(shape) {
      if (!isValidAnnotation(shape)) throw new RangeError('Invalid annotation');
      const index = shapes.findIndex((item) => item.id === shape.id);
      if (index < 0) shapes = [...shapes, copy(shape)];
      else {
        shapes = shapes.slice();
        shapes[index] = copy(shape);
      }
      preview = null;
      emit(commitChange);
    },
    remove(id) {
      const index = shapes.findIndex((shape) => shape.id === id);
      if (index < 0) return false;
      shapes = [...shapes.slice(0, index), ...shapes.slice(index + 1)];
      preview = null;
      emit(commitChange);
      return true;
    },
    hitTest(point, tolerance, selectedId) {
      if (preview && hitShape(preview, point, tolerance, preview.id === selectedId)) {
        return preview;
      }
      for (let index = shapes.length - 1; index >= 0; index--) {
        const shape = shapes[index]!;
        if (preview?.id === shape.id) continue;
        if (hitShape(shape, point, tolerance, shape.id === selectedId)) return shape;
      }
      return null;
    },
  };
}

/** One annotation owner per live bitmap, with no dependency from document back to annotations. */
export function annotationsFor(document: BitmapDocument): AnnotationSet {
  let set = sets.get(document);
  if (!set) {
    set = createAnnotationSet();
    sets.set(document, set);
  }
  return set;
}
