import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Browser, Page } from 'playwright';
import { withProductionPreview } from '../../preview';
import { runEditorInput } from './editor';

const loadBudgetMs = 500;
const initialJsBudgetKiB = 170;
const initialCssBudgetKiB = 40;

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function gzipAssets(output: string, paths: string[]): Promise<number> {
  let bytes = 0;
  for (const path of new Set(paths)) {
    const filename = resolve(output, path);
    if (
      !filename.startsWith(`${output}/`) ||
      (!filename.endsWith('.js') && !filename.endsWith('.css'))
    )
      throw new Error(`Unexpected initial asset path: ${path}`);
    bytes += gzipSync(await Bun.file(filename).arrayBuffer(), { level: 9 }).byteLength;
  }
  return bytes;
}

interface ManifestChunk {
  file: string;
  imports?: string[];
  css?: string[];
  isEntry?: boolean;
}

async function initialAssets(output: string): Promise<{ js: string[]; css: string[] }> {
  const manifest = (await Bun.file(resolve(output, '.vite/manifest.json')).json()) as Record<
    string,
    ManifestChunk
  >;
  const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  if (!entryKey) throw new Error('Production manifest has no entry chunk');
  const visited = new Set<string>();
  const js = new Set<string>();
  const css = new Set<string>();
  function visit(key: string): void {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing static import in production manifest: ${key}`);
    js.add(chunk.file);
    for (const path of chunk.css ?? []) css.add(path);
    for (const imported of chunk.imports ?? []) visit(imported);
  }
  visit(entryKey);
  return { js: [...js], css: [...css] };
}

interface LoadResult {
  ms: number;
  js: string[];
  transferBytes: number;
}

/** Navigation starts the clock. The first real pointer stroke must alter the viewport bitmap. */
async function loadAndStroke(page: Page, url: string): Promise<LoadResult> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => {
    const host = document.querySelector<HTMLElement>('[role="application"][aria-label="Canvas"]');
    const canvas = host?.querySelector('canvas');
    const rect = host?.getBoundingClientRect();
    return (
      canvas &&
      rect &&
      canvas.width === Math.round(rect.width * devicePixelRatio) &&
      canvas.height === Math.round(rect.height * devicePixelRatio)
    );
  });
  const host = page.getByRole('application', { name: 'Canvas' });
  const box = await host.boundingBox();
  if (!box) throw new Error('Canvas has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const clip = { x: Math.floor(x) - 2, y: Math.floor(y) - 2, width: 5, height: 5 };
  const before = await page.screenshot({ clip, animations: 'disabled', scale: 'device' });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(0, 0);
  const deadline = Date.now() + 2_000;
  while (true) {
    const after = await page.screenshot({ clip, animations: 'disabled', scale: 'device' });
    if (!after.equals(before)) break;
    if (Date.now() >= deadline)
      throw new Error('First pointer stroke did not change displayed pixels');
    await Bun.sleep(16);
  }
  // This timestamp is an upper bound that includes compositor capture latency.
  const strokeAt = await page.evaluate(() => performance.now());
  if (errors.length) throw new Error(`App load error: ${errors.join(', ')}`);
  return page.evaluate((ms) => {
    const resources = performance
      .getEntriesByType('resource')
      .filter((entry) =>
        new URL(entry.name).pathname.endsWith('.js'),
      ) as PerformanceResourceTiming[];
    return {
      ms,
      js: resources.map((entry) => new URL(entry.name).pathname),
      transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
    };
  }, strokeAt);
}

export async function runAppPerf(
  browser: Browser,
  repeat: number,
  calibrate: boolean,
): Promise<boolean> {
  let failed = false;
  return withProductionPreview({ manifest: true }, async ({ output, port, baseUrl }) => {
    // The server's first navigation can include one-time file and route setup.
    const warmup = await browser.newContext();
    try {
      const page = await warmup.newPage();
      await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
    } finally {
      await warmup.close();
    }
    const assets = await initialAssets(output);
    const initialJsKiB = (await gzipAssets(output, assets.js)) / 1024;
    const initialCssKiB = (await gzipAssets(output, assets.css)) / 1024;
    for (let run = 0; run < repeat; run++) {
      const coldBlocks: number[] = [];
      const warmBlocks: number[] = [];
      const paths = new Set<string>();
      let coldTransferBytes = 0;
      let warmTransferBytes = 0;
      for (let block = 0; block < 3; block++) {
        const coldSamples: number[] = [];
        const warmSamples: number[] = [];
        for (let sample = 0; sample < 3; sample++) {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 2,
            reducedMotion: 'reduce',
          });
          for (const cache of ['cold', 'warm'] as const) {
            const page = await context.newPage();
            const result = await loadAndStroke(
              page,
              `http://127.0.0.1:${port}/d/load-${run}-${block}-${sample}-${cache}`,
            );
            (cache === 'cold' ? coldSamples : warmSamples).push(result.ms);
            if (cache === 'cold') coldTransferBytes += result.transferBytes;
            else warmTransferBytes += result.transferBytes;
            for (const path of result.js) paths.add(path);
            await page.close();
          }
          await context.close();
        }
        coldBlocks.push(p95(coldSamples));
        warmBlocks.push(p95(warmSamples));
      }
      const coldP95 = median(coldBlocks);
      const warmP95 = median(warmBlocks);
      const passed =
        coldP95 < loadBudgetMs &&
        warmP95 < loadBudgetMs &&
        initialJsKiB <= initialJsBudgetKiB &&
        initialCssKiB <= initialCssBudgetKiB;
      if (!passed) failed = true;
      console.log(
        `${passed ? 'PASS' : 'FAIL'} real editor load ${run + 1}/${repeat}: cold first stroke p95 ${coldP95.toFixed(1)} ms [${coldBlocks.map((value) => value.toFixed(1)).join(', ')}], warm ${warmP95.toFixed(1)} ms [${warmBlocks.map((value) => value.toFixed(1)).join(', ')}], initial JS ${initialJsKiB.toFixed(1)} KiB gzip (${assets.js.length} static file(s)), CSS ${initialCssKiB.toFixed(1)} KiB gzip, ${paths.size} JS file(s) fetched by stroke, JS transfer cold ${(coldTransferBytes / 9 / 1024).toFixed(1)} KiB / warm ${(warmTransferBytes / 9 / 1024).toFixed(1)} KiB, targets p95 < ${loadBudgetMs} ms, JS ≤ ${initialJsBudgetKiB} KiB, CSS ≤ ${initialCssBudgetKiB} KiB, loadavg ${loadavg()
          .map((value) => value.toFixed(2))
          .join('/')}`,
      );
    }
    if (!(await runEditorInput(browser, baseUrl, repeat, calibrate))) failed = true;
    return !failed || calibrate;
  });
}
