import { flattenAnnotations } from '../../annotations';
import { annotationsFor } from '../../annotations/model';
import { createBitmapDocument, packRgba, type DocumentColorSpace } from '../../document';
import { decodePng } from '../core/png';
import { exportPng } from '../export';

export type GoldenColorSpace = DocumentColorSpace;

export interface GoldenResult {
  width: number;
  height: number;
  pixelCount: number;
  /** True only when every pixel of the Worker-exported, decoded PNG matches the main-thread
   *  reference exactly. */
  matches: boolean;
  /** Index of the first mismatching pixel, or -1 when `matches` is true. */
  firstMismatchIndex: number;
  referencePixel: number;
  decodedPixel: number;
  /** Pixels the shape layer actually painted (alpha > 0 when flattened over a blank buffer). */
  footprintCount: number;
  /** Of those footprint pixels, how many differ from the un-annotated source bytes. A flatten
   *  that silently returned its input unchanged would paint a footprint but change nothing — this
   *  catches that even though `matches` alone would not. */
  changedCount: number;
  /** Index of a pixel *outside* the shape footprint whose exported value differs from the source
   *  bytes, or -1 when none do. Proves flatten never touches pixels a shape doesn't cover. */
  outsideFootprintMismatchIndex: number;
  /** Wall-clock time for `exportPng` + `decodePng`, for the 4096² diagnostic. Not gated at every
   *  size — printed so a regression is visible, same convention as `perf:export`'s diagnostic. */
  ms: number;
  /** Longest Long Tasks API entry observed during export + decode, 0 when none were reported. */
  longTaskMaxMs: number;
}

/** Deterministic per-pixel hash, so "opaque noise" is reproducible without `Math.random`. */
function noiseByte(x: number, y: number, shift: number): number {
  const h = (x * 374761393 + y * 668265263) >>> 0;
  return (h >>> shift) & 0xff;
}

/** Fills three horizontal bands so the shapes drawn on top cross real content, not a blank
 *  canvas: opaque per-pixel noise, a half-transparent solid band, and fully transparent pixels.
 *  Exercises source-over compositing against all three alpha regimes a real screenshot could have
 *  (an opaque photo, a semi-transparent UI layer, and the empty margin PNG itself can have). */
function fillContent(pixels: Uint32Array, side: number): void {
  const third = Math.max(1, Math.floor(side / 3));
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const index = y * side + x;
      if (y < third) {
        pixels[index] = packRgba(noiseByte(x, y, 0), noiseByte(x, y, 8), noiseByte(x, y, 16), 255);
      } else if (y < third * 2) {
        pixels[index] = packRgba(40, 180, 90, 128);
      } else {
        pixels[index] = packRgba(0, 0, 0, 0);
      }
    }
  }
}

/**
 * Renders a document with real content under a rectangle and a partial-alpha arrow two different
 * ways and compares them byte-for-byte:
 *  - Reference: `flattenAnnotations` called directly, on the main thread, against a real DOM
 *    `<canvas>` — deliberately the *other* canvas backend from the one `pngWorker.ts` uses, so a
 *    divergence between `OffscreenCanvas` and a DOM canvas's 2D rasterizer would show up here.
 *  - Actual: `exportPng`'s real production path — the PNG Worker flattens the same shapes onto an
 *    `OffscreenCanvas`, encodes, and the result is decoded back to pixels.
 * Byte-identical output alone isn't enough: a flatten that silently no-ops would also be
 * byte-identical to its input, just wrong. So this also flattens the same shapes over a blank
 * buffer to get their exact footprint, and asserts untouched pixels are the unmodified source
 * bytes while footprint pixels actually changed by a meaningful amount.
 */
async function render(side: number, colorSpace: GoldenColorSpace): Promise<GoldenResult> {
  const doc = createBitmapDocument('golden', side, side, 'Golden', colorSpace);
  fillContent(doc.pixels, side);
  const baseline = doc.pixels.slice();

  const margin = Math.max(1, Math.floor(side / 8));
  const mid = Math.floor(side / 2);
  const set = annotationsFor(doc);
  // Rectangle crosses the noise band and into the half-transparent band; arrow crosses the
  // half-transparent band and into the fully transparent one — between the two shapes, every band
  // gets composited against.
  set.commit({
    id: 'rect',
    kind: 'rectangle',
    start: { x: margin, y: margin },
    end: { x: side - margin, y: mid },
    width: 3,
    color: packRgba(220, 40, 40, 180),
  });
  set.commit({
    id: 'arrow',
    kind: 'arrow',
    start: { x: margin, y: mid },
    end: { x: side - margin, y: side - margin },
    width: 4,
    color: packRgba(30, 120, 220, 140),
  });
  const shapes = set.snapshot();

  const referenceCanvas = window.document.createElement('canvas');
  const reference = flattenAnnotations(
    baseline.slice(),
    side,
    side,
    colorSpace,
    shapes,
    referenceCanvas,
  );

  const footprintCanvas = window.document.createElement('canvas');
  const footprintLayer = flattenAnnotations(
    new Uint32Array(side * side),
    side,
    side,
    colorSpace,
    shapes,
    footprintCanvas,
  );

  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ entryTypes: ['longtask'] });
  const start = performance.now();
  const exported = await exportPng(doc);
  const decoded = await decodePng(exported);
  const ms = performance.now() - start;
  observer.disconnect();

  let firstMismatchIndex = -1;
  let outsideFootprintMismatchIndex = -1;
  let footprintCount = 0;
  let changedCount = 0;
  for (let i = 0; i < reference.length; i++) {
    if (firstMismatchIndex === -1 && reference[i] !== decoded.pixels[i]) firstMismatchIndex = i;
    const inFootprint = footprintLayer[i]! >>> 24 !== 0;
    if (inFootprint) {
      footprintCount++;
      if (baseline[i] !== decoded.pixels[i]) changedCount++;
    } else if (outsideFootprintMismatchIndex === -1 && baseline[i] !== decoded.pixels[i]) {
      outsideFootprintMismatchIndex = i;
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
    footprintCount,
    changedCount,
    outsideFootprintMismatchIndex,
    ms,
    longTaskMaxMs: longTasks.length ? Math.max(...longTasks) : 0,
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
