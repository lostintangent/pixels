import type { PixelPoint } from '../../document';

/** Screen coordinates are CSS pixels; backing stores scale by devicePixelRatio. */
export interface Viewport {
  zoom: number;
  /**
   * The exact fit this view rests at. A moving pinch that began at that fit keeps it so its label
   * can name the fit as its destination. A finished zoom elsewhere clears it.
   */
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
