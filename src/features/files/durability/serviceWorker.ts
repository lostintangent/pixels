import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { createManifest, renderServiceWorker } from '../../../shared/build/serviceWorker';
import { withProductionPreview } from '../../../shared/preview';

/**
 * The playground's own base, the same signal both the build plugin and the runtime registration
 * key off. A plain `vite build` (base `/`) never emits `sw.js` at all, so these cases need their
 * own playground-base preview rather than the plain one every other durability case shares.
 */
const BASE = '/pixels/';

const headed = !process.argv.includes('--headless');

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

async function paintAt(
  page: Page,
  fracX: number,
  fracY: number,
  timeoutMs = 2_000,
): Promise<{ clip: Clip; painted: Buffer }> {
  const { clip, x, y } = await clipAt(page, fracX, fracY);
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

/** Resolves once this tab's registration has an active worker, first visit or not. */
async function waitForActiveWorker(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
}

const debounceMs = 1_000;

interface Case {
  name: string;
  run: (browser: Browser, baseUrl: string, output: string) => Promise<boolean>;
}

/**
 * A fresh document, drawn into and autosaved, survives a reload with no network at all: the shell,
 * every precached chunk and worker, and the lazy dialogs chunk Export lives in. This is the
 * baseline the whole feature exists for — a plane-mode launch after one prior visit.
 */
const offlineAfterOneVisit: Case = {
  name: 'a document stays usable offline after one prior visit',
  async run(browser, baseUrl, _output) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
      acceptDownloads: true,
    });
    try {
      const id = crypto.randomUUID();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/d/${id}`, { waitUntil: 'load' });
      await waitForCanvasReady(page);
      await waitForActiveWorker(page);

      const { clip, painted } = await paintAt(page, 0.5, 0.5);
      await Bun.sleep(debounceMs + 500); // let autosave flush before going offline

      await context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      await waitForCanvasReady(page);
      if (!(await samePixels(page, clip, painted))) return false;

      // Export lives in the same lazy chunk as Shapes, New, and Resize — opening it offline
      // proves the whole precached dialogs surface, not just the shell and main bundle.
      const downloaded = page.waitForEvent('download', { timeout: 10_000 });
      await page.keyboard.press('Meta+Shift+e');
      await page.getByRole('button', { name: 'Export' }).click();
      const download = await downloaded;
      const path = await download.path();
      return !!path && (await Bun.file(path).exists());
    } finally {
      await context.close();
    }
  },
};

/**
 * Every file a real `vite build` would emit for the playground, read back off disk the same way
 * the build plugin's own `generateBundle` sees them, so regenerating `sw.js` from a deliberately
 * mutated copy of that build exercises the exact manifest logic a real deploy would produce.
 */
async function filesFor(output: string): Promise<{ fileName: string; content: Buffer }[]> {
  const entries = await readdir(output, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return Promise.all(
    files.map(async (entry) => ({
      fileName: join(entry.parentPath, entry.name).slice(output.length + 1),
      content: await readFile(join(entry.parentPath, entry.name)),
    })),
  );
}

/**
 * One retry attempt's deploy mutates `output` on disk, so a later attempt of the same case (after
 * an infra fault, not a logic failure) would find the chunk already renamed and the deploy helper
 * would wrongly report it missing. The first call snapshots `output` as pristine and returns it
 * unchanged; every later call for the same `output` restores it from that snapshot first.
 */
const pristineBackups = new Map<string, string>();
async function restorePristineOutput(output: string): Promise<void> {
  const backup = pristineBackups.get(output);
  if (!backup) {
    const fresh = await mkdtemp(join(tmpdir(), 'pixels-sw-pristine-'));
    await cp(output, fresh, { recursive: true });
    pristineBackups.set(output, fresh);
    return;
  }
  await rm(output, { recursive: true, force: true });
  await cp(backup, output, { recursive: true });
}

/**
 * Simulates a real deploy in place: the lazy dialogs chunk gets a new, differently content-hashed
 * name, exactly like a changed source file would after a real rebuild, and the old-named file is
 * deleted from disk, since a real static host no longer serves a previous deploy's files either.
 * `sw.js` is regenerated from what's left, through the same `createManifest`/`renderServiceWorker`
 * a build uses. Returns the old chunk's own URL and bytes so a case can prove a still-open tab's
 * in-memory reference to that exact URL keeps resolving, from the one retained stale cache, even
 * though the file is now gone from the server.
 */
async function deployOverTheSameOutput(
  output: string,
): Promise<{ oldChunkUrl: string; oldChunkBytes: Buffer }> {
  const files = await filesFor(output);
  const dialogsChunk = files.find(
    (file) => /^assets\/all-.*\.js$/.test(file.fileName) && !file.fileName.includes('-redeployed'),
  );
  if (!dialogsChunk) throw new Error('Could not find the lazy dialogs chunk in the build output');

  const oldChunkUrl = `${BASE}${dialogsChunk.fileName}`;
  const oldChunkBytes = dialogsChunk.content;
  const newFileName = dialogsChunk.fileName.replace(/\.js$/, '-redeployed.js');
  await writeFile(join(output, newFileName), Buffer.concat([oldChunkBytes, Buffer.from('\n')]));
  await unlink(join(output, dialogsChunk.fileName));

  const remaining = (await filesFor(output)).filter((file) => file.fileName !== 'sw.js');
  const manifest = createManifest(BASE, remaining);
  await writeFile(join(output, 'sw.js'), renderServiceWorker(manifest));

  return { oldChunkUrl, oldChunkBytes };
}

/**
 * The exact toast copy `toasts/viewport.tsx` shows once an update is waiting. Astryx's own live
 * region echoes that same text for screen readers, so this must scope to the visible
 * "Notifications" region or it matches both and fails Playwright's strict mode.
 */
async function waitForUpdateToast(page: Page): Promise<void> {
  await page
    .getByRole('region', { name: 'Notifications' })
    .getByText('Pixels was updated. Reloading keeps your work.')
    .waitFor({ timeout: 10_000 });
}

async function reloadFromToast(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reload' }).click();
}

/**
 * Two tabs share one registration and one `CacheStorage`. Tab A reloads onto a deploy that
 * replaced the lazy dialogs chunk's file entirely; tab B never reloads. Three things must all
 * hold at once: tab A lands on the new build with its document intact; tab B's still-open Export
 * flow (its in-memory code still references the deleted old URL) keeps working, served from the
 * one stale cache `activate` deliberately keeps; and tab B's own Reload, clicked after tab A's
 * already activated the new worker and silently reassigned tab B's controller, resolves right
 * away instead of waiting forever for a `controllerchange` that already happened.
 */
const deploySwapAcrossTwoTabs: Case = {
  name: 'a deploy swap keeps an open second tab working and both tabs recover',
  async run(browser, baseUrl, output) {
    await restorePristineOutput(output);
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
      acceptDownloads: true,
    });
    try {
      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      const tabA = await context.newPage();
      const tabB = await context.newPage();
      await tabA.goto(`${baseUrl}/d/${idA}`, { waitUntil: 'load' });
      await waitForCanvasReady(tabA);
      await waitForActiveWorker(tabA);
      await tabB.goto(`${baseUrl}/d/${idB}`, { waitUntil: 'load' });
      await waitForCanvasReady(tabB);
      await waitForActiveWorker(tabB);

      const { clip: clipA, painted: paintedA } = await paintAt(tabA, 0.5, 0.5);
      const { clip: clipB, painted: paintedB } = await paintAt(tabB, 0.5, 0.5);
      await Bun.sleep(debounceMs + 500);

      // A real deploy replacing the served directory while both tabs stay open.
      const { oldChunkUrl, oldChunkBytes } = await deployOverTheSameOutput(output);

      // Force the check rather than waiting on the hourly visibility throttle this proves
      // separately in `serviceWorker.test.ts`.
      await tabA.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
      await waitForUpdateToast(tabA);
      // The same browser-level registration notifies every tab's own `updatefound`, with no
      // `update()` call of tab B's own.
      await waitForUpdateToast(tabB);

      await reloadFromToast(tabA);
      await tabA.waitForLoadState('load');
      await waitForCanvasReady(tabA);
      if (!(await samePixels(tabA, clipA, paintedA))) return false;

      // Tab B hasn't reloaded: its in-memory reference to the now-deleted old chunk URL must
      // still resolve, served from the one cache `activate` kept instead of deleting outright.
      const stillServed = await tabB.evaluate(async (url) => {
        const response = await fetch(url);
        return response.ok ? await response.text() : null;
      }, oldChunkUrl);
      if (stillServed !== oldChunkBytes.toString('utf8')) return false;

      // The real UI path: tab B's already-loaded app code still imports that same old URL to open
      // Export, which must still succeed even though the server no longer has that file at all.
      const downloaded = tabB.waitForEvent('download', { timeout: 10_000 });
      await tabB.keyboard.press('Meta+Shift+e');
      await tabB.getByRole('button', { name: 'Export' }).click();
      const download = await downloaded;
      const path = await download.path();
      if (!path || !(await Bun.file(path).exists())) return false;

      // Tab B's own Reload: tab A's earlier activation already claimed tab B's controller
      // silently, so this must resolve immediately rather than waiting on a controllerchange
      // that already fired before tab B ever attached a listener for it.
      await waitForUpdateToast(tabB);
      await reloadFromToast(tabB);
      await tabB.waitForLoadState('load', { timeout: 5_000 });
      await waitForCanvasReady(tabB);
      const tabBok = await samePixels(tabB, clipB, paintedB);
      if (!tabBok) console.error('DEBUG: tab B pixels changed after its own reload');
      return tabBok;
    } finally {
      await context.close();
    }
  },
};

const allCases: Case[] = [offlineAfterOneVisit, deploySwapAcrossTwoTabs];
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const cases = onlyArg ? [allCases[Number(onlyArg.slice('--only='.length))]!] : allCases;

let failed = false;
let inconclusive = false;
await withProductionPreview({ base: BASE }, async ({ baseUrl, output }) => {
  let browser = await chromium.launch({ headless: !headed });
  try {
    console.log(
      `Pixels service worker durability: Chromium ${browser.version()}, ${headed ? 'headed' : 'headless'}, ${process.platform}/${process.arch}`,
    );
    const maxAttempts = 3;
    for (const testCase of cases) {
      let passed: boolean | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          passed = await testCase.run(browser, baseUrl, output);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === maxAttempts) {
            console.log(
              `ERROR ${testCase.name} inconclusive after ${maxAttempts} attempts: ${message}`,
            );
          } else {
            console.log(
              `RETRY ${testCase.name} attempt ${attempt} after an infra fault: ${message}`,
            );
            await browser.close().catch(() => {});
            await Bun.sleep(2_000 * attempt);
            browser = await chromium.launch({ headless: !headed });
          }
        }
      }
      if (passed === undefined) inconclusive = true;
      else {
        if (!passed) failed = true;
        console.log(`${passed ? 'PASS' : 'FAIL'} ${testCase.name}`);
      }
    }
  } finally {
    await browser.close();
    await Promise.all(
      [...pristineBackups.values()].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
});
if (failed || inconclusive) process.exitCode = 1;
