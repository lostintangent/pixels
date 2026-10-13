import { mkdir } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Browser, BrowserContext, Page } from 'playwright';
import { dispatchCadence, editorGateVerdict, type DispatchCadence } from './cadence';
import { captureTrace } from './capture';
import { withIdleMacInput, withVisibleIdleMacInput } from './hidIdle';
import type { TraceEvent, TraceSummary } from './trace';

interface Profile {
  name: 'desktop' | 'phone';
  width: number;
  height: number;
  dpr: number;
}

const profiles: Profile[] = [
  { name: 'desktop', width: 1440, height: 900, dpr: 2 },
  { name: 'phone', width: 390, height: 844, dpr: 3 },
];

const mainThreadTargetMs = {
  desktop: { stroke: 1.95, pan: 0.8 },
  phone: { stroke: 0.9, pan: 0.75 },
} as const;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function afterPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function canvasBox(page: Page) {
  const box = await page.getByRole('application', { name: 'Canvas' }).boundingBox();
  if (!box) throw new Error('Editor canvas has no bounding box');
  return box;
}

async function visualAt(page: Page, x: number, y: number): Promise<Buffer> {
  return page.screenshot({
    clip: { x: Math.floor(x) - 2, y: Math.floor(y) - 2, width: 5, height: 5 },
    animations: 'disabled',
    scale: 'device',
    timeout: 3_000,
  });
}

/** Verify the planned input starts and ends over the blank document, from compositor pixels.
 * Reading the app canvas would move its GPU surface into software mode before the trace. */
async function assertStrokeGeometry(page: Page, profile: Profile): Promise<void> {
  const path = await strokePath(page, profile);
  for (const [name, point] of [
    ['start', path.first],
    ['end', path.point(119)],
  ] as const) {
    const clip = {
      x: Math.floor(point.x) - 16,
      y: Math.floor(point.y) - 16,
      width: 32,
      height: 32,
    };
    const screenshot = await page.screenshot({
      clip,
      animations: 'disabled',
      scale: 'device',
      timeout: 3_000,
    });
    const match = await page.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not inspect compositor screenshot');
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      let checkerPixels = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (
          (rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255) ||
          (rgba[i] === 58 && rgba[i + 1] === 58 && rgba[i + 2] === 60)
        )
          checkerPixels++;
      }
      return { checkerPixels, totalPixels: rgba.length / 4 };
    }, screenshot.toString('base64'));
    if (match.checkerPixels < match.totalPixels / 8)
      throw new Error(
        `${profile.name} stroke ${name} is outside the blank document at ${point.x.toFixed(1)},${point.y.toFixed(1)}: ${match.checkerPixels}/${match.totalPixels} checker pixels`,
      );
  }
}

async function prepareDocument(
  page: Page,
  baseUrl: string,
  profile: Profile,
  run: number,
): Promise<void> {
  const initialUrl = `${baseUrl}/d/editor-perf-${profile.name}-${run}`;
  await page.goto(initialUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('application', { name: 'Canvas' }).waitFor();
  await page.keyboard.press('Meta+Alt+n');
  const width = page.getByRole('spinbutton', { name: 'Width' });
  await width.click();
  await width.press('Meta+A');
  await width.press('Backspace');
  await width.type('1024');
  await width.press('Tab');
  const height = page.getByRole('spinbutton', { name: 'Height' });
  if (
    (await width.getAttribute('aria-valuenow')) !== '1024' ||
    (await height.getAttribute('aria-valuenow')) !== '1024'
  )
    throw new Error('New canvas size did not become 1024²');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL((url) => url.href !== initialUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('application', { name: 'Canvas' }).waitFor();
  // A fitted 1024² document is below 1× on both profiles; its exact percentage follows the viewport.
  const zoom = page.getByRole('button', { name: /^Zoom \d+%$/ });
  await zoom.waitFor();
  await afterPaint(page);
  // A pointer left over the fitted phone canvas anchors keyboard zoom there. Move it onto
  // chrome so the fixed trace and verification path stays over the image at 8×.
  if (profile.name === 'phone') await zoom.hover();
  for (let step = 0; step < 12; step++) {
    if ((await page.getByRole('button', { name: 'Zoom 8×' }).count()) > 0) break;
    if (profile.name === 'phone') await page.keyboard.press('Equal');
    else await page.getByRole('button', { name: 'Zoom in' }).click();
  }
  if ((await page.getByRole('button', { name: 'Zoom 8×' }).count()) === 0)
    throw new Error('Editor zoom did not become 8×');
  const zoomedUrl = page.url();
  const canvasHost = await page.getByRole('application', { name: 'Canvas' }).elementHandle();
  await page.waitForTimeout(200);
  if ((await page.getByRole('button', { name: 'Zoom 8×' }).count()) === 0) {
    const sameCanvasHost = canvasHost
      ? await page
          .evaluate(
            (previous) =>
              previous === document.querySelector('[role="application"][aria-label="Canvas"]'),
            canvasHost,
          )
          .catch(() => false)
      : false;
    throw new Error(
      `Editor zoom reverted during setup: url ${zoomedUrl} → ${page.url()}, same canvas host ${sameCanvasHost}, buttons ${(await page.getByRole('button').allTextContents()).slice(0, 6).join(', ')}`,
    );
  }
  await canvasHost?.dispose();
  const slider = page.getByRole('slider', { name: 'Brush size' });
  for (let i = 0; i < 32 && (await slider.getAttribute('aria-valuetext')) !== '16 px'; i++) {
    await slider.focus();
    await slider.press('ArrowRight');
  }
  const brush = await slider.getAttribute('aria-valuetext');
  if (brush !== '16 px') throw new Error(`Brush size did not become 16 px: ${brush}`);
  await page.getByRole('application', { name: 'Canvas' }).focus();
  await afterPaint(page);
  if ((await page.evaluate(() => document.visibilityState)) !== 'visible')
    await page.bringToFront();
  await assertStrokeGeometry(page, profile);
}

async function strokePath(page: Page, profile: Profile) {
  const box = await canvasBox(page);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const amplitudeX = profile.name === 'phone' ? 100 : 480;
  const amplitudeY = profile.name === 'phone' ? 250 : 36;
  const point = (sample: number) => ({
    x: centerX - amplitudeX + (2 * amplitudeX * sample) / 119,
    y: centerY - amplitudeY + (2 * amplitudeY * sample) / 119,
  });
  return { first: point(0), point };
}

async function drawStroke(
  context: BrowserContext,
  page: Page,
  profile: Profile,
  path: Awaited<ReturnType<typeof strokePath>>,
  markFirstInput?: () => Promise<void>,
  dispatchTimes?: number[],
): Promise<void> {
  const { first, point } = path;
  if (profile.name === 'phone') {
    const session = await context.newCDPSession(page);
    try {
      await markFirstInput?.();
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ id: 1, ...first }],
      });
      const startedAt = performance.now();
      const pendingMoves: Promise<unknown>[] = [];
      for (let sample = 1; sample < 120; sample++) {
        const delay = startedAt + sample * 17 - performance.now();
        if (delay > 0) await Bun.sleep(delay);
        dispatchTimes?.push(performance.now());
        pendingMoves.push(
          session.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ id: 1, ...point(sample) }],
          }),
        );
        if (pendingMoves.length === 3) await pendingMoves.shift();
      }
      await Promise.all(pendingMoves);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else {
    await markFirstInput?.();
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    const startedAt = performance.now();
    for (let sample = 1; sample < 120; sample++) {
      const delay = startedAt + sample * 17 - performance.now();
      if (delay > 0) await Bun.sleep(delay);
      dispatchTimes?.push(performance.now());
      const next = point(sample);
      await page.mouse.move(next.x, next.y);
    }
    await page.mouse.up();
  }
  await afterPaint(page);
}

async function panZoom(
  context: BrowserContext,
  page: Page,
  profile: Profile,
  markFirstInput: () => Promise<void>,
  dispatchTimes?: number[],
): Promise<void> {
  const box = await canvasBox(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (profile.name === 'phone') {
    const session = await context.newCDPSession(page);
    try {
      await markFirstInput();
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { id: 1, x: x - 60, y },
          { id: 2, x: x + 60, y },
        ],
      });
      const startedAt = performance.now();
      for (let frame = 1; frame <= 90; frame++) {
        const delay = startedAt + frame * 33 - performance.now();
        if (delay > 0) await Bun.sleep(delay);
        dispatchTimes?.push(performance.now());
        const phase = (frame / 90) * Math.PI * 2;
        const shiftX = 40 * Math.sin(phase);
        const shiftY = 30 * Math.cos(phase) - 30;
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { id: 1, x: x - 60, y },
            { id: 2, x: x + 60 + shiftX, y: y + shiftY },
          ],
        });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else {
    await markFirstInput();
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'middle' });
    const startedAt = performance.now();
    for (let frame = 1; frame <= 90; frame++) {
      const delay = startedAt + frame * 33 - performance.now();
      if (delay > 0) await Bun.sleep(delay);
      dispatchTimes?.push(performance.now());
      const phase = (frame / 90) * Math.PI * 2;
      await page.mouse.move(x + 100 * Math.sin(phase), y + 60 * (Math.cos(phase) - 1));
    }
    await page.mouse.up({ button: 'middle' });
  }
  await afterPaint(page);
}

/** Same browser, viewport, input driver, and frame gate as the editor. This
 * small canvas tells us when Chrome drops input frames without Pixels present. */
async function createInputControl(context: BrowserContext, profile: Profile): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div role="application" aria-label="Canvas" tabindex="0" style="width:100vw;height:100vh;touch-action:none">
      <canvas width="${profile.width}" height="${profile.height}"></canvas>
    </div>
    <script>
      const host = document.querySelector('[role=application]');
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      window.__pixelsControlMoves = 0;
      let requested = false, x = 0, y = 0;
      host.addEventListener('pointerdown', (event) => host.setPointerCapture(event.pointerId));
      host.addEventListener('pointermove', (event) => {
        if (!event.buttons) return;
        window.__pixelsControlMoves++;
        x = event.clientX; y = event.clientY;
        if (requested) return;
        requested = true;
        requestAnimationFrame(() => {
          requested = false;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#ee3';
          ctx.fillRect(x - 30, y - 30, 60, 60);
        });
      });
    </script></body></html>`);
  return page;
}

async function controlGesture(
  context: BrowserContext,
  page: Page,
  profile: Profile,
  scenario: 'stroke' | 'pan',
  markFirstInput?: () => Promise<void>,
  dispatchTimes?: number[],
): Promise<void> {
  if (scenario === 'stroke')
    await drawStroke(
      context,
      page,
      profile,
      await strokePath(page, profile),
      markFirstInput,
      dispatchTimes,
    );
  else await panZoom(context, page, profile, markFirstInput ?? (async () => {}), dispatchTimes);
}

function summarizeBlocks(
  blocks: TraceSummary[],
  target: number,
): {
  passed: boolean;
  mainPassed: boolean;
  framesPassed: boolean;
  details: string;
} {
  const frames = blocks.map((block) => block.frameCount);
  if (frames.some((count) => count < 30))
    throw new Error(`Real editor trace captured fewer than 30 frames: ${frames.join(', ')}`);
  const mainP95 = median(blocks.map((block) => block.mainP95Ms));
  const pipelineP95 = median(blocks.map((block) => block.pipelineP95Ms));
  const maxMainTask = Math.max(...blocks.map((block) => block.maxMainTaskMs));
  const eligible = blocks.reduce((sum, block) => sum + block.eligibleFrames, 0);
  const onTime = blocks.reduce((sum, block) => sum + block.onTimeFrames, 0);
  const dropped = blocks.reduce((sum, block) => sum + block.droppedFrames, 0);
  const highLatency = blocks.reduce((sum, block) => sum + block.highLatencyFrames, 0);
  const states = new Map<string, number>();
  for (const block of blocks)
    for (const [name, count] of Object.entries(block.presentationStates))
      states.set(name, (states.get(name) ?? 0) + count);
  const consecutiveDrops = blocks.some((block) => block.consecutiveDrops);
  const onTimePercent = (onTime / eligible) * 100;
  const refreshHz = median(blocks.map((block) => block.refreshHz));
  const mainPassed = mainP95 < target && maxMainTask <= 50;
  const framesPassed = onTimePercent >= 99 && !consecutiveDrops && eligible >= 90;
  return {
    passed: mainPassed && framesPassed,
    mainPassed,
    framesPassed,
    details: `main p95 ${mainP95.toFixed(3)} ms [${blocks.map((block) => block.mainP95Ms.toFixed(3)).join(', ')}], aggregate pipeline CPU p95 ${pipelineP95.toFixed(3)} ms (diagnostic), max main task ${maxMainTask.toFixed(3)} ms, on-time ${onTime}/${eligible} (${onTimePercent.toFixed(2)}%, dropped ${dropped}, high latency ${highLatency}, consecutive drops ${consecutiveDrops}, states ${JSON.stringify(Object.fromEntries(states))}), refresh ${refreshHz.toFixed(2)} Hz, frames [${frames.join(', ')}], target main < ${target} ms and on-time ≥ 99%`,
  };
}

export async function runEditorInput(
  browser: Browser,
  baseUrl: string,
  repeat: number,
  calibrate: boolean,
  injectStrokeMs = 0,
): Promise<boolean> {
  let failed = false;
  for (const profile of profiles) {
    for (let run = 0; run < repeat; run++) {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: profile.dpr,
        reducedMotion: 'reduce',
        isMobile: profile.name === 'phone',
        hasTouch: profile.name === 'phone',
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await withIdleMacInput(`${profile.name} setup`, () =>
          prepareDocument(page, baseUrl, profile, run),
        );
        const controlPage = await createInputControl(context, profile);
        await page.bringToFront();
        for (const scenario of ['stroke', 'pan'] as const) {
          const blocks: TraceSummary[] = [];
          const cadences: DispatchCadence[] = [];
          const controlBlocks: TraceSummary[] = [];
          const controlCadences: DispatchCadence[] = [];
          const retainedTraces: TraceEvent[][] = [];
          const controlTraces: TraceEvent[][] = [];
          const retainTrace = process.env.PIXELS_PERF_TRACE_DIR
            ? (events: TraceEvent[]) => retainedTraces.push(events)
            : undefined;
          await controlPage.bringToFront();
          await controlGesture(context, controlPage, profile, scenario);
          await page.bringToFront();
          await afterPaint(page);
          for (let block = 0; block < 3; block++) {
            await page.bringToFront();
            await afterPaint(page);
            const dispatchTimes: number[] = [];
            if (scenario === 'stroke') {
              const path = await strokePath(page, profile);
              if (profile.name === 'desktop' && injectStrokeMs > 0)
                await page.evaluate((ms) => {
                  const busy = () => {
                    const end = performance.now() + ms;
                    while (performance.now() < end) {
                      /* synthetic main-thread work */
                    }
                  };
                  window.addEventListener('pointermove', busy, true);
                  (window as Window & { __pixelsPerfStop?: () => void }).__pixelsPerfStop = () =>
                    window.removeEventListener('pointermove', busy, true);
                }, injectStrokeMs);
              let summary: TraceSummary;
              try {
                summary = await withVisibleIdleMacInput(
                  page,
                  `${profile.name} stroke block ${block + 1}`,
                  () =>
                    captureTrace(
                      context,
                      page,
                      (markFirstInput) =>
                        drawStroke(context, page, profile, path, markFirstInput, dispatchTimes),
                      retainTrace,
                    ),
                );
              } finally {
                if (profile.name === 'desktop' && injectStrokeMs > 0)
                  await page.evaluate(() =>
                    (window as Window & { __pixelsPerfStop?: () => void }).__pixelsPerfStop?.(),
                  );
              }
              blocks.push(summary);
              // A 30 ms gap remains below two 60 Hz frames. Shorter jitter has
              // appeared with every control frame presented; 33 ms is a miss.
              const cadence = dispatchCadence(dispatchTimes, 119, 30);
              cadences.push(cadence);
              console.log(
                `stroke block ${profile.name} ${run + 1}/${repeat} ${block + 1}/3: on-time ${summary.onTimeFrames}/${summary.eligibleFrames}, states ${JSON.stringify(summary.presentationStates)}, misses ${JSON.stringify(summary.missedFrameRuns)}, before input ${JSON.stringify(summary.preInputMisses)}, input send gaps p50/p95/max ${cadence.p50Ms.toFixed(1)}/${cadence.p95Ms.toFixed(1)}/${cadence.maxMs.toFixed(1)} ms, late ${cadence.lateGaps}/${cadence.samples - 1} over ${cadence.maxAllowedGapMs} ms, Chrome receipt gaps p50/p95/max ${summary.receivedMoveGaps.p50Ms.toFixed(1)}/${summary.receivedMoveGaps.p95Ms.toFixed(1)}/${summary.receivedMoveGaps.maxMs.toFixed(1)} ms, EventLatency stage p95 ${JSON.stringify(summary.inputLatencyStageP95Ms)}, main p95 ${summary.mainP95Ms.toFixed(3)} ms, pipeline p95 ${summary.pipelineP95Ms.toFixed(3)} ms, stages ${JSON.stringify(summary.stageP95Ms)}, loadavg ${loadavg()
                  .map((value) => value.toFixed(2))
                  .join('/')}`,
              );
              await page.keyboard.press('Meta+z');
              await afterPaint(page);
            } else {
              const summary = await withVisibleIdleMacInput(
                page,
                `${profile.name} pan block ${block + 1}`,
                () =>
                  captureTrace(
                    context,
                    page,
                    (markFirstInput) =>
                      panZoom(context, page, profile, markFirstInput, dispatchTimes),
                    retainTrace,
                  ),
              );
              blocks.push(summary);
              const cadence = dispatchCadence(dispatchTimes, 90, 45);
              cadences.push(cadence);
              console.log(
                `pan block ${profile.name} ${run + 1}/${repeat} ${block + 1}/3: input send gaps p50/p95/max ${cadence.p50Ms.toFixed(1)}/${cadence.p95Ms.toFixed(1)}/${cadence.maxMs.toFixed(1)} ms, late ${cadence.lateGaps}/${cadence.samples - 1} over ${cadence.maxAllowedGapMs} ms, Chrome receipt gaps p50/p95/max ${summary.receivedMoveGaps.p50Ms.toFixed(1)}/${summary.receivedMoveGaps.p95Ms.toFixed(1)}/${summary.receivedMoveGaps.maxMs.toFixed(1)} ms, EventLatency stage p95 ${JSON.stringify(summary.inputLatencyStageP95Ms)}, on-time ${summary.onTimeFrames}/${summary.eligibleFrames}`,
              );
            }
            await controlPage.bringToFront();
            await afterPaint(controlPage);
            await controlPage.evaluate(() => {
              (window as Window & { __pixelsControlMoves?: number }).__pixelsControlMoves = 0;
            });
            const controlDispatchTimes: number[] = [];
            const controlSummary = await withVisibleIdleMacInput(
              controlPage,
              `${profile.name} ${scenario} control block ${block + 1}`,
              () =>
                captureTrace(
                  context,
                  controlPage,
                  (markFirstInput) =>
                    controlGesture(
                      context,
                      controlPage,
                      profile,
                      scenario,
                      markFirstInput,
                      controlDispatchTimes,
                    ),
                  process.env.PIXELS_PERF_TRACE_DIR
                    ? (events) => controlTraces.push(events)
                    : undefined,
                ),
            );
            const controlMoves = await controlPage.evaluate(
              () => (window as Window & { __pixelsControlMoves?: number }).__pixelsControlMoves,
            );
            if (controlMoves === undefined || controlMoves < 50)
              throw new Error(
                `${profile.name} ${scenario} control received only ${controlMoves ?? 0} pointer moves`,
              );
            controlBlocks.push(controlSummary);
            const controlCadence = dispatchCadence(
              controlDispatchTimes,
              scenario === 'stroke' ? 119 : 90,
              scenario === 'stroke' ? 30 : 45,
            );
            controlCadences.push(controlCadence);
            console.log(
              `control block ${profile.name} ${scenario} ${run + 1}/${repeat} ${block + 1}/3: on-time ${controlSummary.onTimeFrames}/${controlSummary.eligibleFrames}, input send gaps p50/p95/max ${controlCadence.p50Ms.toFixed(1)}/${controlCadence.p95Ms.toFixed(1)}/${controlCadence.maxMs.toFixed(1)} ms, late ${controlCadence.lateGaps}/${controlCadence.samples - 1} over ${controlCadence.maxAllowedGapMs} ms, Chrome receipt gaps p50/p95/max ${controlSummary.receivedMoveGaps.p50Ms.toFixed(1)}/${controlSummary.receivedMoveGaps.p95Ms.toFixed(1)}/${controlSummary.receivedMoveGaps.maxMs.toFixed(1)} ms, main p95 ${controlSummary.mainP95Ms.toFixed(3)} ms`,
            );
          }
          await page.bringToFront();
          if (scenario === 'stroke') {
            // Verify the same real input path after tracing. Screenshot capture
            // never changes the app's 2D canvas readback mode during a block.
            const path = await strokePath(page, profile);
            const [before, after] = await withVisibleIdleMacInput(
              page,
              `${profile.name} verification stroke`,
              async () => {
                const before = await visualAt(page, path.first.x, path.first.y);
                await drawStroke(context, page, profile, path);
                const after = await visualAt(page, path.first.x, path.first.y);
                return [before, after] as const;
              },
            );
            if (after.equals(before))
              throw new Error(
                `${profile.name} stroke did not change the displayed pixels at ${path.first.x.toFixed(1)},${path.first.y.toFixed(1)}`,
              );
            await page.keyboard.press('Meta+z');
            await afterPaint(page);
          }
          if (errors.length) throw new Error(errors.join(', '));
          const app = summarizeBlocks(blocks, mainThreadTargetMs[profile.name][scenario]);
          const control = summarizeBlocks(
            controlBlocks,
            mainThreadTargetMs[profile.name][scenario],
          );
          const invalidBlocks = cadences.flatMap((cadence, index) =>
            cadence.valid ? [] : [index + 1],
          );
          const invalidControlBlocks = controlCadences.flatMap((cadence, index) =>
            cadence.valid ? [] : [index + 1],
          );
          const gates = editorGateVerdict({
            appMainPassed: app.mainPassed,
            appFramesPassed: app.framesPassed,
            appCadenceValid: invalidBlocks.length === 0,
            controlPassed: control.passed,
            controlCadenceValid: invalidControlBlocks.length === 0,
          });
          const { verdict } = gates;
          if (verdict !== 'PASS' && process.env.PIXELS_PERF_TRACE_DIR) {
            const worstBlock = blocks.reduce(
              (worst, block, index) =>
                block.eligibleFrames - block.onTimeFrames >
                blocks[worst]!.eligibleFrames - blocks[worst]!.onTimeFrames
                  ? index
                  : worst,
              0,
            );
            const directory = process.env.PIXELS_PERF_TRACE_DIR;
            await mkdir(directory, { recursive: true });
            const path = join(
              directory,
              `${profile.name}-${scenario}-${run + 1}-block-${worstBlock + 1}.json.gz`,
            );
            await Bun.write(path, gzipSync(JSON.stringify(retainedTraces[worstBlock])));
            console.log(`Failed frame trace: ${path}`);
            if (gates.frames === 'INVALID') {
              const worstControlBlock = controlBlocks.reduce(
                (worst, block, index) =>
                  block.eligibleFrames - block.onTimeFrames >
                  controlBlocks[worst]!.eligibleFrames - controlBlocks[worst]!.onTimeFrames
                    ? index
                    : worst,
                0,
              );
              const controlPath = join(
                directory,
                `${profile.name}-${scenario}-${run + 1}-control-${worstControlBlock + 1}.json.gz`,
              );
              await Bun.write(
                controlPath,
                gzipSync(JSON.stringify(controlTraces[worstControlBlock])),
              );
              console.log(`Control frame trace: ${controlPath}`);
            }
          }
          if (verdict !== 'PASS') failed = true;
          console.log(
            `${verdict} real editor ${profile.name} ${profile.width}×${profile.height} @ ${profile.dpr}× ${scenario} ${run + 1}/${repeat}: main gate ${gates.main}, frame gate ${gates.frames}; ${invalidBlocks.length ? `app driver missed input cadence in block(s) ${invalidBlocks.join(', ')}; ` : ''}${invalidControlBlocks.length ? `control driver missed input cadence in block(s) ${invalidControlBlocks.join(', ')}; ` : ''}${app.details}; control ${control.details}, loadavg ${loadavg()
              .map((value) => value.toFixed(2))
              .join('/')}`,
          );
        }
      } finally {
        await context.close();
      }
    }
  }
  return !failed || calibrate;
}
