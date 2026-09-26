import type { BitmapDocument, PackedColor, PixelPoint, PixelRect } from '../../document';

export interface Brush {
  color: PackedColor;
  size: number;
  pixelPerfect: boolean;
}
export interface StrokeSample extends PixelPoint {
  pressure?: number;
}
export type ToolKind = 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'line' | 'select';

/** A mutation updates pixels in place and reports precisely what changed. */
export interface MutationResult {
  dirty: PixelRect | null;
  changedPixels: number;
}
export type MutatingOperation<Input> = (document: BitmapDocument, input: Input) => MutationResult;

export interface StrokeInput {
  from: StrokeSample;
  to: StrokeSample;
  brush: Brush;
}
export interface FillInput {
  at: PixelPoint;
  color: PackedColor;
}
export interface LineInput {
  from: PixelPoint;
  to: PixelPoint;
  brush: Brush;
}

/** Floating selection pixels are compact, row-major, and independent of the document. */
export interface FloatingSelection {
  bounds: PixelRect;
  pixels: Uint32Array;
  sourceBounds: PixelRect;
}

export interface SelectionMoveInput {
  selection: FloatingSelection;
  to: PixelPoint;
}
