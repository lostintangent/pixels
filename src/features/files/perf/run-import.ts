import { mkdtemp, rm } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { packRgba } from '../../document';
import { decodePng, encodePng } from '../core/png';
import { withProductionPreview } from '../../../shared/preview';

type Profile = 'desktop' | 'phone';
type CaseName = 'photo-2400' | 'photo-3456' | 'photo-4096' | 'p3' | 'shapes';
interface Task {
  start: number;
  duration: number;
}
interface Loaf extends Task {
  blocking: number;
  render: number;
  scripts: { duration: number; invoker: string; fn: string; source: string; position: number }[];
}
interface Metrics {
  tasks: Task[];
  loafs: Loaf[];
}
interface ImportResult {
  passed: boolean;
  renderMs: number;
}
declare global {
  interface Window {
    __pixelsImportGate?: {
      reset(): void;
      snapshot(): Metrics;
      stored(id: string): Promise<{ updatedAt: number; shapes: number }>;
    };
  }
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const repeat = Number(option('--repeat') ?? 3);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)
  throw new RangeError('--repeat must be 1 to 10');
const onlyCase = option('--case') as CaseName | undefined;
if (onlyCase && !['photo-2400', 'photo-3456', 'photo-4096', 'p3', 'shapes'].includes(onlyCase))
  throw new RangeError(`Unknown --case ${onlyCase}`);
const onlyProfile = option('--profile') as Profile | undefined;
if (onlyProfile && onlyProfile !== 'desktop' && onlyProfile !== 'phone')
  throw new RangeError('--profile must be desktop or phone');
const injectOpenMs = Number(option('--inject-open-ms') ?? 0);
if (!Number.isFinite(injectOpenMs) || injectOpenMs < 0 || injectOpenMs > 100)
  throw new RangeError('--inject-open-ms must be between 0 and 100');
const headed = !args.includes('--headless');
const firstRenderLimits: Partial<Record<CaseName, number>> = {
  'photo-3456': 500,
  'photo-4096': 1000,
  p3: 250,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Run on every document, before startup scripts, so reload includes its first browser tasks. */
function observe(): void {
  const tasks: Task[] = [];
  const loafs: Loaf[] = [];
  let dbPromise: Promise<IDBDatabase> | undefined;
  const taskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      tasks.push({ start: entry.startTime, duration: entry.duration });
  });
  taskObserver.observe({ type: 'longtask', buffered: true });
  const loafObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const frame = entry as PerformanceEntry & {
        blockingDuration: number;
        renderStart: number;
        scripts: {
          duration: number;
          invoker: string;
          sourceURL: string;
          sourceFunctionName: string;
          sourceCharPosition: number;
        }[];
      };
      loafs.push({
        start: frame.startTime,
        duration: frame.duration,
        blocking: frame.blockingDuration,
        render: frame.renderStart ? frame.startTime + frame.duration - frame.renderStart : 0,
        scripts: frame.scripts
          .filter((script) => script.duration > 5)
          .map((script) => ({
            duration: script.duration,
            invoker: script.invoker,
            fn: script.sourceFunctionName,
            source: script.sourceURL.split('/').pop() ?? '',
            position: script.sourceCharPosition,
          })),
      });
    }
  });
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))
    loafObserver.observe({ type: 'long-animation-frame', buffered: true });
  window.__pixelsImportGate = {
    reset() {
      taskObserver.takeRecords();
      loafObserver.takeRecords();
      tasks.length = loafs.length = 0;
    },
    snapshot() {
      for (const entry of taskObserver.takeRecords())
        tasks.push({ start: entry.startTime, duration: entry.duration });
      // LoAF entries are delivered asynchronously; an animation frame after the operation gives
      // the observer time to report them before snapshot is called.
      return { tasks: [...tasks], loafs: [...loafs] };
    },
    async stored(id) {
      dbPromise ??= new Promise((done, fail) => {
        const request = indexedDB.open('pixels-files');
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      const db = await dbPromise;
      return new Promise((done, fail) => {
        const request = db.transaction('documents', 'readonly').objectStore('documents').get(id);
        request.onsuccess = () => {
          const record = request.result as { updatedAt?: number; shapes?: unknown[] } | undefined;
          done({ updatedAt: record?.updatedAt ?? 0, shapes: record?.shapes?.length ?? 0 });
        };
        request.onerror = () => fail(request.error);
      });
    },
  };
}

function photo(width: number, height: number): Uint32Array {
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const noise = (x * 2654435761 + y * 2246822519) >>> 24;
      pixels[y * width + x] = packRgba(
        (x & 255) ^ (noise & 255),
        (y & 255) ^ ((noise >> 3) & 255),
        ((x + y) & 255) ^ ((noise >> 5) & 255),
        255,
      );
    }
  }
  return pixels;
}

async function makeFixtures(directory: string): Promise<Record<CaseName, string>> {
  const paths = {} as Record<CaseName, string>;
  for (const [name, width, height] of [
    ['photo-2400', 2400, 1600],
    ['photo-3456', 3456, 2234],
    ['photo-4096', 4096, 4096],
  ] as const) {
    const path = join(directory, `${name}.png`);
    await Bun.write(path, await encodePng(width, height, photo(width, height)));
    paths[name] = path;
  }
  paths.p3 = resolve(import.meta.dirname, 'fixtures/macos-preview-p3.png');
  paths.shapes = paths['photo-3456'];
  const p3 = await decodePng(new Uint8Array(await Bun.file(paths.p3).arrayBuffer()));
  if (p3.colorTag !== 'display-p3') throw new Error('P3 screenshot fixture lost its color tag');
  return paths;
}

async function afterPaint(page: Page): Promise<number> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  return page.evaluate(() => performance.now());
}

async function snapshot(page: Page): Promise<Metrics> {
  await afterPaint(page);
  return page.evaluate(() => window.__pixelsImportGate!.snapshot());
}

function worst(metrics: Metrics): Task | undefined {
  return metrics.tasks.reduce<Task | undefined>(
    (current, task) => (!current || task.duration > current.duration ? task : current),
    undefined,
  );
}

function diagnose(label: string, metrics: Metrics): void {
  const task = worst(metrics);
  if (!task) return;
  const loaf = metrics.loafs.find(
    (frame) => frame.start <= task.start && task.start < frame.start + frame.duration,
  );
  console.log(
    `  ${label} worst task: ${task.duration.toFixed(1)} ms at +${task.start.toFixed(1)} ms; LoAF ${loaf ? JSON.stringify(loaf) : 'no matching frame attribution'}`,
  );
}

function loadText(profile: Profile): string {
  return profile === 'phone' ? '390×844 @ 3×' : '1440×900 @ 2×';
}

async function drawShapes(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
) {
  const d = Math.min(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.keyboard.press('r');
  await page.mouse.move(cx - 0.25 * d, cy - 0.1 * d);
  await page.mouse.down();
  await page.mouse.move(cx - 0.1 * d, cy + 0.05 * d, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('a');
  await page.mouse.move(cx + 0.04 * d, cy - 0.1 * d);
  await page.mouse.down();
  await page.mouse.move(cx + 0.23 * d, cy + 0.05 * d, { steps: 8 });
  await page.mouse.up();
}

/** Read back only after the timed observer has taken its snapshot. */
async function visibleShapes(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[role="application"][aria-label="Canvas"]')!;
    const canvas = host.querySelectorAll('canvas')[1]!;
    const ctx = canvas.getContext('2d')!;
    const d = Math.min(host.clientWidth, host.clientHeight);
    const cx = host.clientWidth / 2;
    const cy = host.clientHeight / 2;
    const scale = canvas.width / host.clientWidth;
    const count = (left: number, top: number, right: number, bottom: number) => {
      const x = Math.floor(left * scale);
      const y = Math.floor(top * scale);
      const width = Math.ceil((right - left) * scale);
      const height = Math.ceil((bottom - top) * scale);
      const rgba = ctx.getImageData(x, y, width, height).data;
      let visible = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 0) visible++;
      return visible;
    };
    return [
      count(cx - 0.27 * d, cy - 0.12 * d, cx - 0.08 * d, cy + 0.07 * d),
      count(cx + 0.02 * d, cy - 0.12 * d, cx + 0.25 * d, cy + 0.07 * d),
    ];
  });
}

async function runOne(
  browser: Browser,
  baseUrl: string,
  file: string,
  caseName: CaseName,
  profile: Profile,
  run: number,
  inject: boolean,
): Promise<ImportResult> {
  const context: BrowserContext = await browser.newContext(
    profile === 'phone'
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          hasTouch: true,
          isMobile: true,
        }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  );
  await context.addInitScript(observe);
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.getByRole('radio', { name: 'Pencil' }).waitFor();
    if (headed) await page.bringToFront();
    await page.waitForTimeout(1500);
    const start = await page.evaluate(() => {
      window.__pixelsImportGate!.reset();
      return performance.now();
    });
    const previousUrl = page.url();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (await chooser).setFiles(file);
    if (inject) {
      await page.evaluate(
        (ms) =>
          new Promise<void>((done) =>
            setTimeout(() => {
              const end = performance.now() + ms;
              while (performance.now() < end) {
                /* synthetic regression inside the observed open */
              }
              done();
            }, 0),
          ),
        injectOpenMs,
      );
    }
    await page.waitForURL((url) => url.href !== previousUrl, { timeout: 30_000 });
    await page.getByRole('button', { name: /^Zoom \d+%$/ }).waitFor({ timeout: 30_000 });
    const shown = await afterPaint(page);
    const renderMs = shown - start;
    const docId = new URL(page.url()).pathname.split('/').at(-1)!;
    const beforeSave = await page.evaluate((id) => window.__pixelsImportGate!.stored(id), docId);
    const host = page.getByRole('application', { name: 'Canvas' });
    const box = await host.boundingBox();
    if (!box) throw new Error('Canvas has no bounds');
    await page.keyboard.press('b');
    const strokeAt = await page.evaluate(() => performance.now());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 10 });
    await page.mouse.up();
    if (caseName === 'shapes') await drawShapes(page, box);
    await page.waitForFunction(
      async ({ id, previous, shapeCount }) => {
        const record = await window.__pixelsImportGate!.stored(id);
        return record.updatedAt > previous && record.shapes >= shapeCount;
      },
      { id: docId, previous: beforeSave.updatedAt, shapeCount: caseName === 'shapes' ? 2 : 0 },
      { polling: 100, timeout: 30_000 },
    );
    const saved = await page.evaluate(() => performance.now());
    const opened = await snapshot(page);
    const docUrl = page.url();
    await page.goto('about:blank');
    await page.goto(docUrl, { waitUntil: 'commit' });
    await page.getByRole('button', { name: /^Zoom \d+%$/ }).waitFor({ timeout: 30_000 });
    const reloaded = await afterPaint(page);
    await page.waitForTimeout(1500); // includes the lazy annotation painter's first frame
    const reload = await snapshot(page);
    const sameDocument = page.url() === docUrl;
    const colorspace =
      caseName === 'p3'
        ? await page.evaluate(
            () =>
              document
                .querySelector<HTMLCanvasElement>(
                  '[role="application"][aria-label="Canvas"] canvas',
                )
                ?.getContext('2d')
                ?.getContextAttributes()?.colorSpace,
          )
        : undefined;
    const shapes = caseName === 'shapes' ? await visibleShapes(page) : undefined;
    const badTask = Boolean(worst(opened) || worst(reload));
    const passed =
      !badTask &&
      errors.length === 0 &&
      sameDocument &&
      (caseName !== 'p3' || colorspace === 'display-p3') &&
      (caseName !== 'shapes' || (shapes![0] > 0 && shapes![1] > 0));
    const taskText = badTask
      ? `open ${worst(opened)?.duration.toFixed(1) ?? 'none'} ms, reload ${worst(reload)?.duration.toFixed(1) ?? 'none'} ms`
      : 'no task > 50 ms';
    console.log(
      `${passed ? 'PASS' : 'FAIL'} import ${caseName} ${profile} ${loadText(profile)} run ${run}: render ${renderMs.toFixed(0)} ms, first autosave ${(saved - strokeAt).toFixed(0)} ms, reload ${reloaded.toFixed(0)} ms, ${taskText}, ${shapes ? `visible shapes ${shapes.join('/')}, ` : ''}${colorspace ? `color ${colorspace}, ` : ''}loadavg ${loadavg()
        .map((n) => n.toFixed(2))
        .join('/')}`,
    );
    if (!passed) {
      diagnose('open/autosave', opened);
      diagnose('cold reload', reload);
      if (errors.length) console.log(`  page errors: ${errors.join(' | ')}`);
      if (!sameDocument) console.log(`  reloaded URL changed from ${docUrl} to ${page.url()}`);
    }
    return { passed, renderMs };
  } finally {
    await context.close();
  }
}

const directory = await mkdtemp(join(tmpdir(), 'pixels-import-fixtures-'));
try {
  const fixtures = await makeFixtures(directory);
  await withProductionPreview({ manifest: true }, async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: !headed });
    try {
      console.log(
        `Pixels real import: Chrome ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}; target zero main-thread tasks > 50 ms`,
      );
      let failed = false;
      let injected = false;
      const profiles: Profile[] = onlyProfile ? [onlyProfile] : ['desktop', 'phone'];
      const cases: CaseName[] = onlyCase
        ? [onlyCase]
        : ['photo-2400', 'photo-3456', 'photo-4096', 'p3', 'shapes'];
      for (const profile of profiles) {
        for (const caseName of cases) {
          const runs = caseName === 'shapes' ? 1 : repeat;
          const renderSamples: number[] = [];
          for (let run = 1; run <= runs; run++) {
            try {
              const inject: boolean = injectOpenMs > 0 && !injected;
              if (inject) injected = true;
              const result = await runOne(
                browser,
                baseUrl,
                fixtures[caseName],
                caseName,
                profile,
                run,
                inject,
              );
              renderSamples.push(result.renderMs);
              if (!result.passed) failed = true;
            } catch (error) {
              failed = true;
              console.log(`FAIL import ${caseName} ${profile} run ${run}: ${String(error)}`);
            }
          }
          const limit = firstRenderLimits[caseName];
          if (limit !== undefined) {
            if (renderSamples.length >= 3) {
              const observed = median(renderSamples);
              const passed = observed < limit;
              if (!passed) failed = true;
              console.log(
                `${passed ? 'PASS' : 'FAIL'} import first render ${caseName} ${profile}: median ${observed.toFixed(0)} ms [${renderSamples.map((value) => value.toFixed(0)).join(', ')}], target < ${limit} ms`,
              );
            } else {
              console.log(
                `DIAGNOSTIC import first render ${caseName} ${profile}: ${renderSamples.length} completed run(s), need at least 3 for the median gate`,
              );
            }
          }
        }
      }
      if (failed) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
