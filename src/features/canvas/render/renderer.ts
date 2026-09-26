import type { BitmapDocument, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import type { Viewport } from '../core/contracts';
import type { CanvasRenderer, OverlayPreview, OverlayState, RendererSurface } from './contracts';

const EMPTY_OVERLAY: OverlayState = { grid: 'auto', cursor: null, marquee: null, preview: null };

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D context is unavailable');
  return ctx;
}

function checkerPattern(ctx: CanvasRenderingContext2D, a: string, b: string): CanvasPattern {
  const tile = globalThis.document.createElement('canvas');
  tile.width = tile.height = 16;
  const tileCtx = context(tile);
  tileCtx.fillStyle = a;
  tileCtx.fillRect(0, 0, 16, 16);
  tileCtx.fillStyle = b;
  tileCtx.fillRect(0, 0, 8, 8);
  tileCtx.fillRect(8, 8, 8, 8);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) throw new Error('Checkerboard pattern is unavailable');
  return pattern;
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
  const documentCtx = context(surface.documentCanvas);
  const viewportCtx = context(surface.viewportCanvas);
  const overlayCtx = context(surface.overlayCanvas);
  let checker = checkerPattern(viewportCtx, '#fff', '#d6d6d6');
  let checkerA = '#fff';
  let checkerB = '#d6d6d6';
  const previewCanvas = globalThis.document.createElement('canvas');
  const previewCtx = context(previewCanvas);
  let document: BitmapDocument | null = null;
  let viewport: Viewport | null = null;
  let overlay = EMPTY_OVERLAY;
  let unsubscribe: (() => void) | null = null;
  let imageData: ImageData | null = null;
  let pendingDirty: PixelRect | null = null;
  let viewportDirty = true;
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

  function updateBackingStore(view: Viewport): void {
    const width = Math.max(1, Math.round(view.cssWidth * view.devicePixelRatio));
    const height = Math.max(1, Math.round(view.cssHeight * view.devicePixelRatio));
    for (const canvas of [surface.viewportCanvas, surface.overlayCanvas]) {
      if (canvas.width !== width) {
        canvas.width = width;
        viewportDirty = overlayDirty = true;
      }
      if (canvas.height !== height) {
        canvas.height = height;
        viewportDirty = overlayDirty = true;
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
      imageData = null;
      pendingDirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    }
    if (!imageData || imageData.data.buffer !== bitmap.rgbaBytes.buffer) {
      imageData = new ImageData(
        bitmap.rgbaBytes as Uint8ClampedArray<ArrayBuffer>,
        bitmap.width,
        bitmap.height,
      );
      pendingDirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    }
    if (pendingDirty) {
      documentCtx.putImageData(
        imageData,
        0,
        0,
        pendingDirty.x,
        pendingDirty.y,
        pendingDirty.width,
        pendingDirty.height,
      );
      pendingDirty = null;
    }
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
      previewImage = new ImageData(bytes, stride, rows);
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
    overlayCtx.imageSmoothingEnabled = false;
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
    for (let major = 0; major < 2; major++) {
      ctx.beginPath();
      ctx.strokeStyle = major
        ? (overlay.colors?.gridMajor ?? 'rgba(0,0,0,.32)')
        : (overlay.colors?.gridMinor ?? 'rgba(0,0,0,.12)');
      ctx.lineWidth = 1;
      for (let x = left; x <= right; x++) {
        if ((x % 8 === 0) !== Boolean(major)) continue;
        const screenX = Math.round(view.panX + x * view.zoom) + 0.5;
        ctx.moveTo(screenX, view.panY + top * view.zoom);
        ctx.lineTo(screenX, view.panY + bottom * view.zoom);
      }
      for (let y = top; y <= bottom; y++) {
        if ((y % 8 === 0) !== Boolean(major)) continue;
        const screenY = Math.round(view.panY + y * view.zoom) + 0.5;
        ctx.moveTo(view.panX + left * view.zoom, screenY);
        ctx.lineTo(view.panX + right * view.zoom, screenY);
      }
      ctx.stroke();
    }
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
      viewportCtx.imageSmoothingEnabled = false;
      viewportCtx.drawImage(
        surface.documentCanvas,
        view.panX,
        view.panY,
        bitmap.width * view.zoom,
        bitmap.height * view.zoom,
      );
      viewportCtx.restore();
      drawGrid(viewportCtx, bitmap, view);
      viewportDirty = false;
    }
    if (!overlayDirty) return;
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, surface.overlayCanvas.width, surface.overlayCanvas.height);
    overlayCtx.setTransform(view.devicePixelRatio, 0, 0, view.devicePixelRatio, 0, 0);
    if (overlay.preview) drawPreview(view, overlay.preview);
    if (overlay.marquee) drawTwoToneRect(overlayCtx, overlay.marquee, view, phase);
    if (overlay.cursor) drawTwoToneRect(overlayCtx, overlay.cursor, view, phase);
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
      unsubscribe?.();
      document = bitmap;
      imageData = null;
      pendingDirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      viewportDirty = overlayDirty = true;
      unsubscribe = bitmap.events.subscribe((rect) => {
        if (!pendingDirty) pendingDirty = { ...rect };
        else unionRect(pendingDirty, rect, pendingDirty);
        viewportDirty = true;
        schedule();
      });
      schedule();
    },
    setViewport(next) {
      viewport = next;
      viewportDirty = true;
      if (overlay.preview || overlay.marquee || overlay.cursor) overlayDirty = true;
      schedule();
    },
    setOverlay(next) {
      const a = next.colors?.checkerA ?? '#fff';
      const b = next.colors?.checkerB ?? '#d6d6d6';
      if (a !== checkerA || b !== checkerB) {
        checker = checkerPattern(viewportCtx, a, b);
        checkerA = a;
        checkerB = b;
        viewportDirty = true;
      }
      if (
        next.grid !== overlay.grid ||
        next.colors?.gridMinor !== overlay.colors?.gridMinor ||
        next.colors?.gridMajor !== overlay.colors?.gridMajor
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
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    },
  };
}
