import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright';

const execFileAsync = promisify(execFile);
const requiredIdleNs = 60_000_000_000n;

async function macHidIdleNs(): Promise<bigint | null> {
  if (process.platform !== 'darwin') return null;
  const { stdout } = await execFileAsync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], {
    maxBuffer: 1024 * 1024,
  });
  const match = /"HIDIdleTime" = (\d+)/.exec(stdout);
  if (!match) throw new Error('Could not read macOS HIDIdleTime');
  return BigInt(match[1]!);
}

/** Read the OS HID clock outside Chrome traces. A physical key, mouse, or trackpad
 * action resets it; CDP input and Chrome's synthetic window-enter move do not. */
export async function withIdleMacInput<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const before = await macHidIdleNs();
  if (before !== null && before < requiredIdleNs)
    throw new Error(
      `${phase}: Mac HID idle ${(Number(before) / 1e9).toFixed(1)} s, need at least 60 s before measuring`,
    );
  let result!: T;
  let failure: unknown;
  let failed = false;
  try {
    result = await work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const after = await macHidIdleNs();
  if (before !== null && after !== null && after < before)
    throw new Error(
      `${phase}: Mac HID activity during measurement (idle ${(Number(before) / 1e9).toFixed(1)} → ${(Number(after) / 1e9).toFixed(1)} s)`,
      { cause: failure },
    );
  if (failed) throw failure;
  return result;
}

export async function withVisibleIdleMacInput<T>(
  page: Page,
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  return withIdleMacInput(phase, async () => {
    if ((await page.evaluate(() => document.visibilityState)) !== 'visible')
      throw new Error(`${phase}: Chrome page was hidden before measurement`);
    const result = await work();
    if ((await page.evaluate(() => document.visibilityState)) !== 'visible')
      throw new Error(`${phase}: Chrome page was hidden after measurement`);
    return result;
  });
}
