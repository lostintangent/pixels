/// <reference lib="webworker" />
import { paintAnnotation } from '../../../annotations';
import type { Annotation } from '../../../annotations';
import type { DocumentColorSpace } from '../../../document';

export interface PreviewRequest {
  id: number;
  width: number;
  height: number;
  colorSpace: DocumentColorSpace;
  rgba: ArrayBuffer;
  shapes: readonly Annotation[];
  /** Device pixels to fill. Never larger than the document, which upscales with CSS instead. */
  target: { width: number; height: number };
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
 * Draws the export at document resolution, shapes included, then halves it until one last
 * resample reaches the target. Each half is an exact 2×2 average, so fine detail such as
 * one-pixel stripes settles to its true tone instead of aliasing.
 */
self.onmessage = ({ data }: MessageEvent<PreviewRequest>) => {
  const { width, height, colorSpace, target } = data;
  let { canvas, ctx } = surface(width, height, colorSpace);
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(data.rgba), width, height, { colorSpace }),
    0,
    0,
  );
  for (const shape of data.shapes) paintAnnotation(ctx, shape, colorSpace);

  while (canvas.width >= target.width * 2 && canvas.height >= target.height * 2) {
    const next = surface(Math.ceil(canvas.width / 2), Math.ceil(canvas.height / 2), colorSpace);
    next.ctx.drawImage(canvas, 0, 0, next.canvas.width, next.canvas.height);
    ({ canvas, ctx } = next);
  }
  if (canvas.width !== target.width || canvas.height !== target.height) {
    const last = surface(target.width, target.height, colorSpace);
    last.ctx.drawImage(canvas, 0, 0, target.width, target.height);
    canvas = last.canvas;
  }
  const image = canvas.transferToImageBitmap();
  self.postMessage({ id: data.id, image } satisfies PreviewResponse, [image]);
};
