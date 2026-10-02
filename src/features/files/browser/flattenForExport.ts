import type { Annotation } from '../../annotations';
import { flattenAnnotations } from '../../annotations';
import type { DocumentColorSpace } from '../../document';

/**
 * Bakes shapes onto the document's pixels before PNG encoding, so an exported file always matches
 * exactly what the canvas shows. Only ever called from the PNG Worker (`runtime/pngWorker.ts`),
 * where `OffscreenCanvas` is universally available in a real browser — no DOM `document` exists
 * there to fall back to. Throws rather than silently dropping shapes from the exported bytes when
 * it's missing (e.g. under `bun test`) — unlike the ICC conversion's graceful `null` fallback,
 * omitting visible shape content from an export would be data loss, not just reduced fidelity.
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

function createFlattenCanvas(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('Shape flattening requires OffscreenCanvas');
}
