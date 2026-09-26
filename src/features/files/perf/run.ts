import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { ExportPerfApi, ExportPerfResult } from './exportFixture';

/**
 * PNG export, end to end, in a real (headed) browser: click, off-main-thread encode via the
 * shared PNG Worker, `Blob`. All at 1024² blocky pixel-art, the actual gate from the spec: under
 * 60 ms, no main-thread task over 50 ms.
 *  - Cold: the median of 7 first-ever exports, each in its own fresh `browser.newContext()` (its
 *    own HTTP cache, its own Worker), gated on the median with min/max printed — a single cold
 *    sample is one scheduler hiccup away from a false failure, and the fix is more samples, not a
 *    looser budget.
 *  - Warm: 3 discarded warmups, then the p95 of 30 samples, gated on p95 — the steady-state case,
 *    matching the core suite's warmed-p95 convention.
 * 4096² (the largest a document can be) is diagnostic only, not gated on total time or on the
 * long-task budget: it exists to answer one question — does copying a ~64 MB pixel buffer onto a
 * transferable `ArrayBuffer` before handing it to the Worker become a long task itself? If it
 * does, that's real information for a follow-up (e.g. chunking the copy), not a regression to hide
 * by loosening the budget for a size the spec doesn't actually require a number for.
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

/** p95 of a set of samples, nearest-rank. `samples` need not be pre-sorted. */
function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** Median of a set of samples. `samples` need not be pre-sorted. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The Long Tasks API only ever reports tasks over 50 ms — it has nothing to say about tasks
 *  shorter than that, so a run with no entries means "no main-thread task over 50 ms", not
 *  "the max main-thread task was 0 ms". Prints the real max only when there's a real max to show. */
function longTaskSummary(results: readonly ExportPerfResult[]): { maxMs: number; label: string } {
  const tasks = results.flatMap((result) => result.longTasks);
  if (tasks.length === 0) return { maxMs: 0, label: 'no main-thread task over 50 ms' };
  const maxMs = Math.max(...tasks.map((task) => task.duration));
  return {
    maxMs,
    label: `max main-thread task ${maxMs.toFixed(3)} ms (${tasks.length} long task${tasks.length === 1 ? '' : 's'})`,
  };
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
    `Pixels export perf: Chromium ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}`,
  );

  let failed = false;

  // Cold: each sample is the very first export a fresh page ever runs — its own context means
  // its own HTTP cache and its own PNG Worker, so module fetch and instantiation cost is included
  // every time, exactly like a real user's first export. Gated on the median of 7 rather than one
  // sample, since a single cold run is vulnerable to an unrelated scheduler hiccup.
  const coldSamples: ExportPerfResult[] = [];
  for (let i = 0; i < 7; i++) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const errors: Error[] = [];
      page.on('pageerror', (error) => errors.push(error));
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__pixelsExportPerf));
      if (headed) await page.bringToFront();
      coldSamples.push(await runExport(page, 1024));
      if (errors.length) throw errors[0];
    } finally {
      await context.close();
    }
  }
  {
    const coldMs = coldSamples.map((result) => result.ms);
    const coldMedian = median(coldMs);
    const { maxMs, label } = longTaskSummary(coldSamples);
    const passed = coldMedian < 60 && maxMs <= 50;
    if (!passed) failed = true;
    console.log(
      `${passed ? 'PASS' : 'FAIL'} PNG export 1024×1024 (cold, median of 7, fresh context each): ${coldMedian.toFixed(3)} ms median (min ${Math.min(...coldMs).toFixed(3)}, max ${Math.max(...coldMs).toFixed(3)}), ${(coldSamples[0]!.byteLength / 1024).toFixed(1)} KiB, ${label}, target median < 60 ms`,
    );
  }

  // Warm and the 4096² diagnostic share one long-lived context: they're deliberately measuring
  // the steady state of an already-warm page, not a fresh one.
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

  // Warm: 3 discarded warmups, then p95 of 30 samples — the core suite's own warmed-p95 shape,
  // applied here to a click-to-Blob operation instead of a hot loop.
  for (let i = 0; i < 3; i++) await runExport(page, 1024);
  const warmSamples: ExportPerfResult[] = [];
  for (let i = 0; i < 30; i++) warmSamples.push(await runExport(page, 1024));
  if (errors.length) throw errors[0];
  {
    const warmMs = warmSamples.map((result) => result.ms);
    const p95 = percentile95(warmMs);
    const { maxMs, label } = longTaskSummary(warmSamples);
    const passed = p95 < 60 && maxMs <= 50;
    if (!passed) failed = true;
    console.log(
      `${passed ? 'PASS' : 'FAIL'} PNG export 1024×1024 (warm, p95 of 30 after 3 warmups): ${p95.toFixed(3)} ms p95 (min ${Math.min(...warmMs).toFixed(3)}, max ${Math.max(...warmMs).toFixed(3)}), ${(warmSamples[0]!.byteLength / 1024).toFixed(1)} KiB, ${label}, target p95 < 60 ms`,
    );
  }

  // 4096² (the largest a document can be): diagnostic only, no time or long-task budget. Several
  // samples just for a stable median/range to report, never gated.
  const bigSamples: ExportPerfResult[] = [];
  for (let i = 0; i < 5; i++) bigSamples.push(await runExport(page, 4096));
  if (errors.length) throw errors[0];
  {
    const bigMs = bigSamples.map((result) => result.ms);
    const bigMedian = median(bigMs);
    const { label } = longTaskSummary(bigSamples);
    console.log(
      `INFO PNG export 4096×4096 (median of 5, diagnostic): ${bigMedian.toFixed(3)} ms (min ${Math.min(...bigMs).toFixed(3)}, max ${Math.max(...bigMs).toFixed(3)}), ${(bigSamples[0]!.byteLength / 1024).toFixed(1)} KiB, ${label} — no time budget`,
    );
  }

  await context.close();
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
