import { loadavg } from 'node:os';
import type { Browser, BrowserContext, Page } from 'playwright';
import { captureTrace } from './capture';
import type { TraceSummary } from './trace';

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
  });
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
  await page.getByRole('button', { name: profile.name === 'phone' ? '25%' : '50%' }).waitFor();
  await afterPaint(page);
  for (let step = 0; step < 12; step++) {
    if ((await page.getByRole('button', { name: '8×' }).count()) > 0) break;
    if (profile.name === 'phone') await page.keyboard.press('Equal');
    else await page.getByRole('button', { name: 'Zoom in' }).click();
  }
  if ((await page.getByRole('button', { name: '8×' }).count()) === 0)
    throw new Error('Editor zoom did not become 8×');
  await page.waitForTimeout(200);
  if ((await page.getByRole('button', { name: '8×' }).count()) === 0)
    throw new Error(
      `Editor zoom reverted after document navigation: ${(await page.getByRole('button').allTextContents()).slice(0, 6).join(', ')}`,
    );
  const slider = page.getByRole('slider', { name: 'Brush size' });
  for (let i = 0; i < 32 && (await slider.getAttribute('aria-valuetext')) !== '16 px'; i++) {
    await slider.focus();
    await slider.press('ArrowRight');
  }
  const brush = await slider.getAttribute('aria-valuetext');
  if (brush !== '16 px') throw new Error(`Brush size did not become 16 px: ${brush}`);
  await page.getByRole('application', { name: 'Canvas' }).focus();
  await afterPaint(page);
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
      for (let sample = 1; sample < 120; sample++) {
        await Bun.sleep(8);
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ id: 1, ...point(sample) }],
        });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else {
    await markFirstInput?.();
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (let sample = 1; sample < 120; sample++) {
      await Bun.sleep(8);
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
      for (let frame = 1; frame <= 90; frame++) {
        await Bun.sleep(16);
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
    for (let frame = 1; frame <= 90; frame++) {
      await Bun.sleep(16);
      const phase = (frame / 90) * Math.PI * 2;
      await page.mouse.move(x + 100 * Math.sin(phase), y + 60 * (Math.cos(phase) - 1));
    }
    await page.mouse.up({ button: 'middle' });
  }
  await afterPaint(page);
}

function summarizeBlocks(
  blocks: TraceSummary[],
  target: number,
): {
  passed: boolean;
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
  return {
    passed:
      mainP95 < target &&
      maxMainTask <= 50 &&
      onTimePercent >= 99 &&
      !consecutiveDrops &&
      eligible >= 90,
    details: `main p95 ${mainP95.toFixed(3)} ms [${blocks.map((block) => block.mainP95Ms.toFixed(3)).join(', ')}], aggregate pipeline CPU p95 ${pipelineP95.toFixed(3)} ms (diagnostic), max main task ${maxMainTask.toFixed(3)} ms, on-time ${onTime}/${eligible} (${onTimePercent.toFixed(2)}%, dropped ${dropped}, high latency ${highLatency}, consecutive drops ${consecutiveDrops}, states ${JSON.stringify(Object.fromEntries(states))}), refresh ${refreshHz.toFixed(2)} Hz, frames [${frames.join(', ')}], target main < ${target} ms and on-time ≥ 99%`,
  };
}

export async function runEditorInput(
  browser: Browser,
  baseUrl: string,
  repeat: number,
  calibrate: boolean,
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
        await prepareDocument(page, baseUrl, profile, run);
        for (const scenario of ['stroke', 'pan'] as const) {
          const blocks: TraceSummary[] = [];
          for (let block = 0; block < 3; block++) {
            if (scenario === 'stroke') {
              const path = await strokePath(page, profile);
              const summary = await captureTrace(context, page, (markFirstInput) =>
                drawStroke(context, page, profile, path, markFirstInput),
              );
              blocks.push(summary);
              console.log(
                `stroke block ${profile.name} ${run + 1}/${repeat} ${block + 1}/3: on-time ${summary.onTimeFrames}/${summary.eligibleFrames}, states ${JSON.stringify(summary.presentationStates)}, misses ${JSON.stringify(summary.missedFrameRuns)}, before input ${JSON.stringify(summary.preInputMisses)}, main p95 ${summary.mainP95Ms.toFixed(3)} ms, pipeline p95 ${summary.pipelineP95Ms.toFixed(3)} ms, stages ${JSON.stringify(summary.stageP95Ms)}, loadavg ${loadavg()
                  .map((value) => value.toFixed(2))
                  .join('/')}`,
              );
              await page.keyboard.press('Meta+z');
              await afterPaint(page);
            } else {
              blocks.push(
                await captureTrace(context, page, (markFirstInput) =>
                  panZoom(context, page, profile, markFirstInput),
                ),
              );
            }
          }
          if (scenario === 'stroke') {
            // Verify the same real input path after tracing. Screenshot capture
            // never changes the app's 2D canvas readback mode during a block.
            const path = await strokePath(page, profile);
            const before = await visualAt(page, path.first.x, path.first.y);
            await drawStroke(context, page, profile, path);
            const after = await visualAt(page, path.first.x, path.first.y);
            if (after.equals(before))
              throw new Error(
                `${profile.name} stroke did not change the displayed pixels at ${path.first.x.toFixed(1)},${path.first.y.toFixed(1)}`,
              );
            await page.keyboard.press('Meta+z');
            await afterPaint(page);
          }
          if (errors.length) throw new Error(errors.join(', '));
          const { passed, details } = summarizeBlocks(blocks, scenario === 'stroke' ? 4 : 3);
          if (!passed) failed = true;
          console.log(
            `${passed ? 'PASS' : 'FAIL'} real editor ${profile.name} ${profile.width}×${profile.height} @ ${profile.dpr}× ${scenario} ${run + 1}/${repeat}: ${details}, loadavg ${loadavg()
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
