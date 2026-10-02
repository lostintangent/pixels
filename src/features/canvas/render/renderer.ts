import type { BitmapDocument, DocumentColorSpace, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import { watchAnnotationSet, type AnnotationSet } from '../../annotations/model';
import type { Viewport } from '../core/contracts';
import type { CanvasRenderer, OverlayPreview, OverlayState, RendererSurface } from './contracts';

const EMPTY_OVERLAY: OverlayState = {
  grid: 'auto',
  cursor: null,
  marquee: null,
  preview: null,
  sourceClear: null,
};

function context(
  canvas: HTMLCanvasElement,
  colorSpace: DocumentColorSpace,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: true, colorSpace });
  if (!ctx) throw new Error('Canvas 2D context is unavailable');
  return ctx;
}

function smoothingForView(view: Viewport): 'off' | 'low' | 'high' {
  if (view.zoom >= 1) return 'off';
  const deviceScale = view.zoom * view.devicePixelRatio;
  if (deviceScale < 1) return 'high';
  return Math.abs(deviceScale - Math.round(deviceScale)) < 0.000001 ? 'off' : 'low';
}

function checkerPattern(ctx: CanvasRenderingContext2D, a: string, b: string): CanvasPattern {
  const tile = globalThis.document.createElement('canvas');
  tile.width = tile.height = 16;
  const tileCtx = context(tile, 'srgb');
  tileCtx.fillStyle = a;
  tileCtx.fillRect(0, 0, 16, 16);
  tileCtx.fillStyle = b;
  tileCtx.fillRect(0, 0, 8, 8);
  tileCtx.fillRect(8, 8, 8, 8);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) throw new Error('Checkerboard pattern is unavailable');
  return pattern;
}

/** The document shadow's blur and drop in CSS pixels, small enough to stay inside the fit gap. */
const SHADOW_BLUR = 6;
const SHADOW_DROP = 1;

/**
 * Draws the document's hairline and shadow strictly outside its device-pixel footprint, so a
 * fractional edge pixel keeps exactly the blend the document drew.
 */
function drawDocumentEdge(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  bitmap: BitmapDocument,
  view: Viewport,
  edge: string | undefined,
  shadow: string | undefined,
): void {
  const scale = view.devicePixelRatio;
  const left = Math.floor(view.panX * scale);
  const top = Math.floor(view.panY * scale);
  const right = Math.ceil((view.panX + bitmap.width * view.zoom) * scale);
  const bottom = Math.ceil((view.panY + bitmap.height * view.zoom) * scale);
  const width = right - left;
  const height = bottom - top;
  const reach = Math.ceil((SHADOW_BLUR + SHADOW_DROP) * scale) + 1;
  if (left > canvasWidth + reach || top > canvasHeight + reach || right < -reach || bottom < -reach)
    return;
  if (left < -reach && top < -reach && right > canvasWidth + reach && bottom > canvasHeight + reach)
    return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = SHADOW_BLUR * scale;
    ctx.shadowOffsetY = SHADOW_DROP * scale;
    ctx.fillStyle = '#000';
    // Four plain rectangle clips stay exact. Chrome's even-odd clip leaked into a fractional corner.
    const bands = [
      [left - reach, top - reach, width + reach * 2, reach],
      [left - reach, bottom, width + reach * 2, reach],
      [left - reach, top, reach, height],
      [right, top, reach, height],
    ] as const;
    for (const [x, y, w, h] of bands) {
      if (x >= canvasWidth || y >= canvasHeight || x + w <= 0 || y + h <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillRect(left, top, width, height);
      ctx.restore();
    }
    ctx.shadowColor = 'transparent';
  }
  if (edge) {
    ctx.fillStyle = edge;
    ctx.fillRect(left - 1, top - 1, width + 2, 1);
    ctx.fillRect(left - 1, bottom, width + 2, 1);
    ctx.fillRect(left - 1, top, 1, height);
    ctx.fillRect(right, top, 1, height);
  }
  ctx.restore();
}

function drawTwoToneRect(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  viewport: Viewport,
  phase: number,
): void {
  const x = viewport.panX + rect.x * viewport.zoom;
  const y = viewport.panY + rect.y * viewport.zoom;
  const width = rect.width * viewport.zoom;
  const height = rect.height * viewport.zoom;
  if (width <= 0 || height <= 0) return;
  const left = Math.round(x) + 0.5;
  const top = Math.round(y) + 0.5;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(left, top, width, height);
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -phase;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(left, top, width, height);
  ctx.setLineDash([]);
}

export function createCanvasRenderer(surface: RendererSurface): CanvasRenderer {
  const colorSpace = surface.colorSpace ?? 'srgb';
  const documentCtx = context(surface.documentCanvas, colorSpace);
  const viewportCtx = context(surface.viewportCanvas, colorSpace);
  const annotationCtx = context(surface.annotationCanvas, colorSpace);
  const overlayCtx = context(surface.overlayCanvas, colorSpace);
  let checker = checkerPattern(viewportCtx, '#fff', '#d6d6d6');
  let overlayChecker = checkerPattern(overlayCtx, '#fff', '#d6d6d6');
  let checkerA = '#fff';
  let checkerB = '#d6d6d6';
  const previewCanvas = globalThis.document.createElement('canvas');
  const previewCtx = context(previewCanvas, colorSpace);
  let document: BitmapDocument | null = null;
  let viewport: Viewport | null = null;
  let overlay = EMPTY_OVERLAY;
  let unsubscribe: (() => void) | null = null;
  let annotationUnsubscribe: (() => void) | null = null;
  let annotationWatchUnsubscribe: (() => void) | null = null;
  let annotations: AnnotationSet | null = null;
  let painter: typeof import('../../annotations') | null = null;
  let painterLoading = false;
  let imageData: ImageData | null = null;
  const mipmaps: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] = [];
  let pendingDirty: PixelRect | null = null;
  let viewportDirty = true;
  let annotationDirty = true;
  let overlayDirty = true;
  let previewImage: ImageData | null = null;
  let previewBuffer: ArrayBufferLike | null = null;
  let previewOffset = -1;
  let previewWidth = 0;
  let previewHeight = 0;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phase = 0;
  let disposed = false;
  const systemReducedMotion =
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

  function schedule(): void {
    if (disposed || frame) return;
    frame = requestAnimationFrame(render);
  }

  function loadPainter(): void {
    if (painter || painterLoading) return;
    painterLoading = true;
    void import('../../annotations').then((module) => {
      if (disposed) return;
      painter = module;
      annotationDirty = overlayDirty = true;
      schedule();
    });
  }

  function updateBackingStore(view: Viewport): void {
    const width = Math.max(1, Math.round(view.cssWidth * view.devicePixelRatio));
    const height = Math.max(1, Math.round(view.cssHeight * view.devicePixelRatio));
    for (const canvas of [
      surface.viewportCanvas,
      surface.annotationCanvas,
      surface.overlayCanvas,
    ]) {
      if (canvas.width !== width) {
        canvas.width = width;
        viewportDirty = annotationDirty = overlayDirty = true;
      }
      if (canvas.height !== height) {
        canvas.height = height;
        viewportDirty = annotationDirty = overlayDirty = true;
      }
    }
  }

  function updateDocumentCanvas(bitmap: BitmapDocument): void {
    if (
      surface.documentCanvas.width !== bitmap.width ||
      surface.documentCanvas.height !== bitmap.height
    ) {
      surface.documentCanvas.width = bitmap.width;
      surface.documentCanvas.height = bitmap.height;
      mipmaps.length = 0;
      imageData = null;
      pendingDirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    }
    if (!imageData || imageData.data.buffer !== bitmap.rgbaBytes.buffer) {
      imageData = new ImageData(
        bitmap.rgbaBytes as Uint8ClampedArray<ArrayBuffer>,
        bitmap.width,
        bitmap.height,
        { colorSpace },
      );
      pendingDirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    }
    if (pendingDirty) {
      const dirty = pendingDirty;
      documentCtx.putImageData(imageData, 0, 0, dirty.x, dirty.y, dirty.width, dirty.height);
      let previousDirty = dirty;
      for (let level = 0; level < mipmaps.length; level++) {
        const source = level === 0 ? surface.documentCanvas : mipmaps[level - 1]!.canvas;
        const { canvas, ctx } = mipmaps[level]!;
        // Include the resampling footprint so a changed source edge cannot leave stale colors.
        const left = Math.max(0, Math.floor((previousDirty.x - 2) / 2));
        const top = Math.max(0, Math.floor((previousDirty.y - 2) / 2));
        const right = Math.min(
          canvas.width,
          Math.ceil((previousDirty.x + previousDirty.width + 2) / 2),
        );
        const bottom = Math.min(
          canvas.height,
          Math.ceil((previousDirty.y + previousDirty.height + 2) / 2),
        );
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        ctx.clearRect(left, top, right - left, bottom - top);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        previousDirty = { x: left, y: top, width: right - left, height: bottom - top };
      }
      pendingDirty = null;
    }
  }

  function sourceForZoom(view: Viewport): HTMLCanvasElement {
    if (view.zoom * view.devicePixelRatio >= 1) return surface.documentCanvas;
    const scale = view.zoom * view.devicePixelRatio;
    const levels = Math.max(0, Math.floor(Math.log2(1 / scale)));
    while (mipmaps.length < levels) {
      const source = mipmaps.at(-1)?.canvas ?? surface.documentCanvas;
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(source.width / 2));
      canvas.height = Math.max(1, Math.ceil(source.height / 2));
      const ctx = context(canvas, colorSpace);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      mipmaps.push({ canvas, ctx });
    }
    return mipmaps[levels - 1]?.canvas ?? surface.documentCanvas;
  }

  function drawPreview(view: Viewport, preview: OverlayPreview): void {
    const stride = preview.stride ?? preview.bounds.width;
    const rows = preview.stride ? preview.pixels.length / stride : preview.bounds.height;
    if (stride <= 0 || rows <= 0) return;
    const byteLength = stride * rows * 4;
    if (preview.pixels.byteLength < byteLength) return;
    if (previewCanvas.width !== stride) previewCanvas.width = stride;
    if (previewCanvas.height !== rows) previewCanvas.height = rows;
    if (
      !previewImage ||
      previewBuffer !== preview.pixels.buffer ||
      previewOffset !== preview.pixels.byteOffset ||
      previewWidth !== stride ||
      previewHeight !== rows
    ) {
      const bytes = new Uint8ClampedArray(
        preview.pixels.buffer as ArrayBuffer,
        preview.pixels.byteOffset,
        byteLength,
      );
      previewImage = new ImageData(bytes, stride, rows, { colorSpace });
      previewBuffer = preview.pixels.buffer;
      previewOffset = preview.pixels.byteOffset;
      previewWidth = stride;
      previewHeight = rows;
    }
    if (preview.dirty && preview.stride) {
      const clip = { x: 0, y: 0, width: 0, height: 0 };
      if (intersectRect(preview.dirty, { x: 0, y: 0, width: stride, height: rows }, clip)) {
        previewCtx.putImageData(previewImage, 0, 0, clip.x, clip.y, clip.width, clip.height);
      }
    } else previewCtx.putImageData(previewImage, 0, 0);
    const smoothing = smoothingForView(view);
    overlayCtx.imageSmoothingEnabled = smoothing !== 'off';
    if (smoothing !== 'off') overlayCtx.imageSmoothingQuality = smoothing;
    overlayCtx.drawImage(
      previewCanvas,
      view.panX + preview.bounds.x * view.zoom,
      view.panY + preview.bounds.y * view.zoom,
      preview.bounds.width * view.zoom,
      preview.bounds.height * view.zoom,
    );
  }

  function drawGrid(ctx: CanvasRenderingContext2D, bitmap: BitmapDocument, view: Viewport): void {
    if (overlay.grid === 'off' || (overlay.grid === 'auto' && view.zoom < 8)) return;
    const left = Math.max(0, Math.floor(-view.panX / view.zoom));
    const right = Math.min(bitmap.width, Math.ceil((view.cssWidth - view.panX) / view.zoom));
    const top = Math.max(0, Math.floor(-view.panY / view.zoom));
    const bottom = Math.min(bitmap.height, Math.ceil((view.cssHeight - view.panY) / view.zoom));
    if (left > right || top > bottom) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.panX, view.panY, bitmap.width * view.zoom, bitmap.height * view.zoom);
    ctx.clip();
    // The dark line keeps the existing calm grid on white. One neighboring device
    // pixel of white makes the same boundary readable over black and saturated art.
    const lightOffset = 1 + 0.5 / view.devicePixelRatio;
    for (let major = 0; major < 2; major++) {
      for (let light = 0; light < 2; light++) {
        ctx.beginPath();
        ctx.strokeStyle = major
          ? light
            ? (overlay.colors?.gridMajorLight ?? 'rgba(255,255,255,.25)')
            : (overlay.colors?.gridMajor ?? 'rgba(0,0,0,.32)')
          : light
            ? (overlay.colors?.gridMinorLight ?? 'rgba(255,255,255,.16)')
            : (overlay.colors?.gridMinor ?? 'rgba(0,0,0,.12)');
        ctx.lineWidth = light ? 1 / view.devicePixelRatio : 1;
        for (let x = left; x <= right; x++) {
          if ((x % 8 === 0) !== Boolean(major)) continue;
          const screenX = Math.round(view.panX + x * view.zoom) + (light ? lightOffset : 0.5);
          ctx.moveTo(screenX, view.panY + top * view.zoom);
          ctx.lineTo(screenX, view.panY + bottom * view.zoom);
        }
        for (let y = top; y <= bottom; y++) {
          if ((y % 8 === 0) !== Boolean(major)) continue;
          const screenY = Math.round(view.panY + y * view.zoom) + (light ? lightOffset : 0.5);
          ctx.moveTo(view.panX + left * view.zoom, screenY);
          ctx.lineTo(view.panX + right * view.zoom, screenY);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawClearedSource(view: Viewport, bitmap: BitmapDocument, source: PixelRect): void {
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.rect(
      view.panX + source.x * view.zoom,
      view.panY + source.y * view.zoom,
      source.width * view.zoom,
      source.height * view.zoom,
    );
    overlayCtx.clip();
    overlayCtx.fillStyle = overlayChecker;
    overlayCtx.fillRect(0, 0, view.cssWidth, view.cssHeight);
    drawGrid(overlayCtx, bitmap, view);
    overlayCtx.restore();
  }

  function render(): void {
    frame = 0;
    if (!document || !viewport || disposed) return;
    const bitmap = document;
    const view = viewport;
    updateBackingStore(view);
    if (viewportDirty) {
      updateDocumentCanvas(bitmap);
      const pixelWidth = surface.viewportCanvas.width;
      const pixelHeight = surface.viewportCanvas.height;
      viewportCtx.setTransform(1, 0, 0, 1, 0, 0);
      viewportCtx.clearRect(0, 0, pixelWidth, pixelHeight);
      viewportCtx.setTransform(view.devicePixelRatio, 0, 0, view.devicePixelRatio, 0, 0);
      viewportCtx.save();
      viewportCtx.beginPath();
      viewportCtx.rect(view.panX, view.panY, bitmap.width * view.zoom, bitmap.height * view.zoom);
      viewportCtx.clip();
      viewportCtx.fillStyle = checker;
      viewportCtx.fillRect(0, 0, view.cssWidth, view.cssHeight);
      const smoothing = smoothingForView(view);
      viewportCtx.imageSmoothingEnabled = smoothing !== 'off';
      if (smoothing !== 'off') viewportCtx.imageSmoothingQuality = smoothing;
      viewportCtx.drawImage(
        sourceForZoom(view),
        view.panX,
        view.panY,
        bitmap.width * view.zoom,
        bitmap.height * view.zoom,
      );
      viewportCtx.restore();
      const colors = overlay.colors;
      if (colors?.edge || colors?.shadow)
        drawDocumentEdge(
          viewportCtx,
          pixelWidth,
          pixelHeight,
          bitmap,
          view,
          colors.edge,
          colors.shadow,
        );
      drawGrid(viewportCtx, bitmap, view);
      viewportDirty = false;
    }
    if (annotationDirty) {
      annotationCtx.setTransform(1, 0, 0, 1, 0, 0);
      annotationCtx.clearRect(
        0,
        0,
        surface.annotationCanvas.width,
        surface.annotationCanvas.height,
      );
      if (annotations && (annotations.shapes.length || annotations.preview)) {
        if (!painter) loadPainter();
        else {
          annotationCtx.setTransform(view.devicePixelRatio, 0, 0, view.devicePixelRatio, 0, 0);
          annotationCtx.save();
          annotationCtx.beginPath();
          annotationCtx.rect(
            view.panX,
            view.panY,
            bitmap.width * view.zoom,
            bitmap.height * view.zoom,
          );
          annotationCtx.clip();
          annotationCtx.translate(view.panX, view.panY);
          annotationCtx.scale(view.zoom, view.zoom);
          painter.paintVisibleAnnotations(annotationCtx, annotations, colorSpace);
          annotationCtx.restore();
        }
      }
      annotationDirty = false;
    }
    if (!overlayDirty) return;
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, surface.overlayCanvas.width, surface.overlayCanvas.height);
    overlayCtx.setTransform(view.devicePixelRatio, 0, 0, view.devicePixelRatio, 0, 0);
    if (overlay.sourceClear) drawClearedSource(view, bitmap, overlay.sourceClear);
    if (overlay.preview) drawPreview(view, overlay.preview);
    if (overlay.marquee) drawTwoToneRect(overlayCtx, overlay.marquee, view, phase);
    if (overlay.cursor) drawTwoToneRect(overlayCtx, overlay.cursor, view, phase);
    if (overlay.selectedAnnotationId && annotations) {
      const selected =
        annotations.preview?.id === overlay.selectedAnnotationId
          ? annotations.preview
          : annotations.get(overlay.selectedAnnotationId);
      if (selected) {
        if (!painter) loadPainter();
        else
          painter.paintAnnotationSelection(
            overlayCtx,
            selected,
            colorSpace,
            view.zoom,
            view.panX,
            view.panY,
            bitmap.width,
            bitmap.height,
            Boolean(overlay.coarseAnnotationHandles),
          );
      }
    }
    overlayDirty = false;
    if (overlay.marquee && !(overlay.reducedMotion ?? systemReducedMotion) && !timer) {
      timer = globalThis.setTimeout(() => {
        timer = null;
        phase = (phase + 1) % 8;
        overlayDirty = true;
        schedule();
      }, 80);
    }
  }

  return {
    setDocument(bitmap) {
      if (bitmap.colorSpace !== colorSpace) {
        throw new Error('Canvas renderer color space must match its document');
      }
      unsubscribe?.();
      annotationUnsubscribe?.();
      annotationWatchUnsubscribe?.();
      document = bitmap;
      annotations = null;
      imageData = null;
      pendingDirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      viewportDirty = annotationDirty = overlayDirty = true;
      unsubscribe = bitmap.events.subscribe((rect) => {
        if (!pendingDirty) pendingDirty = { ...rect };
        else unionRect(pendingDirty, rect, pendingDirty);
        viewportDirty = true;
        schedule();
      });
      annotationWatchUnsubscribe = watchAnnotationSet(bitmap, (set) => {
        annotations = set;
        annotationUnsubscribe = set.subscribe(() => {
          annotationDirty = overlayDirty = true;
          schedule();
        });
        annotationDirty = overlayDirty = true;
        schedule();
      });
      schedule();
    },
    setViewport(next) {
      viewport = next;
      viewportDirty = annotationDirty = true;
      if (
        overlay.preview ||
        overlay.sourceClear ||
        overlay.marquee ||
        overlay.cursor ||
        overlay.selectedAnnotationId
      )
        overlayDirty = true;
      schedule();
    },
    setOverlay(next) {
      const a = next.colors?.checkerA ?? '#fff';
      const b = next.colors?.checkerB ?? '#d6d6d6';
      if (a !== checkerA || b !== checkerB) {
        checker = checkerPattern(viewportCtx, a, b);
        overlayChecker = checkerPattern(overlayCtx, a, b);
        checkerA = a;
        checkerB = b;
        viewportDirty = true;
      }
      if (
        next.grid !== overlay.grid ||
        next.colors?.gridMinor !== overlay.colors?.gridMinor ||
        next.colors?.gridMajor !== overlay.colors?.gridMajor ||
        next.colors?.gridMinorLight !== overlay.colors?.gridMinorLight ||
        next.colors?.gridMajorLight !== overlay.colors?.gridMajorLight ||
        next.colors?.edge !== overlay.colors?.edge ||
        next.colors?.shadow !== overlay.colors?.shadow
      )
        viewportDirty = true;
      overlay = next;
      overlayDirty = true;
      if ((!next.marquee || next.reducedMotion || systemReducedMotion) && timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
    },
    invalidateOverlay() {
      overlayDirty = true;
      schedule();
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      annotationUnsubscribe?.();
      annotationWatchUnsubscribe?.();
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    },
  };
}
