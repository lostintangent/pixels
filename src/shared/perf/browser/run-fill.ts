import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, loadavg, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { packRgba } from '../../../features/document';
import { encodePng } from '../../../features/files/model';
import { withProductionPreview } from '../../preview';

const width = 3456;
const height = 2234;
const repeatIndex = process.argv.indexOf('--repeat');
const repeat = repeatIndex < 0 ? 3 : Number(process.argv[repeatIndex + 1]);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new RangeError('--repeat must be 1 to 20');
const injectIndex = process.argv.indexOf('--inject-fill-ms');
const injectFillMs = injectIndex < 0 ? 0 : Number(process.argv[injectIndex + 1]);
if (!Number.isFinite(injectFillMs) || injectFillMs < 0 || injectFillMs > 100)
  throw new RangeError('--inject-fill-ms must be 0 to 100');
const headed = !process.argv.includes('--headless');

interface FillObservation {
  longTasks: Array<{ duration: number; name: string }>;
  pointerDownProcessingMs: number[];
}

async function fixturePng(): Promise<Uint8Array> {
  const desktop = packRgba(90, 110, 140, 255);
  const white = packRgba(255, 255, 255, 255);
  const text = packRgba(30, 30, 32, 255);
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = desktop;
      if (x > 300 && x < 3150 && y > 200 && y < 2000) {
        color = white;
        if (
          y > 380 &&
          y < 760 &&
          (y - 380) % 38 < 14 &&
          x > 980 &&
          x < 2900 &&
          (x * 7 + y * 3) % 23 < 15
        )
          color = text;
      }
      pixels[y * width + x] = color;
    }
  }
  return encodePng(width, height, pixels);
}

async function afterPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function installObservers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observations: FillObservation = { longTasks: [], pointerDownProcessingMs: [] };
    const probe = window as Window & { __pixelsFillProbe?: FillObservation };
    probe.__pixelsFillProbe = observations;
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask'))
      throw new Error('Chrome does not support the longtask observer');
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        observations.longTasks.push({ duration: entry.duration, name: entry.name });
    }).observe({ type: 'longtask' });
    if (PerformanceObserver.supportedEntryTypes.includes('event')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name !== 'pointerdown') continue;
          const timing = entry as PerformanceEntry & {
            processingStart: number;
            processingEnd: number;
          };
          observations.pointerDownProcessingMs.push(timing.processingEnd - timing.processingStart);
        }
      }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
    }
  });
}

async function measureFill(
  baseUrl: string,
  file: string,
  profile: 'desktop' | 'phone',
  run: number,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<boolean> {
  const phone = profile === 'phone';
  const context = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          colorScheme: 'dark',
        }
      : {
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 2,
          colorScheme: 'light',
        },
  );
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseUrl);
    await page.getByRole('radio', { name: 'Pencil' }).waitFor();
    if (headed) await page.bringToFront();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Meta+o');
    await (await chooser).setFiles(file);
    await page.getByRole('button', { name: /^Zoom \d+%$/ }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(3000);
    if (phone) await page.getByRole('radio', { name: 'Fill' }).tap();
    else await page.keyboard.press('g');
    const box = await page.getByRole('application', { name: 'Canvas' }).boundingBox();
    if (!box) throw new Error('Canvas is not visible');
    const point = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2 + (phone ? 20 : 120),
    };
    const clip = { x: point.x + 18, y: point.y + 18, width: 4, height: 4 };
    await installObservers(page);
    if (injectFillMs > 0)
      await page.evaluate((duration) => {
        const host = document.querySelector('[role="application"][aria-label="Canvas"]');
        if (!host) throw new Error('Canvas host is missing');
        host.addEventListener(
          'pointerdown',
          () => {
            const end = performance.now() + duration;
            while (performance.now() < end) {
              // A deliberate main-thread regression to prove the observer gate.
            }
          },
          { capture: true, once: true },
        );
      }, injectFillMs);
    let passed = true;
    for (let fill = 0; fill < 3; fill++) {
      const before = await page.screenshot({ clip, timeout: 3000 });
      await afterPaint(page);
      await page.evaluate(() => {
        const probe = (window as Window & { __pixelsFillProbe?: FillObservation })
          .__pixelsFillProbe;
        if (!probe) throw new Error('Fill observers are missing');
        probe.longTasks.length = 0;
        probe.pointerDownProcessingMs.length = 0;
      });
      if (phone) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await afterPaint(page);
      await page.waitForTimeout(400);
      const observed = await page.evaluate(
        () => (window as Window & { __pixelsFillProbe?: FillObservation }).__pixelsFillProbe,
      );
      if (!observed) throw new Error('Fill observers are missing');
      const after = await page.screenshot({ clip, timeout: 3000 });
      if (after.equals(before)) throw new Error('Fill did not change the displayed pixel');
      if (errors.length) throw new Error(`Page error: ${errors.join(', ')}`);
      const fillPassed = observed.longTasks.length === 0;
      if (!fillPassed) passed = false;
      const worst = Math.max(0, ...observed.longTasks.map((task) => task.duration));
      const pointer = Math.max(0, ...observed.pointerDownProcessingMs);
      console.log(
        `${fillPassed ? 'PASS' : 'FAIL'} screenshot fill ${profile} context ${run + 1}/${repeat} fill ${fill + 1}/3: long tasks ${observed.longTasks.length}, worst ${worst.toFixed(1)} ms, pointerdown processing ${pointer.toFixed(1)} ms (diagnostic), target no main task ≥ 50 ms, loadavg ${loadavg()
          .map((value) => value.toFixed(2))
          .join('/')}`,
      );
      await page.keyboard.press('Meta+z');
      await afterPaint(page);
      const restored = await page.screenshot({ clip, timeout: 3000 });
      if (!restored.equals(before)) throw new Error('One undo did not restore the displayed pixel');
    }
    return passed;
  } finally {
    await context.close();
  }
}

const directory = await mkdtemp(join(tmpdir(), 'pixels-fill-'));
try {
  const file = join(directory, 'screenshot.png');
  await Bun.write(file, await fixturePng());
  await withProductionPreview({}, async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: !headed });
    try {
      console.log(
        `Screenshot fill gate: ${platform()} ${cpus()[0]?.model ?? 'unknown CPU'}, Chrome ${browser.version()}, ${headed ? 'headed' : 'headless'}, 3456×2234 white window with text, 4.9M connected pixels`,
      );
      let passed = true;
      for (const profile of ['desktop', 'phone'] as const)
        for (let run = 0; run < repeat; run++)
          if (!(await measureFill(baseUrl, file, profile, run, browser))) passed = false;
      if (!passed) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
