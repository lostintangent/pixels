import type { BitmapDocument, DocumentColorSpace, PixelRect } from '../../document';
import type { Viewport } from '../core/contracts';

export interface CanvasRenderer {
  setDocument(document: BitmapDocument): void;
  setViewport(viewport: Viewport): void;
  setOverlay(overlay: OverlayState): void;
  invalidateOverlay(): void;
  dispose(): void;
}

export interface OverlayPreview {
  /** Compact RGBA pixels for bounds, or full document pixels when stride is set. */
  pixels: Uint32Array;
  bounds: PixelRect;
  dirty?: PixelRect;
  stride?: number;
}

export interface OverlayState {
  grid: 'auto' | 'on' | 'off';
  cursor: PixelRect | null;
  marquee: PixelRect | null;
  preview: OverlayPreview | null;
  /** Cover committed source pixels while a lifted selection floats above them. */
  sourceClear?: PixelRect | null;
  reducedMotion?: boolean;
  colors?: {
    checkerA: string;
    checkerB: string;
    gridMinor: string;
    gridMajor: string;
  };
}

export interface RendererSurface {
  documentCanvas: HTMLCanvasElement;
  viewportCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  colorSpace?: DocumentColorSpace;
}
