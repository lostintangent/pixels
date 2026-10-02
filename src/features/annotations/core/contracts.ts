import type { PackedColor, PixelPoint } from '../../document';

export type AnnotationKind = 'rectangle' | 'arrow';
export type AnnotationHandleId =
  | 'nw'
  | 'ne'
  | 'se'
  | 'sw'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'start'
  | 'end';

/** Coordinates and stroke width are document pixels; color is encoded in the document color space. */
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  start: PixelPoint;
  end: PixelPoint;
  width: number;
  color: PackedColor;
}

export interface AnnotationHandle extends PixelPoint {
  id: AnnotationHandleId;
}

export interface AnnotationChange {
  kind: 'preview' | 'commit';
}

export interface AnnotationSet {
  /** Committed shapes, in back-to-front paint order. */
  readonly shapes: readonly Annotation[];
  /** Temporary replacement or new shape; ignored by persistence. */
  readonly preview: Annotation | null;
  subscribe(listener: (change: AnnotationChange) => void): () => void;
  snapshot(): Annotation[];
  /** Loading and history restore through the same notification path. */
  replace(shapes: readonly Annotation[]): void;
  get(id: string): Annotation | null;
  showPreview(shape: Annotation | null): void;
  /** Add or replace a shape, preserving its original z-order. */
  commit(shape: Annotation): void;
  remove(id: string): boolean;
  /** Topmost hit. Tolerance is already converted from screen pixels to document pixels. */
  hitTest(point: PixelPoint, tolerance: number, selectedId?: string): Annotation | null;
}
