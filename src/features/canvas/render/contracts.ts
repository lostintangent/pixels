import type { BitmapDocument, PixelRect } from '../../document';
import type { Viewport } from '../core/contracts';

export interface CanvasRenderer {
  setDocument(document: BitmapDocument): void;
  setViewport(viewport: Viewport): void;
  invalidate(rect: PixelRect): void;
  invalidateOverlay(): void;
  dispose(): void;
}

export interface RendererSurface {
  documentCanvas: HTMLCanvasElement;
  viewportCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
}
