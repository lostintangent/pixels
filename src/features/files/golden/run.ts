import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type {
  GoldenApi,
  GoldenColorSpace,
  GoldenResult,
  GoldenScaledResult,
} from './goldenFixture';

/**
 * Byte-identical golden proof for shape export: a document with a partial-alpha rectangle and
 * arrow, over opaque noise, a half-transparent band, and fully transparent pixels, is flattened
 * two different ways in a real browser and compared pixel-for-pixel —
 *  - directly, on the main thread, against a DOM `<canvas>` (`flattenAnnotations` called inline)
 *  - through the real `exportPng` path, where the PNG Worker flattens the same shapes onto an
 *    `OffscreenCanvas`, encodes to PNG, and the bytes are decoded back to pixels
 * Any divergence between the two canvas backends' rasterizers, or any color-space/alpha drift
 * introduced by the PNG round trip, shows up as a non-zero `firstMismatchIndex`. Gated in both
 * sRGB and Display P3, since the flatten step reads the document's own color space.
 *
 * Byte-identical alone doesn't prove flatten actually ran — a no-op that returned its input
 * unchanged is also byte-identical to itself. So each case also flattens the same shapes over a
 * blank buffer to get their exact footprint, then asserts every pixel *outside* that footprint is
 * the untouched source byte, and that a real majority of pixels *inside* it actually changed.
 */

const headed = !process.argv.includes('--headless');
const output = resolve(import.meta.dirname, '../../../../dist-golden-export');

/** A no-op flatten would change 0% of its footprint; real source-over compositing against this
 *  fixture's partial-alpha shapes changes nearly all of it. 50% leaves room for the handful of
 *  low-alpha anti-aliased edge pixels that can round-trip back to the same byte by coincidence,
 *  while still failing hard on an accidental identity return. */
const MIN_CHANGED_FRACTION = 0.5;

/** A scaled export that regressed back to flattening shapes at document resolution and
 *  nearest-neighbor replicating the result would differ from the "blocky" baseline in exactly 0
 *  pixels. Real anti-aliased stroke edges, rasterized natively at the output scale, differ from a
 *  block-replicated 1x composite in a comfortably large number of pixels — 0.1% of the image is
 *  already generous headroom below what two thin shape outlines actually produce at scale ≥ 4. */
const MIN_DIFFERS_FROM_BLOCKY_FRACTION = 0.001;

/** A banded paint and a truly monolithic paint of the same shapes can still differ very slightly
 *  even on the identical (software) rasterizer — a stroke rasterized inside a band smaller than
 *  the whole output doesn't necessarily hit the exact same anti-aliasing rounding as the same
 *  stroke rasterized inside one giant canvas. Measured at up to 23/255 premultiplied (0.03–0.10%
 *  of pixels), spread evenly across rows rather than clustered at band boundaries — ordinary
 *  cross-paint AA rounding, not a seam. This stays at 1.5× that measurement, the same margin this
 *  project's performance budgets use over an observed maximum: tight enough to fail hard on an
 *  actual banding seam or dropped shape (which shows up as a premultiplied delta up to 255 on
 *  every pixel it touches), loose enough to absorb this specific, bounded rounding. */
const MAX_SEAM_PREMULTIPLIED_DELTA = 35;

declare global {
  interface Window {
    __pixelsGolden?: GoldenApi;
  }
}

async function buildFixture(): Promise<void> {
  const build = Bun.spawn(['bunx', 'vp', 'build', 'perf/golden'], {
    cwd: resolve(import.meta.dirname, '../../../..'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await build.exited) !== 0) throw new Error('Golden export fixture build failed');
}

/** Checks correctness only: byte-identical output, nothing touched outside the shapes'
 *  footprint, and a meaningful fraction of the footprint actually changed. No time budget here —
 *  callers that care about timing print `result.ms` themselves. */
function reportCorrectness(colorSpace: GoldenColorSpace, result: GoldenResult): boolean {
  const label = `${colorSpace} ${result.width}×${result.height}`;
  if (!result.matches) {
    console.log(
      `FAIL PNG export golden ${label}: first mismatch at pixel ${result.firstMismatchIndex} (reference 0x${result.referencePixel.toString(16)}, decoded 0x${result.decodedPixel.toString(16)})`,
    );
    return false;
  }
  if (result.outsideFootprintMismatchIndex !== -1) {
    console.log(
      `FAIL PNG export golden ${label}: pixel ${result.outsideFootprintMismatchIndex} outside the shapes' footprint changed from its source byte`,
    );
    return false;
  }
  if (result.footprintCount === 0) {
    console.log(`FAIL PNG export golden ${label}: shapes painted no footprint at all`);
    return false;
  }
  const changedFraction = result.changedCount / result.footprintCount;
  if (changedFraction < MIN_CHANGED_FRACTION) {
    console.log(
      `FAIL PNG export golden ${label}: only ${result.changedCount}/${result.footprintCount} footprint pixels changed (${(changedFraction * 100).toFixed(1)}%, need ≥ ${(MIN_CHANGED_FRACTION * 100).toFixed(0)}%) — looks like flatten silently no-opped`,
    );
    return false;
  }
  console.log(
    `PASS PNG export golden ${label}: ${result.pixelCount} pixels byte-identical, ${result.changedCount}/${result.footprintCount} footprint pixels changed (${(changedFraction * 100).toFixed(1)}%), none outside it`,
  );
  return true;
}

/** Checks a scaled export's shapes are rasterized natively at the output scale: byte-identical to
 *  a shape painted directly at that scale (not document resolution) by the same banding
 *  algorithm, meaningfully different from the old document-resolution-then-nearest-neighbor-
 *  replicate bug, and within `MAX_SEAM_PREMULTIPLIED_DELTA` of a truly monolithic, unbanded paint
 *  of the same shapes — which is what actually catches a bug in banding itself (a dropped shape
 *  or a shifted band boundary would move the first, banded-vs-banded check in lockstep and still
 *  pass it). No time budget here — callers that care about timing print `result.ms` themselves. */
function reportScaledCorrectness(
  colorSpace: GoldenColorSpace,
  result: GoldenScaledResult,
): boolean {
  const label = `${colorSpace} ${result.width}×${result.height} (${result.scale}×)`;
  const pixelCount = result.width * result.height;
  if (!result.matches) {
    console.log(
      `FAIL PNG scaled export golden ${label}: first mismatch at pixel ${result.firstMismatchIndex} (reference 0x${result.referencePixel.toString(16)}, decoded 0x${result.decodedPixel.toString(16)}), ${result.mismatchCount}/${pixelCount} pixels differ, max channel delta ${result.maxChannelDelta}`,
    );
    return false;
  }
  const differsFraction = result.differsFromBlockyCount / pixelCount;
  if (differsFraction < MIN_DIFFERS_FROM_BLOCKY_FRACTION) {
    console.log(
      `FAIL PNG scaled export golden ${label}: only ${result.differsFromBlockyCount}/${pixelCount} pixels (${(differsFraction * 100).toFixed(3)}%) differ from the old blocky-upscale bug — shapes may not be rasterizing at the output scale`,
    );
    return false;
  }
  if (result.seamMaxPremultipliedDelta > MAX_SEAM_PREMULTIPLIED_DELTA) {
    const seamFraction = result.seamMismatchCount / pixelCount;
    console.log(
      `FAIL PNG scaled export golden ${label}: ${result.seamMismatchCount}/${pixelCount} pixels (${(seamFraction * 100).toFixed(3)}%) differ from a monolithic unbanded paint, max premultiplied delta ${result.seamMaxPremultipliedDelta} (limit ${MAX_SEAM_PREMULTIPLIED_DELTA}) — looks like a banding seam, not AA rounding`,
    );
    return false;
  }
  const seamFraction = result.seamMismatchCount / pixelCount;
  console.log(
    `PASS PNG scaled export golden ${label}: byte-identical to a scale-native reference, ${result.differsFromBlockyCount}/${pixelCount} pixels (${(differsFraction * 100).toFixed(3)}%) differ from the old blocky-upscale bug, ${result.seamMismatchCount}/${pixelCount} pixels (${(seamFraction * 100).toFixed(3)}%) differ from a monolithic unbanded paint (max premultiplied delta ${result.seamMaxPremultipliedDelta})`,
  );
  return true;
}

await buildFixture();
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const filename = resolve(output, `.${path === '/' ? '/index.html' : path}`);
    if (!filename.startsWith(`${output}/`)) return new Response('Not found', { status: 404 });
    const file = Bun.file(filename);
    return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
  },
});
const browser = await chromium.launch({ headless: !headed });
try {
  console.log(
    `Pixels export golden: Chromium ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}`,
  );

  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__pixelsGolden));
  if (headed) await page.bringToFront();

  let failed = false;

  const cases: Array<{ side: number; colorSpace: GoldenColorSpace }> = [
    { side: 256, colorSpace: 'srgb' },
    { side: 256, colorSpace: 'display-p3' },
  ];
  for (const { side, colorSpace } of cases) {
    const result = await page.evaluate(
      ({ side, colorSpace }) => window.__pixelsGolden!.render(side, colorSpace),
      { side, colorSpace },
    );
    if (errors.length) throw errors[0];
    if (!reportCorrectness(colorSpace, result)) failed = true;
  }

  // 4096² (the largest a document can be): same correctness gate as the small cases, plus a hard
  // long-task budget, since this is the one size where copying a ~64 MB buffer and rasterizing
  // shapes across it onto an OffscreenCanvas could plausibly become a long main-thread task. Time
  // itself is diagnostic only — printed, not gated — matching `perf:export`'s convention for this
  // size.
  {
    const side = 4096;
    const colorSpace: GoldenColorSpace = 'srgb';
    const result = await page.evaluate(
      ({ side, colorSpace }) => window.__pixelsGolden!.render(side, colorSpace),
      { side, colorSpace },
    );
    if (errors.length) throw errors[0];
    const correct = reportCorrectness(colorSpace, result);
    const longTaskOk = result.longTaskMaxMs <= 50;
    if (!correct || !longTaskOk) failed = true;
    console.log(
      `${longTaskOk ? 'PASS' : 'FAIL'} PNG export golden 4096×4096 diagnostic: ${result.ms.toFixed(3)} ms (no time budget), longest main-thread task ${result.longTaskMaxMs.toFixed(3)} ms (target ≤ 50 ms)`,
    );
  }

  // Scaled export with shapes: proves shapes rasterize crisp at the output scale instead of
  // being flattened at document resolution and blurrily upscaled. Small, fast sizes at a few
  // representative scales, in both color spaces.
  const scaledCases: Array<{ side: number; colorSpace: GoldenColorSpace; scale: number }> = [
    { side: 32, colorSpace: 'srgb', scale: 8 },
    { side: 64, colorSpace: 'srgb', scale: 4 },
    { side: 64, colorSpace: 'display-p3', scale: 4 },
    { side: 128, colorSpace: 'srgb', scale: 16 },
  ];
  for (const { side, colorSpace, scale } of scaledCases) {
    const result = await page.evaluate(
      ({ side, colorSpace, scale }) => window.__pixelsGolden!.renderScaled(side, colorSpace, scale),
      { side, colorSpace, scale },
    );
    if (errors.length) throw errors[0];
    if (!reportScaledCorrectness(colorSpace, result)) failed = true;
  }

  // The worst case the dialog's Scale control allows: a 1024² sheet exported at 16×, giving a
  // 16384×16384 output — larger than `decodePng`'s `MAX_DOCUMENT_SIDE` guard, so it can't round
  // trip through the full `renderScaled` correctness check. Pixel correctness at scale 16 is
  // already proven above (128² at 16× decodes fine at 2048×2048) since the banding algorithm
  // doesn't change with total output size, only the number of bands. This stays a timing-only
  // diagnostic with the same long-task budget as the plain 4096² diagnostic — the shape-
  // rasterization work happens entirely inside the PNG Worker, never the main thread, so main-
  // thread time here is dominated by deflating raw RGBA, not by shape rendering.
  {
    const side = 1024;
    const colorSpace: GoldenColorSpace = 'srgb';
    const scale = 16;
    const result = await page.evaluate(
      ({ side, colorSpace, scale }) =>
        window.__pixelsGolden!.timeScaledExport(side, colorSpace, scale),
      { side, colorSpace, scale },
    );
    if (errors.length) throw errors[0];
    const longTaskOk = result.longTaskMaxMs <= 50;
    if (!longTaskOk) failed = true;
    console.log(
      `${longTaskOk ? 'PASS' : 'FAIL'} PNG scaled export golden 1024×1024 at 16× diagnostic: ${result.width}×${result.height} output, ${(result.byteLength / 1e6).toFixed(1)} MB, ${result.ms.toFixed(3)} ms (no time budget), longest main-thread task ${result.longTaskMaxMs.toFixed(3)} ms (target ≤ 50 ms)`,
    );
  }

  await context.close();
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
