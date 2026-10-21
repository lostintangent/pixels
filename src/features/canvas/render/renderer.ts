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

/** Share one origin across layers. A small negative phase avoids Metal's half-pixel ties. */
function pixelAlignedPan(pan: number, devicePixelRatio: number): number {
  const phase = Number.isInteger(devicePixelRatio) ? 0 : -0.125;
  return (Math.round(pan * devicePixelRatio) + phase) / devicePixelRatio;
}

/** First device pixel sampled from this source cell, after the shared origin phase. */
function deviceBoundary(origin: number, cell: number, zoom: number, scale: number): number {
  return Math.ceil(origin + cell * zoom * scale - 0.5);
}

function clipDocumentPixels(
  ctx: CanvasRenderingContext2D,
  bitmap: BitmapDocument,
  view: Viewport,
  panX: number,
  panY: number,
): void {
  const scale = view.devicePixelRatio;
  const left = deviceBoundary(panX * scale, 0, view.zoom, scale);
  const top = deviceBoundary(panY * scale, 0, view.zoom, scale);
  const right = deviceBoundary(panX * scale, bitmap.width, view.zoom, scale);
  const bottom = deviceBoundary(panY * scale, bitmap.height, view.zoom, scale);
  ctx.beginPath();
  ctx.rect(left / scale, top / scale, (right - left) / scale, (bottom - top) / scale);
  ctx.clip();
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
  panX: number,
  panY: number,
  edge: string | undefined,
  shadow: string | undefined,
): void {
  const scale = view.devicePixelRatio;
  const nearest = smoothingForView(view) === 'off';
  const left = nearest
    ? deviceBoundary(panX * scale, 0, view.zoom, scale)
    : Math.floor(panX * scale);
  const top = nearest
    ? deviceBoundary(panY * scale, 0, view.zoom, scale)
    : Math.floor(panY * scale);
  const right = nearest
    ? deviceBoundary(panX * scale, bitmap.width, view.zoom, scale)
    : Math.ceil((panX + bitmap.width * view.zoom) * scale);
  const bottom = nearest
    ? deviceBoundary(panY * scale, bitmap.height, view.zoom, scale)
    : Math.ceil((panY + bitmap.height * view.zoom) * scale);
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
  panX: number,
  panY: number,
  phase: number,
): void {
  const x = panX + rect.x * viewport.zoom;
  const y = panY + rect.y * viewport.zoom;
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
  const transferCanvas = globalThis.document.createElement('canvas');
  const transferCtx = context(transferCanvas, colorSpace);
  const opaquePixel = globalThis.document.createElement('canvas');
  opaquePixel.width = opaquePixel.height = 1;
  const opaquePixelCtx = context(opaquePixel, colorSpace);
  opaquePixelCtx.fillStyle = '#fff';
  opaquePixelCtx.fillRect(0, 0, 1, 1);
  let previewGridCanvas: HTMLCanvasElement | null = null;
  let previewGridCtx: CanvasRenderingContext2D | null = null;
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

  function drawPreview(
    view: Viewport,
    bitmap: BitmapDocument,
    preview: OverlayPreview,
    panX: number,
    panY: number,
  ): void {
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
    // Zoomed-out previews are filtered from mips, so exact source-cell sampling
    // does not apply. Keep their backing store compact even at fractional DPR.
    const useCompact = Number.isInteger(view.devicePixelRatio) || smoothing !== 'off';
    if (useCompact && transferCanvas.width) {
      transferCanvas.width = 0;
      transferCanvas.height = 0;
    }
    if (!useCompact) {
      if (transferCanvas.width !== bitmap.width) transferCanvas.width = bitmap.width;
      if (transferCanvas.height !== bitmap.height) transferCanvas.height = bitmap.height;
      transferCtx.imageSmoothingEnabled = false;
      transferCtx.drawImage(
        previewCanvas,
        preview.bounds.x,
        preview.bounds.y,
        preview.bounds.width,
        preview.bounds.height,
      );
    }
    const gridVisible = overlay.grid === 'on' || (overlay.grid === 'auto' && view.zoom >= 8);
    let destination = overlayCtx;
    let left = 0;
    let top = 0;
    let width = 0;
    let height = 0;
    if (gridVisible && overlay.sourceClear) {
      const scale = view.devicePixelRatio;
      left = Math.max(0, Math.floor((panX + preview.bounds.x * view.zoom) * scale));
      top = Math.max(0, Math.floor((panY + preview.bounds.y * view.zoom) * scale));
      const right = Math.min(
        surface.overlayCanvas.width,
        Math.ceil((panX + (preview.bounds.x + preview.bounds.width) * view.zoom) * scale),
      );
      const bottom = Math.min(
        surface.overlayCanvas.height,
        Math.ceil((panY + (preview.bounds.y + preview.bounds.height) * view.zoom) * scale),
      );
      width = right - left;
      height = bottom - top;
      if (width <= 0 || height <= 0) return;
      if (!previewGridCanvas) {
        previewGridCanvas = globalThis.document.createElement('canvas');
        previewGridCtx = context(previewGridCanvas, colorSpace);
      }
      if (previewGridCanvas.width < width) previewGridCanvas.width = width;
      if (previewGridCanvas.height < height) previewGridCanvas.height = height;
      destination = previewGridCtx!;
      destination.setTransform(1, 0, 0, 1, 0, 0);
      destination.clearRect(0, 0, width, height);
      destination.setTransform(scale, 0, 0, scale, -left, -top);
    }
    destination.imageSmoothingEnabled = smoothing !== 'off';
    if (smoothing !== 'off') destination.imageSmoothingQuality = smoothing;
    if (useCompact)
      destination.drawImage(
        previewCanvas,
        panX + preview.bounds.x * view.zoom,
        panY + preview.bounds.y * view.zoom,
        preview.bounds.width * view.zoom,
        preview.bounds.height * view.zoom,
      );
    else {
      destination.drawImage(
        transferCanvas,
        panX,
        panY,
        bitmap.width * view.zoom,
        bitmap.height * view.zoom,
      );
      transferCtx.clearRect(
        preview.bounds.x,
        preview.bounds.y,
        preview.bounds.width,
        preview.bounds.height,
      );
    }
    if (gridVisible) {
      destination.save();
      // Mask the grid to preview alpha. Transparent line and selection pixels already
      // show the viewport grid, and the cleared source may have its own grid below.
      destination.globalCompositeOperation = 'source-atop';
      drawGrid(
        destination,
        bitmap,
        view,
        panX,
        panY,
        destination === overlayCtx ? 0 : -left,
        destination === overlayCtx ? 0 : -top,
      );
      destination.restore();
      if (destination !== overlayCtx) {
        overlayCtx.save();
        overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
        overlayCtx.imageSmoothingEnabled = false;
        overlayCtx.drawImage(previewGridCanvas!, 0, 0, width, height, left, top, width, height);
        overlayCtx.restore();
      }
    }
  }

  function drawGrid(
    ctx: CanvasRenderingContext2D,
    bitmap: BitmapDocument,
    view: Viewport,
    panX: number,
    panY: number,
    deviceOffsetX = 0,
    deviceOffsetY = 0,
  ): void {
    if (overlay.grid === 'off' || (overlay.grid === 'auto' && view.zoom < 8)) return;
    const left = Math.max(0, Math.floor(-panX / view.zoom));
    const right = Math.min(bitmap.width, Math.ceil((view.cssWidth - panX) / view.zoom));
    const top = Math.max(0, Math.floor(-panY / view.zoom));
    const bottom = Math.min(bitmap.height, Math.ceil((view.cssHeight - panY) / view.zoom));
    if (left > right || top > bottom) return;
    const scale = view.devicePixelRatio;
    const originX = panX * scale;
    const originY = panY * scale;
    const boundaryX = (cell: number) => deviceBoundary(originX, cell, view.zoom, scale);
    const boundaryY = (cell: number) => deviceBoundary(originY, cell, view.zoom, scale);
    const darkWidth = Math.max(1, Math.round(scale));
    ctx.save();
    clipDocumentPixels(ctx, bitmap, view, panX, panY);
    ctx.setTransform(1, 0, 0, 1, deviceOffsetX, deviceOffsetY);
    // Fill whole device pixels. CSS-width strokes land between device pixels at fractional
    // DPR and can blur differently from one image-pixel boundary to the next.
    for (let major = 0; major < 2; major++) {
      for (let light = 0; light < 2; light++) {
        ctx.beginPath();
        ctx.fillStyle = major
          ? light
            ? (overlay.colors?.gridMajorLight ?? 'rgba(255,255,255,.25)')
            : (overlay.colors?.gridMajor ?? 'rgba(0,0,0,.32)')
          : light
            ? (overlay.colors?.gridMinorLight ?? 'rgba(255,255,255,.16)')
            : (overlay.colors?.gridMinor ?? 'rgba(0,0,0,.12)');
        const lineWidth = light ? 1 : darkWidth;
        for (let x = left; x <= right; x++) {
          if ((x % 8 === 0) !== Boolean(major)) continue;
          const deviceX = boundaryX(x) + (light ? darkWidth : 0);
          const startY = boundaryY(top);
          const endY = boundaryY(bottom);
          ctx.rect(deviceX, startY, lineWidth, endY - startY);
        }
        for (let y = top; y <= bottom; y++) {
          if ((y % 8 === 0) !== Boolean(major)) continue;
          const deviceY = boundaryY(y) + (light ? darkWidth : 0);
          const startX = boundaryX(left);
          const endX = boundaryX(right);
          ctx.rect(startX, deviceY, endX - startX, lineWidth);
        }
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawClearedSource(
    view: Viewport,
    bitmap: BitmapDocument,
    source: PixelRect,
    panX: number,
    panY: number,
  ): void {
    overlayCtx.save();
    overlayCtx.imageSmoothingEnabled = Number.isInteger(view.devicePixelRatio);
    overlayCtx.fillStyle = overlayChecker;
    overlayCtx.fillRect(0, 0, view.cssWidth, view.cssHeight);
    overlayCtx.globalCompositeOperation = 'source-atop';
    drawGrid(overlayCtx, bitmap, view, panX, panY);
    // Mask the checker and grid with the source pixel footprint. A CSS-space
    // clip would soften fractional edges that the bitmap covers fully.
    overlayCtx.globalCompositeOperation = 'destination-in';
    overlayCtx.imageSmoothingEnabled = false;
    if (Number.isInteger(view.devicePixelRatio) || smoothingForView(view) !== 'off')
      overlayCtx.drawImage(
        opaquePixel,
        panX + source.x * view.zoom,
        panY + source.y * view.zoom,
        source.width * view.zoom,
        source.height * view.zoom,
      );
    else {
      if (transferCanvas.width !== bitmap.width) transferCanvas.width = bitmap.width;
      if (transferCanvas.height !== bitmap.height) transferCanvas.height = bitmap.height;
      transferCtx.fillStyle = '#fff';
      transferCtx.fillRect(source.x, source.y, source.width, source.height);
      overlayCtx.drawImage(
        transferCanvas,
        panX,
        panY,
        bitmap.width * view.zoom,
        bitmap.height * view.zoom,
      );
      transferCtx.clearRect(source.x, source.y, source.width, source.height);
    }
    overlayCtx.restore();
  }

  function render(): void {
    frame = 0;
    if (!document || !viewport || disposed) return;
    const bitmap = document;
    const view = viewport;
    const panX = pixelAlignedPan(view.panX, view.devicePixelRatio);
    const panY = pixelAlignedPan(view.panY, view.devicePixelRatio);
    updateBackingStore(view);
    if (viewportDirty) {
      updateDocumentCanvas(bitmap);
      const pixelWidth = surface.viewportCanvas.width;
      const pixelHeight = surface.viewportCanvas.height;
      viewportCtx.setTransform(1, 0, 0, 1, 0, 0);
      viewportCtx.clearRect(0, 0, pixelWidth, pixelHeight);
      viewportCtx.setTransform(view.devicePixelRatio, 0, 0, view.devicePixelRatio, 0, 0);
      viewportCtx.save();
      const smoothing = smoothingForView(view);
      if (smoothing === 'off') clipDocumentPixels(viewportCtx, bitmap, view, panX, panY);
      else {
        viewportCtx.beginPath();
        viewportCtx.rect(panX, panY, bitmap.width * view.zoom, bitmap.height * view.zoom);
        viewportCtx.clip();
      }
      viewportCtx.imageSmoothingEnabled = Number.isInteger(view.devicePixelRatio);
      viewportCtx.fillStyle = checker;
      viewportCtx.fillRect(0, 0, view.cssWidth, view.cssHeight);
      viewportCtx.imageSmoothingEnabled = smoothing !== 'off';
      if (smoothing !== 'off') viewportCtx.imageSmoothingQuality = smoothing;
      viewportCtx.drawImage(
        sourceForZoom(view),
        panX,
        panY,
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
          panX,
          panY,
          colors.edge,
          colors.shadow,
        );
      viewportCtx.save();
      viewportCtx.globalCompositeOperation = 'source-atop';
      drawGrid(viewportCtx, bitmap, view, panX, panY);
      viewportCtx.restore();
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
          annotationCtx.rect(panX, panY, bitmap.width * view.zoom, bitmap.height * view.zoom);
          annotationCtx.clip();
          annotationCtx.translate(panX, panY);
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
    if (overlay.sourceClear) drawClearedSource(view, bitmap, overlay.sourceClear, panX, panY);
    if (overlay.preview) drawPreview(view, bitmap, overlay.preview, panX, panY);
    if (overlay.marquee) drawTwoToneRect(overlayCtx, overlay.marquee, view, panX, panY, phase);
    if (overlay.cursor) drawTwoToneRect(overlayCtx, overlay.cursor, view, panX, panY, phase);
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
            panX,
            panY,
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
      if (!next.preview && !next.sourceClear && transferCanvas.width) {
        transferCanvas.width = 0;
        transferCanvas.height = 0;
      }
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
      transferCanvas.width = 0;
      transferCanvas.height = 0;
    },
  };
}
