import {
  compositeAnnotationLayerInto,
  flattenAnnotations,
  paintAnnotationsAtScale,
  type Annotation,
} from '../../annotations';
import { annotationsFor } from '../../annotations/model';
import {
  createBitmapDocument,
  packRgba,
  type DocumentColorSpace,
  type BitmapDocument,
} from '../../document';
import { decodePng, OVERLAY_BAND_OUTPUT_ROWS } from '../core/png';
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

export interface GoldenScaledResult {
  width: number;
  height: number;
  scale: number;
  /** True only when every pixel of the Worker-exported, decoded PNG matches a shape rasterized
   *  directly at the output scale (the correct, crisp behavior), not document resolution. */
  matches: boolean;
  firstMismatchIndex: number;
  referencePixel: number;
  decodedPixel: number;
  /** How many output pixels differ at all from the scale-native reference, and the largest
   *  single-channel absolute difference among them. With `willReadFrequently: true` forcing both
   *  this reference's and the real export's canvases onto the same (software) rasterizer from
   *  their first paint, these are expected to be 0 — `reportScaledCorrectness` in `run.ts` requires
   *  an exact match, the same as the scale-1 case. Kept as diagnostics so a future divergence
   *  (e.g. a real `OffscreenCanvas` vs. DOM canvas rasterizer difference) reports its size instead
   *  of only a pass/fail bit. */
  mismatchCount: number;
  maxChannelDelta: number;
  /** How many output pixels differ from the old, buggy behavior — flattening shapes once at
   *  document resolution, then nearest-neighbor replicating the whole composite. A regression
   *  back to that bug would still pass the byte-identical check above only if `exportPng` and this
   *  fixture's "blocky" baseline were built the same (wrong) way, so this is an independent signal
   *  that real anti-aliased edges, not solid replicated blocks, are what actually exported. */
  differsFromBlockyCount: number;
  /** How many output pixels differ from a *monolithic* reference — the same shapes painted once
   *  directly onto one canvas sized to the entire output, with no row banding or padding at all.
   *  `mismatchCount`/`matches` above compare against a reference that bands the same way the real
   *  export does, so neither catches a bug in banding itself (e.g. a dropped shape or an
   *  off-by-one band boundary, which would shift both sides identically). This comparison
   *  actually exercises banding as a variable. `seamMaxPremultipliedDelta` is the largest
   *  premultiplied per-channel difference among those mismatches — straight-alpha RGB can differ
   *  hugely at a near-zero-alpha pixel without the composited result differing at all, so a
   *  premultiplied comparison is what distinguishes harmless cross-paint AA rounding from an
   *  actual seam or missing geometry. */
  seamMismatchCount: number;
  seamMaxPremultipliedDelta: number;
  ms: number;
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
 * Builds a document with real content under a rectangle and a partial-alpha arrow, shared by both
 * the scale-1 and scaled golden cases: a rectangle crossing the noise band and into the
 * half-transparent band, and an arrow crossing the half-transparent band into the fully
 * transparent one, so between the two shapes every alpha regime gets composited against.
 */
function buildCase(
  side: number,
  colorSpace: GoldenColorSpace,
): { doc: BitmapDocument; baseline: Uint32Array; shapes: readonly Annotation[] } {
  const doc = createBitmapDocument('golden', side, side, 'Golden', colorSpace);
  fillContent(doc.pixels, side);
  const baseline = doc.pixels.slice();

  const margin = Math.max(1, Math.floor(side / 8));
  const mid = Math.floor(side / 2);
  const set = annotationsFor(doc);
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
  return { doc, baseline, shapes: set.snapshot() };
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
  const { doc, baseline, shapes } = buildCase(side, colorSpace);

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
  renderScaled(
    side: number,
    colorSpace: GoldenColorSpace,
    scale: number,
  ): Promise<GoldenScaledResult>;
  timeScaledExport(
    side: number,
    colorSpace: GoldenColorSpace,
    scale: number,
  ): Promise<GoldenScaledTiming>;
}

/** Nearest-neighbor replicates `source` (side×side) up to `outSide`×`outSide` by plain index math,
 *  with no canvas involved — exactly the kind of exact-integer-replication the real banded
 *  overlay path does for a band's base pixels, and what the fixture's "blocky" baseline needs for
 *  its whole composite. Keeping this canvas-free avoids a `drawImage` upscale's own alpha
 *  premultiply/unpremultiply rounding from leaking into either reference. */
function replicateNearestNeighbor(source: Uint32Array, side: number, scale: number): Uint32Array {
  const outSide = side * scale;
  const out = new Uint32Array(outSide * outSide);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const value = source[y * side + x]!;
      for (let sy = 0; sy < scale; sy++) {
        const rowBase = (y * scale + sy) * outSide;
        for (let sx = 0; sx < scale; sx++) out[rowBase + x * scale + sx] = value;
      }
    }
  }
  return out;
}

/**
 * Proves a scaled export rasterizes shapes directly at the output scale instead of flattening
 * them at document resolution and nearest-neighbor replicating the blurry result:
 *  - Reference: the base image nearest-neighbor replicated by exact index math (no canvas, so no
 *    drawImage-driven alpha rounding), then shapes painted directly at `scale` on a transparent DOM
 *    `<canvas>` via `paintAnnotationsAtScale`, in the same `OVERLAY_BAND_OUTPUT_ROWS`-sized row
 *    bands and composited in place with `compositeAnnotationLayerInto` — the identical two-step,
 *    per-band algorithm `createScaledShapeOverlay` uses, on the "other" canvas backend, so a
 *    divergence between `OffscreenCanvas` and a DOM canvas would show up here exactly as it does
 *    for the scale-1 case.
 *  - Actual: `exportPng`'s real production path at `scale`, decoded back to pixels. Only valid
 *    while `outSide` stays within `decodePng`'s own `MAX_DOCUMENT_SIDE` guard — callers that want a
 *    larger, timing-only case should use `timeScaledExport` instead.
 *  - "Blocky" baseline: this fixture's own emulation of the bug being fixed — flatten the same
 *    shapes once at document resolution (`flattenAnnotations`), then nearest-neighbor replicate
 *    the whole composite, exactly like the old `encodePng` path did before banding existed. A
 *    meaningful number of output pixels must differ from this, proving real anti-aliased edges
 *    were drawn at scale rather than solid blocks copied from a single document pixel.
 *
 * Both the reference above and `createScaledShapeOverlay` band the same way, so neither one alone
 * can catch a bug in banding itself — a dropped shape or an off-by-one band boundary would shift
 * both sides identically and still compare byte-identical. So this also builds a third, truly
 * monolithic reference: the same shapes painted once on one canvas sized to the entire output,
 * with no banding or padding at all. The real export is compared against *that* too, in
 * `seamMismatchCount`/`seamMaxPremultipliedDelta` below, which is what actually exercises banding
 * as a variable between the two paints.
 *
 * Banded and monolithic paints were originally expected to match exactly, since the canvas size,
 * `ctx.translate` use, and color space are otherwise identical between them — but the real
 * `OffscreenCanvas` export was measurably different from a per-band DOM `<canvas>` reference at
 * the thinnest bands (128² at 16×, an 8-document-row band): up to 26,863/4,194,304 pixels
 * (0.641%), confined to anti-aliased shape-edge pixels. That was isolated to Chrome moving an
 * accelerated canvas to its software rasterizer after enough `getImageData` calls on it — so a
 * canvas's *first* few bands, painted before that fallback, read back very slightly different
 * anti-aliased values than its later bands, even with identical geometry, canvas size, and color
 * space on every band. `willReadFrequently: true` (here and in `createScaledShapeOverlay`) forces
 * every band's canvas onto the software rasterizer from its first paint, so every band reads back
 * consistently — confirmed empirically: with it, this reference and the real export are
 * byte-identical even at 128² × 16×, and the 1024² × 16× `timeScaledExport` diagnostic got
 * *faster*, not slower, since Chrome no longer pays for the GPU-to-software transition mid-export.
 *
 * A banded paint and a truly monolithic paint of the same shapes can still differ very slightly —
 * a stroke rasterized inside a band smaller than the whole output doesn't necessarily hit the
 * exact same anti-aliasing rounding as the identical stroke rasterized inside one giant canvas,
 * even on the same (software) rasterizer. Measured at up to 0.10% of pixels with a premultiplied
 * channel delta of up to 23/255, spread evenly across rows rather than clustered at band
 * boundaries — i.e. ordinary cross-paint AA rounding, not a seam. `MAX_SEAM_PREMULTIPLIED_DELTA`
 * in `run.ts` bounds that, loose enough to absorb this rounding but tight enough to fail hard on
 * an actual seam or a dropped shape, which would show up as a much larger delta (up to 255) on
 * every pixel the discontinuity touches.
 */
async function renderScaled(
  side: number,
  colorSpace: GoldenColorSpace,
  scale: number,
): Promise<GoldenScaledResult> {
  const { doc, baseline, shapes } = buildCase(side, colorSpace);
  const outSide = side * scale;

  // Paints shapes through the same per-band canvas granularity, including vertical padding,
  // that `createScaledShapeOverlay` uses — not one canvas spanning the whole output. A stroke
  // rasterized right at a canvas's edge can anti-alias slightly differently than the same stroke
  // painted with its usual surrounding context, so a fair byte-exact comparison needs both sides
  // to band and pad identically.
  const reference = replicateNearestNeighbor(baseline, side, scale);
  const referenceBytes = new Uint8ClampedArray(reference.buffer);
  const docRowsPerBand = Math.max(1, Math.floor(OVERLAY_BAND_OUTPUT_ROWS / scale));
  const bandCanvas = window.document.createElement('canvas');
  for (let y = 0; y < side; y += docRowsPerBand) {
    const bandEnd = Math.min(side, y + docRowsPerBand);
    const bandOutRows = (bandEnd - y) * scale;
    const padDocRows = Math.ceil(Math.max(...shapes.map((shape) => shape.width / 2 + 2)));
    const paddedStartY = Math.max(0, y - padDocRows);
    const paddedEndY = bandEnd + padDocRows;
    const paddedOutRows = (paddedEndY - paddedStartY) * scale;
    bandCanvas.width = outSide;
    bandCanvas.height = paddedOutRows;
    const bandCtx = bandCanvas.getContext('2d', {
      colorSpace,
      willReadFrequently: true,
    }) as CanvasRenderingContext2D;
    paintAnnotationsAtScale(bandCtx, shapes, colorSpace, scale, paddedStartY);
    const bandOffsetRows = (y - paddedStartY) * scale;
    const layer = bandCtx.getImageData(0, bandOffsetRows, outSide, bandOutRows, {
      colorSpace,
    }).data;
    compositeAnnotationLayerInto(
      referenceBytes.subarray(y * scale * outSide * 4, (y * scale + bandOutRows) * outSide * 4),
      layer,
    );
  }

  const flattenCanvas = window.document.createElement('canvas');
  const flattened = flattenAnnotations(
    baseline.slice(),
    side,
    side,
    colorSpace,
    shapes,
    flattenCanvas,
  );
  const blocky = replicateNearestNeighbor(flattened, side, scale);

  // A truly monolithic reference — the same shapes, painted once at `scale` directly onto one
  // canvas sized to the entire output, with no banding or padding at all. Unlike `reference`
  // above, this doesn't band the same way `createScaledShapeOverlay` does, so comparing the real
  // export against it actually exercises banding as a variable (see the doc comment above).
  const monolithicCanvas = window.document.createElement('canvas');
  monolithicCanvas.width = outSide;
  monolithicCanvas.height = outSide;
  const monolithicCtx = monolithicCanvas.getContext('2d', {
    colorSpace,
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  paintAnnotationsAtScale(monolithicCtx, shapes, colorSpace, scale);
  const monolithicLayer = monolithicCtx.getImageData(0, 0, outSide, outSide, { colorSpace }).data;
  const monolithicReference = replicateNearestNeighbor(baseline, side, scale);
  const monolithicReferenceBytes = new Uint8ClampedArray(monolithicReference.buffer);
  compositeAnnotationLayerInto(monolithicReferenceBytes, monolithicLayer);

  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ entryTypes: ['longtask'] });
  const start = performance.now();
  const exported = await exportPng(doc, { scale });
  const decoded = await decodePng(exported);
  const ms = performance.now() - start;
  observer.disconnect();

  let firstMismatchIndex = -1;
  let differsFromBlockyCount = 0;
  let mismatchCount = 0;
  let maxChannelDelta = 0;
  let seamMismatchCount = 0;
  let seamMaxPremultipliedDelta = 0;
  const referenceChannels = new Uint8ClampedArray(reference.buffer);
  const monolithicChannels = new Uint8ClampedArray(monolithicReference.buffer);
  const decodedChannels = new Uint8ClampedArray(decoded.pixels.buffer);
  for (let i = 0; i < reference.length; i++) {
    if (reference[i] !== decoded.pixels[i]) {
      if (firstMismatchIndex === -1) firstMismatchIndex = i;
      mismatchCount++;
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(referenceChannels[i * 4 + c]! - decodedChannels[i * 4 + c]!);
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
    }
    if (blocky[i] !== decoded.pixels[i]) differsFromBlockyCount++;
    if (monolithicReference[i] !== decoded.pixels[i]) {
      seamMismatchCount++;
      // Straight-alpha RGB can differ hugely between two paints at a near-zero-alpha pixel
      // without the composited result looking any different at all — compare premultiplied
      // values instead, so a seam (real geometry missing or shifted) still shows a large delta
      // while harmless straight-alpha noise under near-invisible pixels doesn't.
      const decodedAlpha = decodedChannels[i * 4 + 3]!;
      const monolithicAlpha = monolithicChannels[i * 4 + 3]!;
      for (let c = 0; c < 3; c++) {
        const decodedPremultiplied = (decodedChannels[i * 4 + c]! * decodedAlpha) / 255;
        const monolithicPremultiplied = (monolithicChannels[i * 4 + c]! * monolithicAlpha) / 255;
        const delta = Math.abs(decodedPremultiplied - monolithicPremultiplied);
        if (delta > seamMaxPremultipliedDelta) seamMaxPremultipliedDelta = delta;
      }
      const alphaDelta = Math.abs(decodedAlpha - monolithicAlpha);
      if (alphaDelta > seamMaxPremultipliedDelta) seamMaxPremultipliedDelta = alphaDelta;
    }
  }

  return {
    width: outSide,
    height: outSide,
    scale,
    matches: firstMismatchIndex === -1,
    firstMismatchIndex,
    referencePixel: firstMismatchIndex === -1 ? 0 : reference[firstMismatchIndex]!,
    decodedPixel: firstMismatchIndex === -1 ? 0 : decoded.pixels[firstMismatchIndex]!,
    mismatchCount,
    maxChannelDelta,
    differsFromBlockyCount,
    seamMismatchCount,
    seamMaxPremultipliedDelta,
    ms,
    longTaskMaxMs: longTasks.length ? Math.max(...longTasks) : 0,
  };
}

export interface GoldenScaledTiming {
  width: number;
  height: number;
  scale: number;
  byteLength: number;
  ms: number;
  longTaskMaxMs: number;
}

/**
 * Times a scaled export at sizes too large for `renderScaled` to verify, since the output exceeds
 * `decodePng`'s `MAX_DOCUMENT_SIDE` guard — a deliberate safety invariant (nothing in the app ever
 * needs to hold a document-shaped buffer above that side), not something a test should bypass.
 * Pixel-level correctness for any scale, including this one, is already proven by `renderScaled`
 * at smaller sizes, since the banding algorithm doesn't change with total output size — only the
 * number of bands does. This leaves wall-clock time, plus the same main-thread long-task gate the
 * other diagnostics use, as the properties left to check at the real worst case. A minimal
 * structural check (PNG signature and `IHDR` dimensions) stands in for full decode, proving the
 * export produced a well-formed file of the right size without re-deriving `decodePng`'s guard.
 */
async function timeScaledExport(
  side: number,
  colorSpace: GoldenColorSpace,
  scale: number,
): Promise<GoldenScaledTiming> {
  const { doc } = buildCase(side, colorSpace);
  const outSide = side * scale;

  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ entryTypes: ['longtask'] });
  const start = performance.now();
  const exported = await exportPng(doc, { scale });
  const ms = performance.now() - start;
  observer.disconnect();

  const signatureOk = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => exported[i] === byte);
  const view = new DataView(exported.buffer, exported.byteOffset, exported.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!signatureOk || width !== outSide || height !== outSide) {
    throw new Error(
      `Exported PNG is malformed: signature ok=${signatureOk}, IHDR ${width}×${height}, expected ${outSide}×${outSide}`,
    );
  }

  return {
    width: outSide,
    height: outSide,
    scale,
    byteLength: exported.byteLength,
    ms,
    longTaskMaxMs: longTasks.length ? Math.max(...longTasks) : 0,
  };
}

declare global {
  interface Window {
    __pixelsGolden?: GoldenApi;
  }
}

Object.assign(window, {
  __pixelsGolden: { render, renderScaled, timeScaledExport } satisfies GoldenApi,
});
