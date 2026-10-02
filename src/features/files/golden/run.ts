import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { GoldenApi, GoldenColorSpace, GoldenResult } from './goldenFixture';

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

  await context.close();
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
