/// <reference lib="webworker" />
import { paintAnnotation, paintAnnotationsAtScale } from '../../../annotations';
import type { Annotation } from '../../../annotations';
import type { DocumentColorSpace } from '../../../document';

export interface PreviewRequest {
  id: number;
  width: number;
  height: number;
  colorSpace: DocumentColorSpace;
  rgba: ArrayBuffer;
  shapes: readonly Annotation[];
  /** Device pixels to fill. For a shrinking preview this stays at or below the document; for a
   *  `pixelated` (upscaling) preview it's the full zoomed-and-DPR device resolution. */
  target: { width: number; height: number };
  /** True for a whole-number zoom at or above 1×: the base image is scaled up with nearest
   *  neighbor, and shapes are rasterized directly at that same scale, instead of being drawn at
   *  document resolution and blurred by a later resample or by CSS `image-rendering: pixelated`. */
  pixelated: boolean;
}

export interface PreviewResponse {
  id: number;
  image: ImageBitmap;
}

type Context = OffscreenCanvasRenderingContext2D;

function surface(width: number, height: number, colorSpace: DocumentColorSpace) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { colorSpace }) as Context;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/**
 * Upscaling: nearest-neighbor the base image directly to the final device resolution, then paint
 * shapes at that same scale, so their anti-aliased stroke edges stay crisp instead of being
 * rasterized once at document resolution and blurred or stair-stepped by a later upscale —
 * whether that upscale happens here or, worse, via CSS `image-rendering: pixelated`.
 */
function renderPixelated(
  base: OffscreenCanvas,
  width: number,
  colorSpace: DocumentColorSpace,
  target: PreviewRequest['target'],
  shapes: readonly Annotation[],
): OffscreenCanvas {
  const { canvas, ctx } = surface(target.width, target.height, colorSpace);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0, target.width, target.height);
  if (shapes.length) paintAnnotationsAtScale(ctx, shapes, colorSpace, target.width / width);
  return canvas;
}

/**
 * Draws the export at document resolution, shapes included, then halves it until one last
 * resample reaches the target. Each half is an exact 2×2 average, so fine detail such as
 * one-pixel stripes settles to its true tone instead of aliasing.
 */
self.onmessage = ({ data }: MessageEvent<PreviewRequest>) => {
  const { width, height, colorSpace, target, pixelated } = data;
  const base = surface(width, height, colorSpace);
  base.ctx.putImageData(
    new ImageData(new Uint8ClampedArray(data.rgba), width, height, { colorSpace }),
    0,
    0,
  );

  let canvas: OffscreenCanvas;
  if (pixelated) {
    canvas = renderPixelated(base.canvas, width, colorSpace, target, data.shapes);
  } else {
    for (const shape of data.shapes) paintAnnotation(base.ctx, shape, colorSpace);
    ({ canvas } = base);
    while (canvas.width >= target.width * 2 && canvas.height >= target.height * 2) {
      const next = surface(Math.ceil(canvas.width / 2), Math.ceil(canvas.height / 2), colorSpace);
      next.ctx.drawImage(canvas, 0, 0, next.canvas.width, next.canvas.height);
      canvas = next.canvas;
    }
    if (canvas.width !== target.width || canvas.height !== target.height) {
      const last = surface(target.width, target.height, colorSpace);
      last.ctx.drawImage(canvas, 0, 0, target.width, target.height);
      canvas = last.canvas;
    }
  }
  const image = canvas.transferToImageBitmap();
  self.postMessage({ id: data.id, image } satisfies PreviewResponse, [image]);
};
