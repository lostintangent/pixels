import type { PixelPoint } from '../../document';

/** Screen coordinates are CSS pixels; backing stores scale by devicePixelRatio. */
export interface Viewport {
  zoom: number;
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
