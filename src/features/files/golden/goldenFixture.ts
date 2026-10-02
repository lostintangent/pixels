import { flattenAnnotations } from '../../annotations';
import { annotationsFor } from '../../annotations/model';
import { createBitmapDocument, packRgba, type DocumentColorSpace } from '../../document';
import { decodePng } from '../core/png';
import { exportPng } from '../export';

export type GoldenColorSpace = DocumentColorSpace;

export interface GoldenResult {
  width: number;
  height: number;
  /** Byte length of the two pixel buffers below; equal by construction once decoded. */
  pixelCount: number;
  /** True only when every pixel of the Worker-exported, decoded PNG matches the main-thread
   *  reference exactly. */
  matches: boolean;
  /** Index of the first mismatching pixel, or -1 when `matches` is true. */
  firstMismatchIndex: number;
  referencePixel: number;
  decodedPixel: number;
}

/**
 * Renders a document with one rectangle and one partial-alpha arrow two different ways and
 * compares them byte-for-byte:
 *  - Reference: `flattenAnnotations` called directly, on the main thread, against a real DOM
 *    `<canvas>` — deliberately the *other* canvas backend from the one `pngWorker.ts` uses, so a
 *    divergence between `OffscreenCanvas` and a DOM canvas's 2D rasterizer would show up here.
 *  - Actual: `exportPng`'s real production path — the PNG Worker flattens the same shapes onto an
 *    `OffscreenCanvas`, encodes, and the result is decoded back to pixels.
 * Byte-identical output proves the exported file really does match what the canvas shows, in both
 * color spaces, not just that the flatten step ran without throwing.
 */
async function render(side: number, colorSpace: GoldenColorSpace): Promise<GoldenResult> {
  const doc = createBitmapDocument('golden', side, side, 'Golden', colorSpace);
  const margin = Math.max(1, Math.floor(side / 8));
  const mid = Math.floor(side / 2);
  const set = annotationsFor(doc);
  set.commit({
    id: 'rect',
    kind: 'rectangle',
    start: { x: margin, y: margin },
    end: { x: mid, y: mid },
    width: 3,
    color: packRgba(220, 40, 40, 180), // partial alpha: exercises compositing, not just opaque fill
  });
  set.commit({
    id: 'arrow',
    kind: 'arrow',
    start: { x: mid, y: mid },
    end: { x: side - margin, y: side - margin },
    width: 4,
    color: packRgba(30, 120, 220, 140),
  });
  const shapes = set.snapshot();

  const referenceCanvas = window.document.createElement('canvas');
  const reference = flattenAnnotations(
    doc.pixels.slice(),
    side,
    side,
    colorSpace,
    shapes,
    referenceCanvas,
  );

  const exported = await exportPng(doc);
  const decoded = await decodePng(exported);

  let firstMismatchIndex = -1;
  for (let i = 0; i < reference.length; i++) {
    if (reference[i] !== decoded.pixels[i]) {
      firstMismatchIndex = i;
      break;
    }
  }

  return {
    width: side,
    height: side,
    pixelCount: reference.length,
    matches: firstMismatchIndex === -1,
    firstMismatchIndex,
    referencePixel: firstMismatchIndex === -1 ? 0 : reference[firstMismatchIndex]!,
    decodedPixel: firstMismatchIndex === -1 ? 0 : decoded.pixels[firstMismatchIndex]!,
  };
}

export interface GoldenApi {
  render(side: number, colorSpace: GoldenColorSpace): Promise<GoldenResult>;
}

declare global {
  interface Window {
    __pixelsGolden?: GoldenApi;
  }
}
Object.assign(window, { __pixelsGolden: { render } satisfies GoldenApi });
