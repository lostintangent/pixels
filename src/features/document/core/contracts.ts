/** Coordinates and rectangles are integer document pixels. Rectangles are half-open. */
export interface PixelPoint {
  x: number;
  y: number;
}
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Packed ABGR in a Uint32Array on little-endian browsers: bytes are RGBA. */
export type PackedColor = number;

export interface BitmapDocument {
  readonly id: string;
  name: string;
  width: number;
  height: number;
  /** Shares its ArrayBuffer with rgbaBytes, so ImageData can be a zero-copy view.
   * Full-canvas history swaps this buffer. Read pixels/rgbaBytes from the document
   * for each operation; never cache either view across an undo or redo. */
  pixels: Uint32Array;
  rgbaBytes: Uint8ClampedArray;
  revision: number;
  events: DocumentEvents;
}

export type DirtyRectListener = (rect: PixelRect, revision: number) => void;

export interface DocumentEvents {
  subscribe(listener: DirtyRectListener): () => void;
  invalidate(rect: PixelRect): void;
}
