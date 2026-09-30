import { chromium } from 'playwright';
import { runAppPerf } from './app';

const index = process.argv.indexOf('--repeat');
const repeat = index < 0 ? 1 : Number(process.argv[index + 1]);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new RangeError('--repeat must be 1 to 20');
const headless = process.argv.includes('--headless');
const injectIndex = process.argv.indexOf('--inject-stroke-ms');
const injectStrokeMs = injectIndex < 0 ? 0 : Number(process.argv[injectIndex + 1]);
if (!Number.isFinite(injectStrokeMs) || injectStrokeMs < 0 || injectStrokeMs > 20)
  throw new RangeError('--inject-stroke-ms must be 0 to 20');
const browser = await chromium.launch({ headless });
try {
  const passed = await runAppPerf(
    browser,
    repeat,
    process.argv.includes('--calibrate'),
    injectStrokeMs,
    !process.argv.includes('--unconditioned'),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
