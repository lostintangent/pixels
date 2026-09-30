/** Framework-free viewport API for feature models and session logic. */
export type { OverlayPreview, OverlayState } from './render/contracts';
export type { ScreenPoint, Viewport, ViewportInsets } from './core/contracts';
export type { PointerKind } from './core/gestures';
export { fitViewport, screenToDocument, stepZoom, zoomToStep } from './core/viewport';
