import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { ImportPerfApi, ImportPerfResult } from './importFixture';

/**
 * PNG import (open), end to end, in a real (headed) browser: click, off-main-thread decode via
 * the shared PNG Worker, a live `BitmapDocument`. Gated at the two sizes the lead asked for —
 * 2400×1600 (a real screenshot resolution) and 4096×4096 (the largest a document can be) — on one
 * thing only: no Chromium main-thread task over 50 ms. There's no overall-time budget here (the
 * spec didn't ask for one); total ms is reported as a diagnostic alongside the long-task numbers.
 *  - Cold: the median of 7 first-ever imports, each in its own fresh `browser.newContext()` (its
 *    own HTTP cache, its own Worker) — a single cold sample is one scheduler hiccup away from a
 *    false failure, and the fix is more samples, not a looser budget.
 *  - Warm: 3 discarded warmups, then 30 samples — the core suite's warmed convention, applied to
 *    a click-to-document operation instead of a hot loop.
 */

const headed = !process.argv.includes('--headless');
const output = resolve(import.meta.dirname, '../../../../dist-perf-import');

declare global {
  interface Window {
    __pixelsImportPerf?: ImportPerfApi;
  }
}

async function buildFixture(): Promise<void> {
  const build = Bun.spawn(['bunx', 'vp', 'build', 'perf/import'], {
    cwd: resolve(import.meta.dirname, '../../../..'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await build.exited) !== 0) throw new Error('Import perf fixture build failed');
}

async function runImport(
  page: import('playwright').Page,
  width: number,
  height: number,
): Promise<ImportPerfResult> {
  await page.evaluate(({ width, height }) => window.__pixelsImportPerf!.prepare(width, height), {
    width,
    height,
  });
  const resultPromise = page.evaluate(() => window.__pixelsImportPerf!.waitForClick());
  await page.click('#import');
  return resultPromise;
}

/** Median of a set of samples. `samples` need not be pre-sorted. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The Long Tasks API only ever reports tasks over 50 ms — it has nothing to say about tasks
 *  shorter than that, so a run with no entries means "no main-thread task over 50 ms", not
 *  "the max main-thread task was 0 ms". Prints the real max only when there's a real max to show. */
function longTaskSummary(results: readonly ImportPerfResult[]): { maxMs: number; label: string } {
  const tasks = results.flatMap((result) => result.longTasks);
  if (tasks.length === 0) return { maxMs: 0, label: 'no main-thread task over 50 ms' };
  const maxMs = Math.max(...tasks.map((task) => task.duration));
  return {
    maxMs,
    label: `max main-thread task ${maxMs.toFixed(3)} ms (${tasks.length} long task${tasks.length === 1 ? '' : 's'})`,
  };
}

async function gateSize(
  browser: import('playwright').Browser,
  port: number,
  width: number,
  height: number,
): Promise<boolean> {
  let failed = false;

  // Cold: each sample is the very first import a fresh page ever runs — its own context means
  // its own HTTP cache and its own PNG Worker, exactly like a real user's first open.
  const coldSamples: ImportPerfResult[] = [];
  for (let i = 0; i < 7; i++) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const errors: Error[] = [];
      page.on('pageerror', (error) => errors.push(error));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__pixelsImportPerf));
      if (headed) await page.bringToFront();
      coldSamples.push(await runImport(page, width, height));
      if (errors.length) throw errors[0];
    } finally {
      await context.close();
    }
  }
  {
    const coldMs = coldSamples.map((result) => result.ms);
    const coldMedian = median(coldMs);
    const { maxMs, label } = longTaskSummary(coldSamples);
    const passed = maxMs <= 50;
    if (!passed) failed = true;
    console.log(
      `${passed ? 'PASS' : 'FAIL'} PNG import ${width}×${height} (cold, median of 7, fresh context each): ${coldMedian.toFixed(3)} ms median (min ${Math.min(...coldMs).toFixed(3)}, max ${Math.max(...coldMs).toFixed(3)}) — diagnostic, ${label}, target no task > 50 ms`,
    );
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__pixelsImportPerf));
  if (headed) await page.bringToFront();

  // Warm: 3 discarded warmups, then 30 samples.
  for (let i = 0; i < 3; i++) await runImport(page, width, height);
  const warmSamples: ImportPerfResult[] = [];
  for (let i = 0; i < 30; i++) warmSamples.push(await runImport(page, width, height));
  if (errors.length) throw errors[0];
  {
    const warmMs = warmSamples.map((result) => result.ms);
    const warmMedian = median(warmMs);
    const { maxMs, label } = longTaskSummary(warmSamples);
    const passed = maxMs <= 50;
    if (!passed) failed = true;
    console.log(
      `${passed ? 'PASS' : 'FAIL'} PNG import ${width}×${height} (warm, median of 30 after 3 warmups): ${warmMedian.toFixed(3)} ms median (min ${Math.min(...warmMs).toFixed(3)}, max ${Math.max(...warmMs).toFixed(3)}) — diagnostic, ${label}, target no task > 50 ms`,
    );
  }

  await context.close();
  return failed;
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
    `Pixels import perf: Chromium ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}`,
  );

  let failed = false;
  const port = server.port!;
  if (await gateSize(browser, port, 2400, 1600)) failed = true;
  if (await gateSize(browser, port, 4096, 4096)) failed = true;

  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
