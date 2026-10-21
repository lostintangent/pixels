import { mkdtemp, rm } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { runAppPerf } from './app';
import { captureTrace } from './capture';
import { withConditionedCpu } from './conditioning';
import type { TraceSummary } from './trace';

const repeatIndex = process.argv.indexOf('--repeat');
const repeat = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new RangeError('--repeat must be 1 to 20');
const headlessGpu = process.argv.includes('--headless-gpu');
const headed = !process.argv.includes('--headless') && !headlessGpu;
const calibrate = process.argv.includes('--calibrate');
const studioDiagnostic = process.argv.includes('--studio-diagnostic');
const conditionCpu = !process.argv.includes('--unconditioned');
const previewDprIndex = process.argv.indexOf('--preview-dpr');
const previewDpr = previewDprIndex < 0 ? 3 : Number(process.argv[previewDprIndex + 1]);
const previewZoomIndex = process.argv.indexOf('--preview-zoom');
const previewZoom = previewZoomIndex < 0 ? 0.0625 : Number(process.argv[previewZoomIndex + 1]);
if (!(previewDpr > 0) || !(previewZoom > 0))
  throw new RangeError('--preview-dpr and --preview-zoom must be positive');
const injectIndex = process.argv.indexOf('--inject-large-pan-ms');
const injectLargePanMs = injectIndex < 0 ? 0 : Number(process.argv[injectIndex + 1]);
if (!Number.isFinite(injectLargePanMs) || injectLargePanMs < 0 || injectLargePanMs > 20)
  throw new RangeError('--inject-large-pan-ms must be 0 to 20');

interface BrowserPerfApi {
  reset(kind: 'blank' | 'maze' | 'large'): Promise<void>;
  runStroke(): Promise<void>;
  runPanZoom(): Promise<void>;
  runMazeFill(): Promise<void>;
  runLargePan(injectMs?: number): Promise<void>;
  runLargePreview(zoom?: number): Promise<void>;
  prepareShapeDrag(): Promise<void>;
  runShapeHandleDrag(): Promise<void>;
  checkZoomOutQuality(): Promise<Record<string, number>>;
  checkP3Canvas(): Promise<boolean>;
  checkColorConversion(): number;
  checkAnnotationLayer(): Promise<{
    passed: boolean;
    primary: number[];
    outside: number[];
    handle: number[];
  }>;
  checkPreviewGrid(panX?: number, panY?: number): Promise<Record<string, number>>;
  checkDocumentCorner(): Promise<number[]>;
  checkGridAlignment(
    zoom: number,
    panX: number,
    panY: number,
  ): Promise<
    Record<
      string,
      { profiles: number; offsets: number[]; bitmapOffsets: number[]; example: number[] }
    >
  >;
  checkSettledPixelRuns(): Promise<Record<string, { expected: number; x: number[]; y: number[] }>>;
}
declare global {
  interface Window {
    __pixelsPerf?: BrowserPerfApi;
  }
}
type Scenario = 'stroke' | 'pan' | 'maze' | 'large-pan' | 'shape-handle';

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
  const kind: 'blank' | 'maze' | 'large' =
    scenario === 'maze'
      ? 'maze'
      : scenario === 'large-pan' || scenario === 'shape-handle'
        ? 'large'
        : 'blank';
  await page.evaluate((kind: 'blank' | 'maze' | 'large') => window.__pixelsPerf!.reset(kind), kind);
  if (scenario === 'shape-handle')
    await page.evaluate(() => window.__pixelsPerf!.prepareShapeDrag());
  return captureTrace(context, page, async (markFirstInput) => {
    await markFirstInput();
    await page.evaluate(
      ({ kind, injectMs }) => {
        const api = window.__pixelsPerf!;
        return kind === 'stroke'
          ? api.runStroke()
          : kind === 'pan'
            ? api.runPanZoom()
            : kind === 'large-pan'
              ? api.runLargePan(injectMs)
              : kind === 'shape-handle'
                ? api.runShapeHandleDrag()
                : api.runMazeFill();
      },
      { kind: scenario, injectMs: injectLargePanMs },
    );
  });
}

async function checkGridMatrix(browser: Browser, url: string): Promise<boolean> {
  let passed = true;
  for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.2, 2.625, 3]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: dpr,
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__pixelsPerf));
      const result = await page.evaluate(async () => {
        const api = window.__pixelsPerf!;
        return {
          fit: await api.checkGridAlignment(
            window.devicePixelRatio === 1.5 ? 37 : window.devicePixelRatio === 1.25 ? 10 : 22,
            19,
            27,
          ),
          anchored: await api.checkGridAlignment(15.73, 31.37, 17.61),
          previewZoom: await api.checkGridAlignment(10, 31.37, 17.61),
          preview: await api.checkPreviewGrid(31.37, 17.61),
          wholePanPreview: await api.checkPreviewGrid(),
          corner: await api.checkDocumentCorner(),
          settled: await api.checkSettledPixelRuns(),
        };
      });
      const checks = [result.fit, result.anchored, result.previewZoom];
      const gridPass = checks.every((check) =>
        Object.values(check).every(
          (line) => line.profiles === 1 && line.offsets.length === 1 && line.offsets[0] === 0,
        ),
      );
      const previewMax = Math.max(
        ...Object.values(result.preview),
        ...Object.values(result.wholePanPreview),
      );
      const lineSummary = (check: typeof result.fit) =>
        Object.entries(check)
          .map(
            ([name, line]) =>
              `${name}:${line.profiles}/${line.offsets.join(',')}[bitmap ${line.bitmapOffsets.join(',')}]`,
          )
          .join(' ');
      const cornerPass = result.corner.join(',') === '100,50,200,255';
      const settledPass = Object.values(result.settled).every(
        ({ expected, x, y }) =>
          x.length === 14 &&
          y.length === 14 &&
          x.every((length) => length === expected) &&
          y.every((length) => length === expected),
      );
      const profilePassed =
        gridPass && previewMax === 0 && cornerPass && settledPass && errors.length === 0;
      const settledSummary = Object.entries(result.settled)
        .map(
          ([name, { expected, x, y }]) =>
            `${name}:${expected}px x[${[...new Set(x)].join(',')}] y[${[...new Set(y)].join(',')}]`,
        )
        .join(' ');
      console.log(
        `Grid DPR ${dpr}: fit ${lineSummary(result.fit)}; anchored ${lineSummary(result.anchored)}; 10× ${lineSummary(result.previewZoom)}; preview ${JSON.stringify(result.preview)}; whole-pan preview ${JSON.stringify(result.wholePanPreview)}; corner ${result.corner.join(',')}; settled ${settledPass ? settledSummary : JSON.stringify(result.settled)}; ${profilePassed ? 'PASS' : 'FAIL'}`,
      );
      if (errors.length) console.error(`Grid page errors at DPR ${dpr}: ${errors.join('; ')}`);
      if (!profilePassed) passed = false;
    } finally {
      await context.close();
    }
  }
  return passed;
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
      if (process.argv.includes('--grid-only')) {
        if (!(await checkGridMatrix(browser, `http://127.0.0.1:${server.port}/`)))
          process.exitCode = 1;
      } else if (process.argv.includes('--large-preview-diagnostic')) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: previewDpr,
          isMobile: true,
          hasTouch: true,
        });
        try {
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
          await page.waitForFunction(() => Boolean(window.__pixelsPerf));
          const blocks: TraceSummary[] = [];
          for (let block = 0; block < 3; block++) {
            await page.evaluate(() => window.__pixelsPerf!.reset('large'));
            blocks.push(
              await captureTrace(context, page, async (markFirstInput) => {
                await markFirstInput();
                await page.evaluate(
                  (zoom) => window.__pixelsPerf!.runLargePreview(zoom),
                  previewZoom,
                );
              }),
            );
          }
          const maxTask = Math.max(...blocks.map((b) => b.maxMainTaskMs));
          const compact = Number.isInteger(previewDpr) || previewZoom * previewDpr < 1;
          console.log(
            `${maxTask <= 50 ? 'PASS' : 'FAIL'} 4096² phone ${previewDpr}× at ${previewZoom}× line preview: main p95 ${median(blocks.map((b) => b.mainP95Ms)).toFixed(3)} ms [${blocks.map((b) => b.mainP95Ms.toFixed(3)).join(', ')}], pipeline p95 ${median(blocks.map((b) => b.pipelineP95Ms)).toFixed(3)} ms [${blocks.map((b) => b.pipelineP95Ms.toFixed(3)).join(', ')}], max main task including first preview ${maxTask.toFixed(3)} ms (limit 50), frames ${blocks.map((b) => b.frameCount).join(',')}, ${compact ? 'compact source, no document-sized transfer' : '64 MiB document-sized transfer while active'}`,
          );
          if (maxTask > 50) process.exitCode = 1;
        } finally {
          await context.close();
        }
      } else {
        const profiles: readonly {
          name: 'desktop' | 'phone' | 'studio';
          width: number;
          height: number;
          dpr: number;
          scenarios: readonly Scenario[];
        }[] = studioDiagnostic
          ? [{ name: 'studio', width: 2560, height: 1440, dpr: 2, scenarios: ['stroke', 'pan'] }]
          : [
              {
                name: 'desktop',
                width: 1440,
                height: 900,
                dpr: 2,
                scenarios: ['stroke', 'pan', 'maze', 'large-pan', 'shape-handle'],
              },
              {
                name: 'phone',
                width: 390,
                height: 844,
                dpr: 3,
                scenarios: ['stroke', 'pan', 'large-pan', 'shape-handle'],
              },
            ];
        let failed = false;
        const targets: Record<Exclude<Scenario, 'maze'>, { desktop: number; phone: number }> = {
          stroke: { desktop: 0.59, phone: 0.51 },
          pan: { desktop: 0.44, phone: 0.44 },
          'large-pan': { desktop: 0.46, phone: 0.46 },
          'shape-handle': { desktop: 0.45, phone: 0.41 },
        };
        const runProfiles = async () => {
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
              annotations: await window.__pixelsPerf!.checkAnnotationLayer(),
              previewGrid: await window.__pixelsPerf!.checkPreviewGrid(),
            }));
            console.log(
              `Viewport quality: box-reference MAE ${JSON.stringify(quality.zoom)}, P3 contexts and bytes ${quality.p3 ? 'PASS' : 'FAIL'}, P3 annotation layer ${quality.annotations.passed ? 'PASS' : `FAIL ${JSON.stringify(quality.annotations)}`}, preview vs commit maximum byte error ${JSON.stringify(quality.previewGrid)}, sRGB→P3→sRGB maximum byte error ${quality.conversionError}, targets MAE ≤ 2, P3 exact, preview ≤ 1 byte, conversion error ≤ 2`,
            );
            if (
              !quality.p3 ||
              !quality.annotations.passed ||
              quality.conversionError > 2 ||
              Object.values(quality.previewGrid).some((error) => error > 1) ||
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
              await api.prepareShapeDrag();
              await api.runShapeHandleDrag();
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
                  scenario === 'maze' || profile.name === 'studio'
                    ? Infinity
                    : targets[scenario][profile.name];
                const passed =
                  p95 < target &&
                  maxLongTask <= 50 &&
                  (scenario === 'maze' ||
                    (onTimePercent >= 99 && !consecutiveDrops && eligible >= 90));
                if (!passed && !studioDiagnostic) failed = true;
                console.log(
                  `${studioDiagnostic ? 'DIAG' : passed ? 'PASS' : 'FAIL'} ${scenario}: main p95 ${p95.toFixed(3)} ms [${blocks.map((block) => block.mainP95Ms.toFixed(3)).join(', ')}], aggregate pipeline CPU p95 ${pipelineP95.toFixed(3)} ms [${blocks.map((block) => block.pipelineP95Ms.toFixed(3)).join(', ')}] (diagnostic), max main task ${maxLongTask.toFixed(3)} ms, on-time ${onTime}/${eligible} (${onTimePercent.toFixed(2)}%, dropped ${dropped}, high latency ${highLatency}, consecutive drops ${consecutiveDrops}), refresh ${refreshHz.toFixed(2)} Hz, frames [${frames.join(', ')}], target ${studioDiagnostic ? 'diagnostic only' : Number.isFinite(target) ? `main < ${target} ms, on-time ≥ 99%` : 'long tasks ≤ 50 ms'}`,
                );
              }
            }
            await context.close();
          }
        };
        if (conditionCpu) await withConditionedCpu('renderer fixture', runProfiles);
        else {
          console.log('CPU conditioning: disabled for diagnostic renderer run');
          await runProfiles();
        }
        if (
          !studioDiagnostic &&
          !(await checkGridMatrix(browser, `http://127.0.0.1:${server.port}/`))
        )
          failed = true;
        if (failed && !calibrate) process.exitCode = 1;
        if (
          !studioDiagnostic &&
          !process.argv.includes('--fixture-only') &&
          !(await runAppPerf(browser, repeat, calibrate, 0, conditionCpu))
        )
          process.exitCode = 1;
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
