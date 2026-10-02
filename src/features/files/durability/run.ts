import type { Browser, CDPSession, Page } from 'playwright';
import { chromium } from 'playwright';
import { withProductionPreview } from '../../../shared/preview';

/**
 * A stroke must survive whatever destroys the page next, against the real production app and a
 * real IndexedDB: `documentStore.saveNow()` cannot open its transaction until the thumbnail
 * round trip through the PNG Worker resolves, so `pagehide`'s synchronous-looking `flushNow()`
 * still has an await in front of the write that actually persists tiles. Five cases, each five
 * times in its own fresh `browser.newContext()` (its own IndexedDB), each proven pixel-exact by
 * composited screenshot bytes rather than `getImageData` — repeated reads of the display canvas
 * can move it off the GPU, the same hazard the app-load perf harness hit:
 *  - Reload immediately after a stroke, well inside the 1000 ms debounce window.
 *  - Close the page, then open a new one at the same URL in the same context.
 *  - Switch to a new document through the app's own "New canvas" menu and dialog, then return
 *    with the browser's own Back — this is the in-app unmount/dispose flush, not a page teardown.
 *  - CPU-throttle the page after a first stroke's debounce fires, paint a second stroke while
 *    the first flush is artificially stretched out, then reload immediately.
 *  - Draw a shape through the real Shapes popover, then reload inside the debounce window — a
 *    shape commit dirties no pixel tile, so this is the only case that exercises the
 *    shapes-dirty half of the autosave/crash-recovery path rather than the pixel-dirty half.
 */

const headed = !process.argv.includes('--headless');
const runsPerCase = process.argv.includes('--smoke') ? 1 : 5;
const debounceMs = 1000;

const CANVAS_SELECTOR = '[role="application"][aria-label="Canvas"]';

async function waitForCanvasReady(page: Page): Promise<void> {
  await page.waitForFunction((selector) => {
    const host = document.querySelector<HTMLElement>(selector);
    const canvas = host?.querySelector('canvas');
    const rect = host?.getBoundingClientRect();
    return (
      canvas &&
      rect &&
      canvas.width === Math.round(rect.width * devicePixelRatio) &&
      canvas.height === Math.round(rect.height * devicePixelRatio)
    );
  }, CANVAS_SELECTOR);
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function clipAt(
  page: Page,
  fracX: number,
  fracY: number,
): Promise<{ clip: Clip; x: number; y: number }> {
  const box = await page.getByRole('application', { name: 'Canvas' }).boundingBox();
  if (!box) throw new Error('Canvas has no bounding box');
  const x = box.x + box.width * fracX;
  const y = box.y + box.height * fracY;
  return { clip: { x: Math.floor(x) - 2, y: Math.floor(y) - 2, width: 5, height: 5 }, x, y };
}

/**
 * A point offset from the canvas box's center by a fixed CSS-pixel amount, rather than a fraction
 * of the whole box. The box is the full pannable/zoomable surface, not the document's own footprint
 * — a freshly fitted document is centered within it but, depending on its size and the layout's
 * insets, can occupy only a fraction of the box, so a fraction like 0.7 of the box can land past
 * the document's edge and paint nothing. The center is always inside the document by construction
 * (that's what "fit" centers on), so a small, fixed offset from it stays safely inside too.
 */
async function clipNear(
  page: Page,
  offsetX: number,
  offsetY: number,
): Promise<{ clip: Clip; x: number; y: number }> {
  const box = await page.getByRole('application', { name: 'Canvas' }).boundingBox();
  if (!box) throw new Error('Canvas has no bounding box');
  const x = box.x + box.width / 2 + offsetX;
  const y = box.y + box.height / 2 + offsetY;
  return { clip: { x: Math.floor(x) - 2, y: Math.floor(y) - 2, width: 5, height: 5 }, x, y };
}

/**
 * Paints one dot at a fractional position of the canvas box and returns the composited pixels
 * once the stroke is visible, screenshot-diffed rather than read with `getImageData` — the same
 * technique `loadAndStroke` uses, since repeated `getImageData` on the display canvas risks
 * moving it off the GPU and measuring a backing store the product never runs.
 */
async function paintAt(
  page: Page,
  fracX: number,
  fracY: number,
  timeoutMs = 2_000,
): Promise<{ clip: Clip; painted: Buffer }> {
  return paintAtPoint(page, await clipAt(page, fracX, fracY), timeoutMs);
}

/** Same as `paintAt`, but at a fixed CSS-pixel offset from the canvas box's center — see `clipNear`. */
async function paintNear(
  page: Page,
  offsetX: number,
  offsetY: number,
  timeoutMs = 2_000,
): Promise<{ clip: Clip; painted: Buffer }> {
  return paintAtPoint(page, await clipNear(page, offsetX, offsetY), timeoutMs);
}

async function paintAtPoint(
  page: Page,
  { clip, x, y }: { clip: Clip; x: number; y: number },
  timeoutMs: number,
): Promise<{ clip: Clip; painted: Buffer }> {
  const before = await page.screenshot({ clip, animations: 'disabled', scale: 'device' });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(0, 0);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = await page.screenshot({ clip, animations: 'disabled', scale: 'device' });
    if (!after.equals(before)) return { clip, painted: after };
    if (Date.now() >= deadline) throw new Error('Stroke did not change displayed pixels');
    await Bun.sleep(16);
  }
}

async function samePixels(page: Page, clip: Clip, expected: Buffer): Promise<boolean> {
  const actual = await page.screenshot({ clip, animations: 'disabled', scale: 'device' });
  return actual.equals(expected);
}

interface Case {
  name: string;
  run: (browser: Browser, baseUrl: string) => Promise<boolean>;
}

/** Reload right after a stroke, well inside the 1000 ms debounce — never let the timer fire. */
const reloadDuringDebounce: Case = {
  name: 'reload inside the debounce window',
  async run(browser, baseUrl) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/d/${crypto.randomUUID()}`, { waitUntil: 'load' });
      await waitForCanvasReady(page);
      const { clip, painted } = await paintAt(page, 0.5, 0.5);
      await page.reload({ waitUntil: 'load' });
      await waitForCanvasReady(page);
      return await samePixels(page, clip, painted);
    } finally {
      await context.close();
    }
  },
};

/** Close the tab, then open a new one at the same URL in the same context (same IndexedDB). */
const closeAndReopen: Case = {
  name: 'close the page, then reopen at the same URL',
  async run(browser, baseUrl) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    try {
      const id = crypto.randomUUID();
      const first = await context.newPage();
      await first.goto(`${baseUrl}/d/${id}`, { waitUntil: 'load' });
      await waitForCanvasReady(first);
      const { clip, painted } = await paintAt(first, 0.5, 0.5);
      await first.close();
      const second = await context.newPage();
      await second.goto(`${baseUrl}/d/${id}`, { waitUntil: 'load' });
      await waitForCanvasReady(second);
      return await samePixels(second, clip, painted);
    } finally {
      await context.close();
    }
  },
};

/**
 * Switch to a new document through the app's own "New canvas" menu and dialog, then return with
 * the browser's own Back. Both are client-side router navigations, so this proves the unmount's
 * `dispose()` flush, not a page-teardown listener.
 */
const switchDocumentsAndReturn: Case = {
  name: 'switch documents through the app, then come back',
  async run(browser, baseUrl) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    try {
      const id = crypto.randomUUID();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/d/${id}`, { waitUntil: 'load' });
      await waitForCanvasReady(page);
      const { clip, painted } = await paintAt(page, 0.5, 0.5);

      await page.getByRole('button', { name: 'Untitled' }).click();
      await page.getByRole('menuitem', { name: 'New canvas…' }).click();
      await page.getByRole('button', { name: 'Create' }).click();
      await page.waitForURL((url) => !url.pathname.endsWith(`/${id}`));
      await waitForCanvasReady(page);

      await page.goBack();
      await page.waitForURL((url) => url.pathname.endsWith(`/${id}`));
      await waitForCanvasReady(page);

      return await samePixels(page, clip, painted);
    } finally {
      await context.close();
    }
  },
};

/**
 * Paint a first stroke, let its debounce fire, CPU-throttle the page so that flush is stretched
 * out, paint a second stroke while the first is still in flight, then reload immediately. Both
 * strokes must survive. `Emulation.setCPUThrottlingRate` is a pure test-harness technique — it
 * touches no production code — and widens the real, structurally narrow "a save is in flight"
 * window without inventing artificial delays inside the app itself. The two strokes use
 * `paintNear` rather than `paintAt`'s box fractions: a freshly fitted small document only
 * occupies the center of its much larger pannable canvas box, so a corner-ish fraction like 0.7
 * can miss the document entirely and paint nothing.
 */
const reloadDuringInFlightSave: Case = {
  name: 'reload while a save from an earlier stroke is in flight',
  async run(browser, baseUrl) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    let client: CDPSession | undefined;
    try {
      const page = await context.newPage();
      client = await context.newCDPSession(page);
      await page.goto(`${baseUrl}/d/${crypto.randomUUID()}`, { waitUntil: 'load' });
      await waitForCanvasReady(page);

      const first = await paintNear(page, -20, -20);
      await client.send('Emulation.setCPUThrottlingRate', { rate: 20 });
      let second: { clip: Clip; painted: Buffer };
      try {
        // The debounce timer fires on real wall-clock time; only the work it kicks off runs
        // slower.
        await Bun.sleep(debounceMs + 100);
        second = await paintNear(page, 20, 20);
        await page.reload({ waitUntil: 'load' });
      } finally {
        // Reset before any close: leaving the renderer at 5% speed makes context teardown itself
        // stretch out, or hang, well past what a thrown assertion should cost.
        await client.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      }
      await waitForCanvasReady(page);

      const firstOk = await samePixels(page, first.clip, first.painted);
      const secondOk = await samePixels(page, second.clip, second.painted);
      return firstOk && secondOk;
    } finally {
      await client?.detach().catch(() => {});
      await context.close();
    }
  },
};

/**
 * Draw a shape through the real Shapes popover, then reload immediately, well inside the
 * debounce. A committed shape dirties no pixel tile, so this is the one case that only passes if
 * `attachAutosave` treats a shape commit as its own reason to stash and flush — a plain pixel
 * stroke case would never exercise that path.
 */
const drawShapeThenReload: Case = {
  name: 'draw a shape, then reload inside the debounce window',
  async run(browser, baseUrl) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/d/${crypto.randomUUID()}`, { waitUntil: 'load' });
      await waitForCanvasReady(page);

      await page.getByRole('radio', { name: 'Shapes' }).click();
      await page.getByRole('menuitemradio', { name: 'Rectangle' }).click();

      const start = await clipNear(page, -20, -20);
      const end = await clipNear(page, 20, 20);
      const before = await page.screenshot({
        clip: start.clip,
        animations: 'disabled',
        scale: 'device',
      });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 5 });
      await page.mouse.up();
      await page.mouse.move(0, 0);
      // Deselect before comparing: the selection overlay draws handles at this same corner, and
      // those handles correctly vanish on reload since only shape geometry persists, not
      // selection state. Comparing with them still showing would be a false mismatch.
      await page.keyboard.press('Escape');

      const deadline = Date.now() + 2_000;
      let painted: Buffer | undefined;
      for (;;) {
        const after = await page.screenshot({
          clip: start.clip,
          animations: 'disabled',
          scale: 'device',
        });
        if (!after.equals(before)) {
          painted = after;
          break;
        }
        if (Date.now() >= deadline) throw new Error('Shape did not change displayed pixels');
        await Bun.sleep(16);
      }

      await page.reload({ waitUntil: 'load' });
      await waitForCanvasReady(page);
      return await samePixels(page, start.clip, painted);
    } finally {
      await context.close();
    }
  },
};

const allCases: Case[] = [
  reloadDuringDebounce,
  closeAndReopen,
  switchDocumentsAndReturn,
  reloadDuringInFlightSave,
  drawShapeThenReload,
];
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const cases = onlyArg ? [allCases[Number(onlyArg.slice('--only='.length))]!] : allCases;

let failed = false;
// Set only when a case's own infra fault (not a real assertion result) survives a retry — the
// run couldn't verify that case that time, which still needs a re-run, but it's not itself proof
// of a durability bug.
let inconclusive = false;
await withProductionPreview({}, async ({ baseUrl }) => {
  let browser = await chromium.launch({ headless: !headed });
  try {
    console.log(
      `Pixels durability: Chromium ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}`,
    );
    const maxAttempts = 3;
    for (const testCase of cases) {
      for (let run = 1; run <= runsPerCase; run++) {
        // A shared, non-sandboxed machine can crash or wedge the renderer under someone else's
        // load — that is an infra fault, not a finding, so it gets a few retries with a fresh
        // browser and a short backoff to let a transient spike pass. A real assertion failure
        // (a returned `false`) never retries; only a thrown exception does.
        let passed: boolean | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            passed = await testCase.run(browser, baseUrl);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (attempt === maxAttempts) {
              // Every attempt hit an infra fault: report it distinctly from PASS/FAIL and move
              // on, instead of letting it abort every remaining case and run.
              console.log(
                `ERROR ${testCase.name} (${run}/${runsPerCase}) inconclusive after ${maxAttempts} attempts: ${message}`,
              );
            } else {
              console.log(
                `RETRY ${testCase.name} (${run}/${runsPerCase}) attempt ${attempt} after an infra fault: ${message}`,
              );
              // Always relaunch, even if Playwright still reports this browser as connected —
              // a wedged renderer under contention doesn't necessarily flip that flag.
              await browser.close().catch(() => {});
              await Bun.sleep(2_000 * attempt);
              browser = await chromium.launch({ headless: !headed });
            }
          }
        }
        if (passed === undefined) {
          inconclusive = true;
        } else {
          if (!passed) failed = true;
          console.log(`${passed ? 'PASS' : 'FAIL'} ${testCase.name} (${run}/${runsPerCase})`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});
if (failed || inconclusive) process.exitCode = 1;
