import type { PixelPoint } from '../../document';

/** Screen coordinates are CSS pixels; backing stores scale by devicePixelRatio. */
export interface Viewport {
  zoom: number;
  /** Exact whole-number fit to show at rest; a gesture clears it. */
  fittedZoom?: number;
  panX: number;
  panY: number;
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}
export type DocumentPoint = PixelPoint;

export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
