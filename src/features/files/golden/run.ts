import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { GoldenApi, GoldenColorSpace, GoldenResult } from './goldenFixture';

/**
 * Byte-identical golden proof for shape export: a document with a partial-alpha rectangle and
 * arrow is flattened two different ways in a real browser and compared pixel-for-pixel —
 *  - directly, on the main thread, against a DOM `<canvas>` (`flattenAnnotations` called inline)
 *  - through the real `exportPng` path, where the PNG Worker flattens the same shapes onto an
 *    `OffscreenCanvas`, encodes to PNG, and the bytes are decoded back to pixels
 * Any divergence between the two canvas backends' rasterizers, or any color-space/alpha drift
 * introduced by the PNG round trip, shows up as a non-zero `firstMismatchIndex`. Gated in both
 * sRGB and Display P3, since the flatten step reads the document's own color space.
 */

const headed = !process.argv.includes('--headless');
const output = resolve(import.meta.dirname, '../../../../dist-golden-export');

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

function report(colorSpace: GoldenColorSpace, result: GoldenResult): boolean {
  const passed = result.matches;
  console.log(
    passed
      ? `PASS PNG export golden ${colorSpace} ${result.width}×${result.height}: ${result.pixelCount} pixels byte-identical (Worker OffscreenCanvas vs main-thread DOM canvas)`
      : `FAIL PNG export golden ${colorSpace} ${result.width}×${result.height}: first mismatch at pixel ${result.firstMismatchIndex} (reference 0x${result.referencePixel.toString(16)}, decoded 0x${result.decodedPixel.toString(16)})`,
  );
  return passed;
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
    if (!report(colorSpace, result)) failed = true;
  }

  await context.close();
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
