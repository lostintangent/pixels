import { expect, spyOn, test } from 'bun:test';
import { isLoadFailure, onLoadFailure, reportLoadFailure } from './chunkErrors';

test('reports reach every listener until it unsubscribes', () => {
  const seen: unknown[] = [];
  const stop = onLoadFailure((error) => seen.push(error));
  const error = new TypeError('Failed to fetch dynamically imported module: /assets/x.js');
  reportLoadFailure(error);
  stop();
  const log = spyOn(console, 'error').mockImplementation(() => {});
  reportLoadFailure(error);
  expect(seen).toEqual([error]);
  expect(log).toHaveBeenCalledWith(error);
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
