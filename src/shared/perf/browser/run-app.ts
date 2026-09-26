import { chromium } from 'playwright';
import { runAppPerf } from './app';

const index = process.argv.indexOf('--repeat');
const repeat = index < 0 ? 1 : Number(process.argv[index + 1]);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new RangeError('--repeat must be 1 to 20');
const headless = process.argv.includes('--headless');
const browser = await chromium.launch({ headless });
try {
  if (!(await runAppPerf(browser, repeat, process.argv.includes('--calibrate'))))
    process.exitCode = 1;
} finally {
  await browser.close();
}
