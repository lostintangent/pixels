/** Framework-free viewport API for feature models and session logic. */
export type { OverlayPreview, OverlayState } from './render/contracts';
export type { DocumentPoint, ScreenPoint, Viewport, ViewportInsets } from './core/contracts';
export type { PointerKind } from './core/gestures';
export {
  MIN_ZOOM,
  documentToScreen,
  fitViewport,
  fitZoom,
  screenToDocument,
  snapZoom,
  stepZoom,
  zoomToStep,
  zoomStep,
} from './core/viewport';
export type { ViewBounds } from './core/bounds';
export { boundView, snapZoomWithin } from './core/bounds';
