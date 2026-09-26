import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { ExportPerfApi, ExportPerfResult } from './exportFixture';

/**
 * PNG export, end to end, in a real (headed) browser: click, off-main-thread encode via the
 * shared PNG Worker, `Blob`. All at 1024² blocky pixel-art, the actual gate from the spec: under
 * 60 ms, no main-thread task over 50 ms.
 *  - Cold: the very first export this page ever runs (worker module fetch and instantiation
 *    included), gated the same as a warm run — that's a real user's first export, not overhead to
 *    hide.
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

  // Cold: the very first export this page ever runs — this call is what creates the shared PNG
  // Worker, so its cost (module fetch, instantiation) is included on purpose. A real user's first
  // export pays this too, so it's gated exactly like the warm case rather than reported as a
  // separate, budget-free curiosity.
  const cold = await runExport(page, 1024);
  if (errors.length) throw errors[0];
  {
    const { maxMs, label } = longTaskSummary([cold]);
    const passed = cold.ms < 60 && maxMs <= 50;
    if (!passed) failed = true;
    console.log(
      `${passed ? 'PASS' : 'FAIL'} PNG export 1024×1024 (cold, worker boot included): ${cold.ms.toFixed(3)} ms, ${(cold.byteLength / 1024).toFixed(1)} KiB, ${label}, target < 60 ms`,
    );
  }

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
    const bigMs = bigSamples.map((result) => result.ms).sort((a, b) => a - b);
    const median = bigMs[Math.floor(bigMs.length / 2)]!;
    const { label } = longTaskSummary(bigSamples);
    console.log(
      `INFO PNG export 4096×4096 (median of 5, diagnostic): ${median.toFixed(3)} ms (min ${bigMs[0]!.toFixed(3)}, max ${bigMs[bigMs.length - 1]!.toFixed(3)}), ${(bigSamples[0]!.byteLength / 1024).toFixed(1)} KiB, ${label} — no time budget`,
    );
  }

  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop(true);
}
