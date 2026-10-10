import { expect, test } from 'bun:test';
import { watchPixelDensity } from './density';

test('a window moving between displays reports each density even without a CSS resize', () => {
  const queries: { text: string; listeners: Set<() => void> }[] = [];
  const source = {
    devicePixelRatio: 1,
    matchMedia(text: string) {
      const query = { text, listeners: new Set<() => void>() };
      queries.push(query);
      return {
        addEventListener(_type: 'change', listener: () => void) {
          query.listeners.add(listener);
        },
        removeEventListener(_type: 'change', listener: () => void) {
          query.listeners.delete(listener);
        },
      };
    },
  };
  const densities: number[] = [];
  const stop = watchPixelDensity(source, () => densities.push(source.devicePixelRatio));
  expect(queries[0]?.text).toBe('(resolution: 1dppx)');

  source.devicePixelRatio = 2;
  for (const listener of queries[0]!.listeners) listener();
  expect(queries[0]?.listeners.size).toBe(0);
  expect(queries[1]?.text).toBe('(resolution: 2dppx)');

  source.devicePixelRatio = 1;
  for (const listener of queries[1]!.listeners) listener();
  expect(queries[2]?.text).toBe('(resolution: 1dppx)');
  expect(densities).toEqual([2, 1]);

  stop();
  expect(queries[2]?.listeners.size).toBe(0);
});
