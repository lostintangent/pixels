import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { ExportPerfApi, ExportPerfResult } from './exportFixture';

/**
 * PNG export, end to end, in a real (headed) browser: click, off-main-thread encode via the
 * shared PNG Worker, `Blob`. Two sizes:
 *  - 1024² blocky pixel-art is the actual gate from the spec: under 60 ms, no main-thread task
 *    over 50 ms.
 *  - 4096² (the largest a document can be) is diagnostic only, not gated on total time or on the
 *    long-task budget: it exists to answer one question — does copying a ~64 MB pixel buffer onto
 *    a transferable `ArrayBuffer` before handing it to the Worker become a long task itself? If it
 *    does, that's real information for a follow-up (e.g. chunking the copy), not a regression to
 *    hide by loosening the budget for a size the spec doesn't actually require a number for.
 */

const headed = !process.argv.includes('--headless');
const output = resolve(import.meta.dirname, '../../../../dist-perf-export');

declare global {
  interface Window {
    __pixelsExportPerf?: ExportPerfApi;
  }
}

async function buildFixture(): Promise<void> {
  const build = Bun.spawn(['bunx', 'vp', 'build', 'perf/export'], {
    cwd: resolve(import.meta.dirname, '../../../..'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await build.exited) !== 0) throw new Error('Export perf fixture build failed');
}

async function runExport(page: import('playwright').Page, side: number): Promise<ExportPerfResult> {
  await page.evaluate((size) => window.__pixelsExportPerf!.prepare(size), side);
  const resultPromise = page.evaluate(() => window.__pixelsExportPerf!.waitForClick());
  await page.click('#export');
  return resultPromise;
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__pixelsExportPerf));
  if (headed) await page.bringToFront();

  console.log(
    `Pixels export perf: Chromium ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}`,
  );

  let failed = false;
  const cases: Array<{ side: number; msBudget: number | null; gateLongTasks: boolean }> = [
    { side: 1024, msBudget: 60, gateLongTasks: true },
    { side: 4096, msBudget: null, gateLongTasks: false },
  ];
  // Warm the shared PNG worker (module fetch and instantiation) before any measured run, the same
  // way the other browser gate warms GPU/canvas resources — that startup cost is real, but it is
  // a load cost, not an export cost, and would otherwise inflate the first sample.
  await runExport(page, 256);

  for (const { side, msBudget, gateLongTasks } of cases) {
    const result = await runExport(page, side);
    if (errors.length) throw errors[0];
    const maxLongTask = Math.max(0, ...result.longTasks.map((task) => task.duration));
    const withinTime = msBudget === null || result.ms < msBudget;
    const withinLongTasks = !gateLongTasks || maxLongTask <= 50;
    const passed = withinTime && withinLongTasks;
    if (gateLongTasks && !passed) failed = true;
    console.log(
      `${passed ? 'PASS' : gateLongTasks ? 'FAIL' : 'INFO'} PNG export ${side}×${side}: ${result.ms.toFixed(3)} ms end to end, ${(result.byteLength / 1024).toFixed(1)} KiB, max main-thread task ${maxLongTask.toFixed(3)} ms (${result.longTasks.length} long task${result.longTasks.length === 1 ? '' : 's'})${
        msBudget === null
          ? ' — diagnostic, no time budget'
          : `, target < ${msBudget} ms${gateLongTasks ? ', long tasks ≤ 50 ms' : ''}`
      }`,
    );
  }
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
