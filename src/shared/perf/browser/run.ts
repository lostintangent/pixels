import { mkdtemp, rm } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { runAppPerf } from './app';
import { captureTrace } from './capture';
import type { TraceSummary } from './trace';

const repeatIndex = process.argv.indexOf('--repeat');
const repeat = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new RangeError('--repeat must be 1 to 20');
const headlessGpu = process.argv.includes('--headless-gpu');
const headed = !process.argv.includes('--headless') && !headlessGpu;
const calibrate = process.argv.includes('--calibrate');

interface BrowserPerfApi {
  reset(kind: 'blank' | 'maze' | 'large'): Promise<void>;
  runStroke(): Promise<void>;
  runPanZoom(): Promise<void>;
  runMazeFill(): Promise<void>;
  runLargePan(): Promise<void>;
  checkZoomOutQuality(): Promise<Record<string, number>>;
  checkP3Canvas(): Promise<boolean>;
  checkColorConversion(): number;
}
declare global {
  interface Window {
    __pixelsPerf?: BrowserPerfApi;
  }
}
type Scenario = 'stroke' | 'pan' | 'maze' | 'large-pan';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function buildFixture(output: string): Promise<void> {
  const process = Bun.spawn(
    ['bunx', 'vp', 'build', 'perf/browser', '--outDir', output, '--emptyOutDir'],
    {
      cwd: resolve(import.meta.dirname, '../../../..'),
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if ((await process.exited) !== 0) throw new Error('Production browser fixture build failed');
}

async function traceScenario(
  context: BrowserContext,
  page: Page,
  scenario: Scenario,
): Promise<TraceSummary> {
  await page.evaluate(
    (kind: 'blank' | 'maze' | 'large') => window.__pixelsPerf!.reset(kind),
    scenario === 'maze' ? 'maze' : scenario === 'large-pan' ? 'large' : 'blank',
  );
  return captureTrace(context, page, async (markFirstInput) => {
    await markFirstInput();
    await page.evaluate((kind) => {
      const api = window.__pixelsPerf!;
      return kind === 'stroke'
        ? api.runStroke()
        : kind === 'pan'
          ? api.runPanZoom()
          : kind === 'large-pan'
            ? api.runLargePan()
            : api.runMazeFill();
    }, scenario);
  });
}

const output = await mkdtemp(join(tmpdir(), 'pixels-browser-perf-'));
try {
  await buildFixture(output);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const filename = resolve(output, `.${path === '/' ? '/index.html' : path}`);
      if (!filename.startsWith(`${output}/`)) return new Response('Not found', { status: 404 });
      const file = Bun.file(filename);
      return (await file.exists())
        ? new Response(file)
        : new Response('Not found', { status: 404 });
    },
  });
  try {
    const browser = await chromium.launch({
      headless: !headed,
      args: headlessGpu ? ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] : [],
    });
    try {
      const profiles = [
        {
          name: 'desktop',
          width: 1440,
          height: 900,
          dpr: 2,
          scenarios: ['stroke', 'pan', 'maze', 'large-pan'],
        },
        {
          name: 'phone',
          width: 390,
          height: 844,
          dpr: 3,
          scenarios: ['stroke', 'pan', 'large-pan'],
        },
      ] as const;
      let failed = false;
      const targets: Record<Scenario, number> = {
        stroke: 4,
        pan: 3,
        maze: Infinity,
        'large-pan': 1.35,
      };
      for (const profile of profiles) {
        const context = await browser.newContext({
          viewport: { width: profile.width, height: profile.height },
          deviceScaleFactor: profile.dpr,
          reducedMotion: 'reduce',
          isMobile: profile.name === 'phone',
          hasTouch: profile.name === 'phone',
        });
        const page = await context.newPage();
        const errors: Error[] = [];
        page.on('pageerror', (error) => errors.push(error));
        await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => Boolean(window.__pixelsPerf));
        if (headed) await page.bringToFront();
        const quality = await page.evaluate(async () => ({
          zoom: await window.__pixelsPerf!.checkZoomOutQuality(),
          p3: await window.__pixelsPerf!.checkP3Canvas(),
          conversionError: window.__pixelsPerf!.checkColorConversion(),
        }));
        console.log(
          `Viewport quality: box-reference MAE ${JSON.stringify(quality.zoom)}, P3 contexts and bytes ${quality.p3 ? 'PASS' : 'FAIL'}, sRGB→P3→sRGB maximum byte error ${quality.conversionError}, targets MAE ≤ 2, P3 exact, conversion error ≤ 2`,
        );
        if (
          !quality.p3 ||
          quality.conversionError > 2 ||
          Object.values(quality.zoom).some((error) => error > 2)
        )
          failed = true;
        const gpuRenderer = await page.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl');
          if (!gl) return 'WebGL unavailable';
          const info = gl.getExtension('WEBGL_debug_renderer_info');
          return info
            ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
            : `unmasked renderer unavailable (${String(gl.getParameter(gl.RENDERER))})`;
        });
        // Let the browser allocate its canvas/GPU resources before tracing. The
        // first paint is a load cost, not an editing-frame cost.
        await page.evaluate(async () => {
          const api = window.__pixelsPerf!;
          await api.reset('blank');
          await api.runStroke();
          await api.reset('blank');
          await api.runPanZoom();
          if (window.innerWidth > 400) {
            await api.reset('maze');
            await api.runMazeFill();
          }
          await api.reset('large');
          await api.reset('blank');
        });
        console.log(
          `Pixels browser perf ${profile.name}: Chromium ${browser.version()}, ${headed ? 'headed user path' : headlessGpu ? 'headless GPU experiment' : 'headless diagnostic'}, WebGL ${gpuRenderer}, ${process.platform}/${process.arch}, ${profile.width}×${profile.height} @ ${profile.dpr}×, document 1024² @ 8×, loadavg ${loadavg()
            .map((value) => value.toFixed(2))
            .join('/')}`,
        );
        console.log(
          'Chrome trace categories: devtools.timeline, devtools.timeline.frame, cc, toplevel; pipeline work includes renderer main, raster workers, compositor, and GPU process.',
        );
        for (let run = 0; run < repeat; run++) {
          console.log(`Run ${run + 1}/${repeat}`);
          for (const scenario of profile.scenarios) {
            const blocks: TraceSummary[] = [];
            for (let block = 0; block < 3; block++)
              blocks.push(await traceScenario(context, page, scenario));
            if (errors.length) throw errors[0];
            const frames = blocks.map((block) => block.frameCount);
            if (scenario !== 'maze' && frames.some((count) => count < 30))
              throw new Error(
                `${scenario} trace captured fewer than 30 frames: ${frames.join(', ')}`,
              );
            const p95 = median(blocks.map((block) => block.mainP95Ms));
            const pipelineP95 = median(blocks.map((block) => block.pipelineP95Ms));
            const maxLongTask = Math.max(...blocks.map((block) => block.maxMainTaskMs));
            const eligible = blocks.reduce((sum, block) => sum + block.eligibleFrames, 0);
            const onTime = blocks.reduce((sum, block) => sum + block.onTimeFrames, 0);
            const dropped = blocks.reduce((sum, block) => sum + block.droppedFrames, 0);
            const highLatency = blocks.reduce((sum, block) => sum + block.highLatencyFrames, 0);
            const consecutiveDrops = blocks.some((block) => block.consecutiveDrops);
            const onTimePercent = (onTime / eligible) * 100;
            const refreshHz = median(blocks.map((block) => block.refreshHz));
            const target =
              scenario === 'large-pan' && profile.name === 'phone' ? 2 : targets[scenario];
            const passed =
              p95 < target &&
              maxLongTask <= 50 &&
              (scenario === 'maze' || (onTimePercent >= 99 && !consecutiveDrops && eligible >= 90));
            if (!passed) failed = true;
            console.log(
              `${passed ? 'PASS' : 'FAIL'} ${scenario}: main p95 ${p95.toFixed(3)} ms [${blocks.map((block) => block.mainP95Ms.toFixed(3)).join(', ')}], aggregate pipeline CPU p95 ${pipelineP95.toFixed(3)} ms [${blocks.map((block) => block.pipelineP95Ms.toFixed(3)).join(', ')}] (diagnostic), max main task ${maxLongTask.toFixed(3)} ms, on-time ${onTime}/${eligible} (${onTimePercent.toFixed(2)}%, dropped ${dropped}, high latency ${highLatency}, consecutive drops ${consecutiveDrops}), refresh ${refreshHz.toFixed(2)} Hz, frames [${frames.join(', ')}], target ${Number.isFinite(target) ? `main < ${target} ms, on-time ≥ 99%` : 'long tasks ≤ 50 ms'}`,
            );
          }
        }
        await context.close();
      }
      if (failed && !calibrate) process.exitCode = 1;
      if (
        !process.argv.includes('--fixture-only') &&
        !(await runAppPerf(browser, repeat, calibrate))
      )
        process.exitCode = 1;
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
