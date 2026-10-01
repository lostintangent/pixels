import type {
  BitmapDocument,
  DocumentColorSpace,
  PackedColor,
  PixelPoint,
  PixelRect,
} from '../../document';
import type { DocumentHistory } from '../../history';

export interface Brush {
  color: PackedColor;
  size: number;
  pixelPerfect: boolean;
}
export interface StrokeSample extends PixelPoint {
  pressure?: number;
}
export type ToolKind = 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'line' | 'select';
export interface MutationResult {
  dirty: PixelRect | null;
  changedPixels: number;
}
export interface FillInput {
  at: PixelPoint;
  color: PackedColor;
}

/** One gesture owns one history transaction. Cancel restores every sample. */
export interface StrokeSession {
  extend(sample: StrokeSample): MutationResult;
  end(): boolean;
  cancel(): void;
}
export type BeginStroke = (
  document: BitmapDocument,
  brush: Brush,
  history: DocumentHistory,
) => StrokeSession;

/** Previews rasterize only into overlay pixels, never the document. */
export interface LinePreview {
  readonly overlay: Uint32Array;
  readonly bounds: PixelRect | null;
  readonly dirty: PixelRect | null;
  update(to: PixelPoint, snap?: boolean): PixelRect | null;
  commit(): boolean;
  cancel(): void;
}

/** A compact row-major buffer can be copied, cut, moved, and pasted. */
export interface FloatingSelection {
  bounds: PixelRect;
  pixels: Uint32Array;
  sourceBounds: PixelRect;
  colorSpace: DocumentColorSpace;
}
export interface SelectionSession {
  readonly floating: FloatingSelection | null;
  /** Source pixels hidden by a lifted selection, while the document stays unchanged. */
  readonly sourceToClear: PixelRect | null;
  lift(rect: PixelRect): FloatingSelection | null;
  /** Floats copied pixels over the document without changing the pixels underneath. */
  paste(selection: FloatingSelection, to: PixelPoint): FloatingSelection | null;
  move(to: PixelPoint): PixelRect | null;
  commit(): boolean;
  cancel(): void;
  clear(): boolean;
}
