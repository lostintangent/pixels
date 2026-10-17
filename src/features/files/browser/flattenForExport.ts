import type { Annotation } from '../../annotations';
import {
  compositeAnnotationLayerInto,
  flattenAnnotations,
  paintAnnotationsAtScale,
  verticalExtentOf,
} from '../../annotations';
import type { DocumentColorSpace } from '../../document';
import type { ScaledRowOverlay } from '../core/png';

/**
 * Bakes shapes onto the document's pixels before PNG encoding, at document resolution. Used only
 * for a 1× export, where document resolution *is* the output resolution, so this stays the exact,
 * unchanged path a 1× export always took. A scaled export uses `createScaledShapeOverlay` instead
 * — flattening at document resolution first and upscaling the result afterward is exactly the bug
 * this file now also fixes: a shape's anti-aliased stroke edges, rasterized once at 1×, come out
 * blocky after nearest-neighbor replication instead of crisp at the real output resolution.
 *
 * Only ever called from the PNG Worker (`runtime/pngWorker.ts`), where `OffscreenCanvas` is
 * universally available in a real browser — no DOM `document` exists there to fall back to.
 * Throws rather than silently dropping shapes from the exported bytes when it's missing (e.g.
 * under `bun test`) — unlike the ICC conversion's graceful `null` fallback, omitting visible shape
 * content from an export would be data loss, not just reduced fidelity.
 */
export function flattenShapesForExport(
  pixels: Uint32Array,
  width: number,
  height: number,
  colorSpace: DocumentColorSpace,
  shapes: readonly Annotation[],
): Uint32Array {
  if (!shapes.length) return pixels;
  return flattenAnnotations(
    pixels,
    width,
    height,
    colorSpace,
    shapes,
    createFlattenCanvas(width, height),
  );
}

/**
 * Builds a `ScaledRowOverlay` that paints shapes directly at the export's output scale, inside
 * whatever bounded row band `core/png.ts`'s streaming encoder asks for, instead of document
 * resolution. One `OffscreenCanvas` is reused across bands (resized only when a band's size
 * actually changes, e.g. a shorter final band), so repeated calls don't thrash allocations.
 */
export function createScaledShapeOverlay(
  shapes: readonly Annotation[],
  colorSpace: DocumentColorSpace,
  scale: number,
): ScaledRowOverlay {
  const extents = shapes.map(verticalExtentOf);
  const touching = (startY: number, endY: number): Annotation[] =>
    shapes.filter((_, index) => {
      const extent = extents[index]!;
      return extent.maxY > startY && extent.minY < endY;
    });
  let canvas: OffscreenCanvas | undefined;
  return {
    hasContent: (startY, endY) =>
      extents.some((extent) => extent.maxY > startY && extent.minY < endY),
    compositeInto(band, startY, endY, outWidth) {
      const shapesHere = touching(startY, endY);
      if (!shapesHere.length) return;
      const bandOutRows = (endY - startY) * scale;
      // Pad the canvas a few document rows above and below the band before painting, then keep
      // only the band's own rows. Without this, a shape whose stroke extends right up to (or
      // just past) the band's edge was missing real context the rasterizer would otherwise see.
      // The padding matches `verticalExtentOf`'s own margin (half the widest touching stroke plus
      // 2px of anti-aliasing slack), so the canvas always has at least that much real stroke
      // geometry on both sides of the band it's keeping.
      const padDocRows = Math.ceil(Math.max(...shapesHere.map((shape) => shape.width / 2 + 2)));
      const paddedStartY = Math.max(0, startY - padDocRows);
      const paddedEndY = endY + padDocRows;
      const paddedOutRows = (paddedEndY - paddedStartY) * scale;
      canvas ??= createFlattenCanvas(outWidth, paddedOutRows);
      if (canvas.width !== outWidth || canvas.height !== paddedOutRows) {
        canvas.width = outWidth;
        canvas.height = paddedOutRows;
      }
      // `willReadFrequently` keeps this canvas on the CPU rasterizer for its whole lifetime.
      // Without it, Chrome paints the first few bands on the GPU, then silently falls back to
      // software after enough `getImageData` calls — so a band read right at that fallback point
      // reads back very slightly different anti-aliased pixel values than the bands around it,
      // even though nothing about the painted geometry changed. Forcing software rasterization
      // up front makes every band's readback consistent with every other, and was also faster
      // for this file's heaviest case (see `golden/run.ts` for the measured timing).
      const ctx = canvas.getContext('2d', {
        colorSpace,
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      ctx.clearRect(0, 0, outWidth, paddedOutRows);
      paintAnnotationsAtScale(ctx, shapesHere, colorSpace, scale, paddedStartY);
      const bandOffsetRows = (startY - paddedStartY) * scale;
      const layer = ctx.getImageData(0, bandOffsetRows, outWidth, bandOutRows, { colorSpace }).data;
      compositeAnnotationLayerInto(band, layer);
    },
  };
}

function createFlattenCanvas(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('Shape flattening requires OffscreenCanvas');
}
