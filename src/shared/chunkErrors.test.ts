import { expect, spyOn, test } from 'bun:test';
import {
  isLoadFailure,
  onInterruption,
  reloadPixels,
  reportLoadFailure,
  reportUpdate,
  saveBeforeReload,
  workerError,
} from './chunkErrors';
import type { Interruption } from './chunkErrors';

test('reports reach every listener until it unsubscribes', () => {
  const seen: Interruption[] = [];
  const stop = onInterruption((interruption) => seen.push(interruption));
  const error = new TypeError('Failed to fetch dynamically imported module: /assets/x.js');
  reportLoadFailure(error);
  stop();
  const log = spyOn(console, 'error').mockImplementation(() => {});
  reportLoadFailure(error);
  expect(seen).toEqual([{ kind: 'failed', error }]);
  expect(log).toHaveBeenCalledWith({ kind: 'failed', error });
  log.mockRestore();
});

test('recognizes each engine’s failed module load', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://x/assets/a.js',
    'error loading dynamically imported module: https://x/assets/a.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/a.css',
  ])
    expect(isLoadFailure(new TypeError(message))).toBe(true);
  expect(isLoadFailure(new Error('Cannot read properties of undefined'))).toBe(false);
  expect(isLoadFailure('Failed to fetch dynamically imported module')).toBe(false);
});

test('a worker that never loaded is a load failure, and one that threw is not', () => {
  expect(isLoadFailure(workerError(new Event('error')))).toBe(true);
  const threw = Object.assign(new Event('error'), { message: 'Uncaught RangeError: too big' });
  expect(workerError(threw).message).toBe('Uncaught RangeError: too big');
  expect(isLoadFailure(workerError(threw))).toBe(false);
});

test('Reload stores every edit before it reloads, and never leaves while Pixels is unreachable', async () => {
  const fetch = spyOn(globalThis, 'fetch');
  const steps: string[] = [];
  const stop = saveBeforeReload(async () => void steps.push('save'));
  const location = { reload: () => void steps.push('reload') };
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true });

  fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  expect(await reloadPixels()).toBe(false);
  fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
  expect(await reloadPixels()).toBe(false);
  expect(steps).toEqual([]);

  fetch.mockResolvedValueOnce(new Response(''));
  expect(await reloadPixels()).toBe(true);
  expect(steps).toEqual(['save', 'reload']);
  expect(fetch.mock.calls.at(-1)?.[1]).toEqual({ cache: 'no-store' });

  // An update's worker already holds the new version, so it activates even offline.
  fetch.mockClear();
  expect(await reloadPixels(() => void steps.push('activate'))).toBe(true);
  expect(steps).toEqual(['save', 'reload', 'save', 'activate']);
  expect(fetch).not.toHaveBeenCalled();

  stop();
  saveBeforeReload(() => Promise.reject(new Error('QuotaExceededError')));
  fetch.mockResolvedValueOnce(new Response(''));
  await expect(reloadPixels()).rejects.toThrow('QuotaExceededError');
  expect(steps).toEqual(['save', 'reload', 'save', 'activate']);
  fetch.mockRestore();
  Reflect.deleteProperty(globalThis, 'location');
});

test('an update waits for an editor that subscribes later', () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const activate = () => {};
  reportUpdate(activate);
  log.mockRestore();
  const seen: Interruption[] = [];
  onInterruption((interruption) => seen.push(interruption))();
  expect(seen).toEqual([{ kind: 'updated', activate }]);
});
