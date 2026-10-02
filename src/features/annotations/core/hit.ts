import type { PixelPoint } from '../../document';
import type { Annotation, AnnotationSet } from './contracts';
import { hitShape } from './geometry';

/** Topmost hit; tolerance is already in document pixels. The gesture controller loads this on use. */
export function hitAnnotationSet(
  set: AnnotationSet,
  point: PixelPoint,
  tolerance: number,
  selectedId?: string,
): Annotation | null {
  const preview = set.preview;
  if (preview && hitShape(preview, point, tolerance, preview.id === selectedId)) return preview;
  const shapes = set.shapes;
  for (let index = shapes.length - 1; index >= 0; index--) {
    const shape = shapes[index]!;
    if (preview?.id === shape.id) continue;
    if (hitShape(shape, point, tolerance, shape.id === selectedId)) return shape;
  }
  return null;
}
